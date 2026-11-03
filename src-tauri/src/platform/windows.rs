//! Windows: the IP helper table finds listeners, `sysinfo` identifies and measures processes,
//! and End task ends them at once. Windows has no reliable way to ask a console server
//! (Node, Python, …) to shut down cleanly, so there is no separate force option.
use crate::scanner::{Identity, Listener, ProcessDetails, RawProcess};
use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, Uid, UpdateKind};

/// Reads only the given processes, and only what `kind` asks for.
fn load(pids: &[i32], kind: ProcessRefreshKind) -> System {
    let pids = pids
        .iter()
        .filter(|pid| **pid > 0)
        .map(|pid| Pid::from_u32(*pid as u32))
        .collect::<Vec<_>>();
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);
    system
}

fn pid(pid: i32) -> Pid {
    Pid::from_u32(pid as u32)
}

fn current_user() -> Option<&'static Uid> {
    static USER: OnceLock<Option<Uid>> = OnceLock::new();
    USER.get_or_init(|| {
        let own = std::process::id() as i32;
        load(
            &[own],
            ProcessRefreshKind::nothing().with_user(UpdateKind::Always),
        )
        .process(pid(own))?
        .user_id()
        .cloned()
    })
    .as_ref()
}

/// Every listening TCP process. Ownership is checked later, by `identity`.
pub fn listeners() -> Result<Vec<RawProcess>, String> {
    let sockets = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP,
    )
    .map_err(|e| format!("Could not read listening ports: {e}"))?;
    let mut by_pid: HashMap<i32, BTreeSet<Listener>> = HashMap::new();
    for socket in sockets {
        let ProtocolSocketInfo::Tcp(tcp) = socket.protocol_socket_info else {
            continue;
        };
        if tcp.state != TcpState::Listen {
            continue;
        }
        for owner in socket.associated_pids {
            by_pid.entry(owner as i32).or_default().insert(Listener {
                port: tcp.local_port,
                address: tcp.local_addr.to_string(),
            });
        }
    }
    let pids = by_pid.keys().copied().collect::<Vec<_>>();
    let system = load(&pids, ProcessRefreshKind::nothing());
    Ok(by_pid
        .into_iter()
        .map(|(id, listeners)| {
            let name = system
                .process(pid(id))
                .map(|process| process.name().to_string_lossy().into_owned())
                .unwrap_or_default();
            // `node.exe` → `node`, so names match the other platforms.
            let name = Path::new(&name)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or(name);
            RawProcess {
                pid: id,
                name,
                listeners,
            }
        })
        .collect())
}

/// Anything inside the Windows folder, plus PortKiller itself.
pub fn system_executable(executable: &str) -> bool {
    let path = executable.to_ascii_lowercase();
    let root = std::env::var("SystemRoot")
        .unwrap_or_else(|_| r"C:\Windows".into())
        .to_ascii_lowercase();
    path.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
        || path.ends_with(r"\portkiller.exe")
}

pub fn identity(id: i32) -> Result<Identity, String> {
    // PID 0 is the idle process and 4 is the kernel ("System").
    if id <= 4 || id == std::process::id() as i32 {
        return Err("This process is protected".into());
    }
    let system = load(
        &[id],
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::Always)
            .with_user(UpdateKind::Always),
    );
    let process = system.process(pid(id)).ok_or("The process has exited")?;
    match (process.user_id(), current_user()) {
        (Some(owner), Some(user)) if owner == user => {}
        _ => return Err("Only your own processes can be managed".into()),
    }
    let executable = process
        .exe()
        .ok_or("Process executable is unavailable")?
        .to_string_lossy()
        .into_owned();
    if system_executable(&executable) {
        return Err("System services are protected".into());
    }
    Ok(Identity {
        token: format!("{id}:{}", process.start_time()),
        executable,
        started_at: process.start_time(),
    })
}

/// Working set in bytes and total CPU time in nanoseconds.
pub fn resources(id: i32) -> (Option<u64>, Option<u64>) {
    let system = load(
        &[id],
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );
    match system.process(pid(id)) {
        Some(process) => (
            Some(process.memory()),
            Some(process.accumulated_cpu_time().saturating_mul(1_000_000)),
        ),
        None => (None, None),
    }
}

pub fn read_details(pids: &[i32]) -> HashMap<i32, ProcessDetails> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let system = load(
        pids,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always)
            .with_exe(UpdateKind::Always),
    );
    pids.iter()
        .filter_map(|&id| {
            let process = system.process(pid(id))?;
            let mut command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            if command.is_empty() {
                command = process
                    .exe()
                    .map(|exe| exe.to_string_lossy().into_owned())
                    .unwrap_or_default();
            }
            let cwd = process.cwd().map(|cwd| cwd.to_string_lossy().into_owned());
            Some((id, ProcessDetails { command, cwd }))
        })
        .collect()
}

/// Ends the process at once (`taskkill /F`, without a console window).
pub fn signal(id: i32, _force: bool) -> Result<(), String> {
    if id <= 4 {
        return Err("This process is protected".into());
    }
    let system = load(&[id], ProcessRefreshKind::nothing());
    let process = system.process(pid(id)).ok_or("The process has exited")?;
    if process.kill_with(Signal::Kill).unwrap_or(false) {
        Ok(())
    } else {
        Err("Could not end the process. It may belong to an administrator.".into())
    }
}

/// Icons for Windows apps are not read yet; every row shows its runtime glyph.
pub fn icon_source(_executable: &str) -> Option<String> {
    None
}

pub fn icon_png(_source: &str, _size: isize) -> Option<Vec<u8>> {
    None
}

/// Opens a URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
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
    fn system_filter_covers_the_windows_folder_only() {
        assert!(system_executable(r"C:\Windows\System32\svchost.exe"));
        assert!(system_executable(r"c:\windows\system32\spoolsv.exe"));
        assert!(!system_executable(r"C:\Program Files\nodejs\node.exe"));
        assert!(!system_executable(
            r"C:\Users\me\AppData\Local\Programs\Python\Python312\python.exe"
        ));
    }

    #[test]
    fn listeners_include_this_process_which_is_protected() {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        let own = std::process::id() as i32;
        assert!(listeners().unwrap().iter().any(|process| {
            process.pid == own
                && process
                    .listeners
                    .iter()
                    .any(|listener| listener.port == port)
        }));
        assert!(identity(own).is_err());
        assert!(signal(4, true).is_err());
    }
}
