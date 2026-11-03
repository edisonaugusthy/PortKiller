//! macOS: `lsof` finds listeners, `libproc` identifies and measures processes, signals stop them.
use crate::scanner::{Identity, Listener, ProcessDetails, RawProcess};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Bounded subprocesses, no shell interpolation. Only used while the popover is open.
fn command_output(program: &str, args: &[&str]) -> Result<(bool, String), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not run {program}: {e}"))?;
    let stdout = child.stdout.take().ok_or("Could not read process output")?;
    let reader = std::thread::spawn(move || {
        let mut data = Vec::new();
        stdout
            .take(2 * 1024 * 1024)
            .read_to_end(&mut data)
            .map(|_| data)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(match result {
                    Err(e) => format!("Could not inspect processes: {e}"),
                    _ => "Process scan timed out. Try refreshing.".into(),
                });
            }
        }
    };
    let data = reader
        .join()
        .map_err(|_| "Process output reader failed")?
        .map_err(|e| e.to_string())?;
    if data.len() >= 2 * 1024 * 1024 {
        return Err("Process output exceeded the scan limit".into());
    }
    Ok((
        status.success(),
        String::from_utf8_lossy(&data).into_owned(),
    ))
}

fn parse_listeners(output: &str, uid: u32) -> Vec<RawProcess> {
    let mut processes = Vec::new();
    let mut current = RawProcess::default();
    let mut owner = None;
    for line in output.lines().filter(|line| !line.is_empty()) {
        let Some(value) = line.get(1..) else { continue };
        let tag = &line[..1];
        match tag {
            "p" => {
                if current.pid > 0 && !current.listeners.is_empty() && owner == Some(uid) {
                    processes.push(current);
                }
                owner = None;
                current = RawProcess {
                    pid: value.parse().unwrap_or(0),
                    ..Default::default()
                };
            }
            "c" => current.name = value.to_string(),
            "u" => owner = value.parse().ok(),
            "n" => {
                if let Some((address, port)) = value.rsplit_once(':') {
                    if let Ok(port) = port.parse::<u16>() {
                        current.listeners.insert(Listener {
                            port,
                            address: address.trim_matches(['[', ']']).to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    if current.pid > 0 && !current.listeners.is_empty() && owner == Some(uid) {
        processes.push(current);
    }
    processes
}

fn current_uid() -> u32 {
    // getuid has no arguments or pointer preconditions.
    unsafe { libc::getuid() }
}

/// The current user's listening TCP processes.
pub fn listeners() -> Result<Vec<RawProcess>, String> {
    let uid = current_uid().to_string();
    let (success, output) = command_output(
        "/usr/sbin/lsof",
        &[
            "-nP",
            "-w",
            "-a",
            "-u",
            &uid,
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fpcun",
        ],
    )?;
    // lsof returns 1 for an empty selection, including when no servers are running.
    if !success && !output.is_empty() {
        return Err("Could not read listening ports".into());
    }
    Ok(parse_listeners(&output, current_uid()))
}

pub fn system_executable(executable: &str) -> bool {
    executable.starts_with("/System/")
        || executable.starts_with("/usr/libexec/")
        || executable.starts_with("/usr/sbin/")
        || executable.starts_with("/sbin/")
        || executable.contains("/PortKiller.app/")
}

pub fn identity(pid: i32) -> Result<Identity, String> {
    use libproc::{
        bsd_info::BSDInfo,
        proc_pid::{pidinfo, pidpath},
    };
    if pid <= 1 || pid == std::process::id() as i32 {
        return Err("This process is protected".into());
    }
    let info = pidinfo::<BSDInfo>(pid, 0).map_err(|_| "The process has exited")?;
    if info.pbi_uid != current_uid() || info.pbi_ruid != current_uid() {
        return Err("Only your own processes can be managed".into());
    }
    let executable = pidpath(pid).map_err(|_| "Process executable is unavailable")?;
    if system_executable(&executable) {
        return Err("System services are protected".into());
    }
    Ok(Identity {
        token: format!("{pid}:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        executable,
        started_at: info.pbi_start_tvsec,
    })
}

fn ticks_to_ns(ticks: u64) -> u64 {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    static RATIO: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
    let (numer, denom) = *RATIO.get_or_init(|| {
        let mut info = Timebase { numer: 1, denom: 1 };
        // Writes two integers into a valid, exclusively borrowed struct.
        if unsafe { mach_timebase_info(&mut info) } != 0 || info.denom == 0 {
            return (1, 1);
        }
        (u64::from(info.numer), u64::from(info.denom))
    });
    (u128::from(ticks) * u128::from(numer) / u128::from(denom)) as u64
}

/// Resident memory in bytes and total CPU time in nanoseconds.
pub fn resources(pid: i32) -> (Option<u64>, Option<u64>) {
    use libproc::{proc_pid::pidinfo, task_info::TaskInfo};
    match pidinfo::<TaskInfo>(pid, 0) {
        // Task CPU times are Mach absolute ticks, which are not nanoseconds on Apple Silicon.
        Ok(info) => (
            Some(info.pti_resident_size),
            Some(ticks_to_ns(
                info.pti_total_user.saturating_add(info.pti_total_system),
            )),
        ),
        Err(_) => (None, None),
    }
}

pub fn read_details(pids: &[i32]) -> HashMap<i32, ProcessDetails> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let selection = pids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut details = HashMap::new();
    if let Ok((_, output)) = command_output(
        "/bin/ps",
        &["-ww", "-p", &selection, "-o", "pid=", "-o", "command="],
    ) {
        for line in output.lines() {
            let line = line.trim_start();
            if let Some((pid, command)) = line.split_once(char::is_whitespace) {
                if let Ok(pid) = pid.parse::<i32>() {
                    details.insert(
                        pid,
                        ProcessDetails {
                            command: command.trim().to_string(),
                            cwd: None,
                        },
                    );
                }
            }
        }
    }
    if let Ok((_, output)) = command_output(
        "/usr/sbin/lsof",
        &["-nP", "-w", "-a", "-p", &selection, "-d", "cwd", "-Fpn"],
    ) {
        let mut pid = 0;
        for line in output.lines() {
            if let Some(value) = line.strip_prefix('p') {
                pid = value.parse().unwrap_or(0);
            } else if let Some(path) = line.strip_prefix('n') {
                if let Some(info) = details.get_mut(&pid) {
                    info.cwd = Some(path.to_string());
                }
            }
        }
    }
    details
}

/// `SIGTERM`, or `SIGKILL` when forced. Never signals a process group.
pub fn signal(pid: i32, force: bool) -> Result<(), String> {
    if pid <= 1 {
        return Err("This process is protected".into());
    }
    // A single positive PID; the caller has validated its owner, start time and ports.
    let result = unsafe { libc::kill(pid, if force { libc::SIGKILL } else { libc::SIGTERM }) };
    if result != 0 {
        return Err(format!(
            "Could not stop process: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// The `.app` bundle that contains an executable, whose icon the menu shows.
pub fn icon_source(executable: &str) -> Option<String> {
    executable
        .find(".app/Contents/")
        .map(|end| executable[..end + 4].to_string())
}

/// Draws the Finder icon of an `.app` bundle into a square bitmap and encodes it as PNG.
/// Call on the main thread, as AppKit expects.
pub fn icon_png(bundle: &str, size: isize) -> Option<Vec<u8>> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext,
        NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};
    let path = std::path::Path::new(bundle);
    if bundle.len() > 4096 || !path.is_absolute() || !bundle.ends_with(".app") || !path.is_dir() {
        return None;
    }
    let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(bundle));
    // SAFETY: null planes ask AppKit to allocate the pixel buffer.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            size,
            size,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    let side = size as f64;
    image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side)));
    NSGraphicsContext::restoreGraphicsState_class();
    // SAFETY: an empty property dictionary is valid for PNG.
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(data.to_vec())
}

/// Opens a URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_parser_keeps_ipv6_and_deduplicates_sockets() {
        let parsed = parse_listeners("p42\ncnode\nu501\nf1\nn127.0.0.1:3000\nf2\nn[::1]:3000\nf3\nn127.0.0.1:3000\np43\ncpython\nu501\nn*:8000\np44\ncother\nu502\nn*:9000\n", 501);
        assert_eq!(parsed.len(), 2, "other users' processes are dropped");
        assert_eq!(parsed[0].listeners.len(), 2);
        assert!(parsed[0].listeners.contains(&Listener {
            port: 3000,
            address: "::1".into()
        }));
        assert_eq!(parsed[1].listeners.first().unwrap().port, 8000);
    }

    #[test]
    fn system_filter_does_not_hide_development_interpreters() {
        assert!(system_executable(
            "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"
        ));
        assert!(system_executable("/usr/libexec/rapportd"));
        assert!(!system_executable("/usr/bin/python3"));
        assert!(!system_executable("/opt/homebrew/bin/node"));
    }

    #[test]
    fn cpu_ticks_convert_to_nanoseconds() {
        // One second of CPU time must read as roughly one second, whatever the Mach timebase.
        let busy = Instant::now();
        while busy.elapsed() < Duration::from_millis(300) {
            std::hint::black_box(busy.elapsed());
        }
        let (_, total) = resources(std::process::id() as i32);
        let total = Duration::from_nanos(total.unwrap());
        assert!(total >= Duration::from_millis(250), "{total:?}");
        assert!(total < Duration::from_secs(600), "{total:?}");
    }

    #[test]
    fn icon_source_finds_the_enclosing_app() {
        assert_eq!(
            icon_source("/Applications/Docker.app/Contents/MacOS/com.docker.backend").as_deref(),
            Some("/Applications/Docker.app")
        );
        assert_eq!(icon_source("/opt/homebrew/bin/node"), None);
    }

    #[test]
    fn app_icons_render_as_png() {
        let png = icon_png("/System/Applications/Calculator.app", 52).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        assert!(icon_png("/usr/bin/true", 52).is_none());
        assert!(icon_png("relative.app", 52).is_none());
    }
}
