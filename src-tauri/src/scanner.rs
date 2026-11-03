use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// A process that used under this share of one core between scans counts as quiet.
const ACTIVE_CPU_SHARE: f64 = 0.01;
/// First sighting: a process at least this old that averaged under 0.1% CPU is idle since start.
const QUIET_SINCE_START: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
pub struct Listener {
    pub port: u16,
    pub address: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProcess {
    pub pid: i32,
    pub identity: String,
    pub name: String,
    pub app: String,
    pub project: String,
    pub executable: String,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub started_at: u64,
    pub idle_seconds: Option<u64>,
    pub listeners: Vec<Listener>,
    /// The enclosing `.app` bundle, whose icon the menu shows.
    pub bundle: Option<String>,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub processes: Vec<PortProcess>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProcessDetails {
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Default)]
pub struct Scanner {
    cache: HashMap<String, ProcessDetails>,
    cpu: HashMap<String, (Instant, u64)>,
    activity: HashMap<String, Activity>,
}

/// Kept while the menu is closed so idle time spans openings. Updated only by scans.
struct Activity {
    cpu_ns: u64,
    at: SystemTime,
    last_active: SystemTime,
}

#[derive(Default, Debug)]
struct RawProcess {
    pid: i32,
    name: String,
    uid: Option<u32>,
    listeners: BTreeSet<Listener>,
}

#[derive(Debug)]
struct Identity {
    token: String,
    executable: String,
    started_at: u64,
}

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

fn parse_listeners(output: &str) -> Vec<RawProcess> {
    let mut processes = Vec::new();
    let mut current = RawProcess::default();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let Some(value) = line.get(1..) else { continue };
        let tag = &line[..1];
        match tag {
            "p" => {
                if current.pid > 0 && !current.listeners.is_empty() {
                    processes.push(current);
                }
                current = RawProcess {
                    pid: value.parse().unwrap_or(0),
                    ..Default::default()
                };
            }
            "c" => current.name = value.to_string(),
            "u" => current.uid = value.parse().ok(),
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
    if current.pid > 0 && !current.listeners.is_empty() {
        processes.push(current);
    }
    processes
}

fn current_uid() -> u32 {
    // getuid has no arguments or pointer preconditions.
    unsafe { libc::getuid() }
}

fn listeners() -> Result<Vec<RawProcess>, String> {
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
    Ok(parse_listeners(&output))
}

fn system_executable(executable: &str) -> bool {
    executable.starts_with("/System/")
        || executable.starts_with("/usr/libexec/")
        || executable.starts_with("/usr/sbin/")
        || executable.starts_with("/sbin/")
        || executable.contains("/PortKiller.app/")
}

#[cfg(target_os = "macos")]
fn identity(pid: i32) -> Result<Identity, String> {
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

#[cfg(not(target_os = "macos"))]
fn identity(_pid: i32) -> Result<Identity, String> {
    Err("PortKiller requires macOS".into())
}

#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
fn resources(pid: i32) -> (Option<u64>, Option<u64>) {
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

#[cfg(not(target_os = "macos"))]
fn resources(_pid: i32) -> (Option<u64>, Option<u64>) {
    (None, None)
}

fn read_details(pids: &[i32]) -> HashMap<i32, ProcessDetails> {
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

fn display_name(name: &str, command: &str) -> String {
    let command = command.to_lowercase();
    if command.contains("next/dist/") || command.contains("next-server") {
        return "Next.js".into();
    }
    if command.contains("vite/") || command.contains("vite.js") || command.contains(".bin/vite") {
        return "Vite".into();
    }
    if command.contains("uvicorn") {
        return "Uvicorn".into();
    }
    if command.contains("webpack") {
        return "Webpack".into();
    }
    if command.contains("storybook") {
        return "Storybook".into();
    }
    if command.contains("rails") || command.contains("puma") {
        return "Rails".into();
    }
    if command.contains("docker") || name.starts_with("com.docker") {
        return "Docker".into();
    }
    if command.contains("manage.py") {
        return "Django".into();
    }
    if name.starts_with("postgres") {
        return "PostgreSQL".into();
    }
    if name.starts_with("python") {
        return "Python".into();
    }
    if name.starts_with("node") || name == "bun" || name == "deno" {
        return name.to_string();
    }
    if name.starts_with("redis") {
        return "Redis".into();
    }
    name.to_string()
}

/// `/Applications/Docker.app/Contents/MacOS/x` → `/Applications/Docker.app`.
fn bundle_path(executable: &str) -> Option<String> {
    executable
        .find(".app/Contents/")
        .map(|end| executable[..end + 4].to_string())
}

fn project_name(cwd: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return "local".into();
    };
    let path = Path::new(cwd);
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return "local".into();
    };
    if name.starts_with("postgresql") || name == "redis" {
        return "local".into();
    }
    if matches!(name, "api" | "server" | "backend") {
        if let Some(parent) = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        {
            return format!("{parent}/{name}");
        }
    }
    name.to_string()
}

impl Scanner {
    pub fn scan(&mut self) -> Result<Snapshot, String> {
        let candidates = listeners()?
            .into_iter()
            .filter_map(|process| {
                if process.uid != Some(current_uid()) {
                    return None;
                }
                let identity = identity(process.pid).ok()?;
                Some((process, identity))
            })
            .collect::<Vec<_>>();
        let new_pids = candidates
            .iter()
            .filter(|(_, id)| !self.cache.contains_key(&id.token))
            .map(|(process, _)| process.pid)
            .collect::<Vec<_>>();
        let mut metadata = read_details(&new_pids);
        let now = Instant::now();
        let wall = SystemTime::now();
        let mut processes = Vec::new();
        for (process, id) in candidates {
            // Recheck after subprocess metadata collection; do not cache a recycled PID.
            if !identity(process.pid).is_ok_and(|current| current.token == id.token) {
                continue;
            }
            let info = self.cache.entry(id.token.clone()).or_insert_with(|| {
                metadata.remove(&process.pid).unwrap_or(ProcessDetails {
                    command: id.executable.clone(),
                    cwd: None,
                })
            });
            let (memory_bytes, total_cpu) = resources(process.pid);
            let cpu_percent = total_cpu.and_then(|total| {
                let previous = self.cpu.insert(id.token.clone(), (now, total));
                previous.and_then(|(when, before)| {
                    let elapsed = now.duration_since(when).as_nanos() as f64;
                    (elapsed > 0.0).then(|| total.saturating_sub(before) as f64 / elapsed * 100.0)
                })
            });
            let started = UNIX_EPOCH + Duration::from_secs(id.started_at);
            let idle_seconds = total_cpu.map(|total| {
                let record = self.activity.entry(id.token.clone()).or_insert_with(|| {
                    let age = wall.duration_since(started).unwrap_or_default();
                    let quiet =
                        age >= QUIET_SINCE_START && (total as f64) < age.as_nanos() as f64 * 0.001;
                    Activity {
                        cpu_ns: total,
                        at: wall,
                        last_active: if quiet { started } else { wall },
                    }
                });
                let interval = wall.duration_since(record.at).unwrap_or_default();
                if interval >= Duration::from_secs(1) {
                    let used = total.saturating_sub(record.cpu_ns) as f64;
                    if used > interval.as_nanos() as f64 * ACTIVE_CPU_SHARE {
                        record.last_active = wall;
                    }
                    record.cpu_ns = total;
                    record.at = wall;
                }
                wall.duration_since(record.last_active)
                    .unwrap_or_default()
                    .as_secs()
            });
            let app = display_name(&process.name, &info.command);
            processes.push(PortProcess {
                pid: process.pid,
                identity: id.token,
                name: process.name,
                app,
                project: project_name(info.cwd.as_deref()),
                memory_bytes,
                cpu_percent,
                started_at: id.started_at,
                idle_seconds,
                listeners: process.listeners.into_iter().collect(),
                bundle: bundle_path(&id.executable),
                executable: id.executable,
            });
        }
        let live = processes
            .iter()
            .map(|process| process.identity.as_str())
            .collect::<BTreeSet<_>>();
        self.cache.retain(|token, _| live.contains(token.as_str()));
        self.cpu.retain(|token, _| live.contains(token.as_str()));
        self.activity
            .retain(|token, _| live.contains(token.as_str()));
        processes.sort_by_key(|process| {
            (
                process.listeners.first().map(|l| l.port).unwrap_or(0),
                process.pid,
            )
        });
        Ok(Snapshot { processes })
    }

    /// Drops command lines, folders and CPU samples when the menu closes. Idle times are kept.
    pub fn forget(&mut self) {
        self.cache = HashMap::new();
        self.cpu = HashMap::new();
    }

    pub fn details(&mut self, pid: i32, token: &str) -> Result<ProcessDetails, String> {
        validate_identity(pid, token)?;
        let details = read_details(&[pid])
            .remove(&pid)
            .ok_or("Process details are no longer available")?;
        validate_identity(pid, token)?;
        self.cache.insert(token.to_string(), details.clone());
        Ok(details)
    }
}

fn validate_identity(pid: i32, token: &str) -> Result<(), String> {
    if identity(pid)?.token != token {
        return Err("The process changed. Refresh before stopping it.".into());
    }
    Ok(())
}

fn matching_ports(expected: &[u16], actual: &BTreeSet<u16>) -> bool {
    !expected.is_empty() && expected.iter().copied().collect::<BTreeSet<_>>() == *actual
}

#[derive(Serialize)]
pub struct StopOutcome {
    pub stopped: bool,
}

pub fn stop(
    pid: i32,
    token: &str,
    expected_ports: &[u16],
    force: bool,
) -> Result<StopOutcome, String> {
    validate_identity(pid, token)?;
    let actual_ports = listeners()?
        .into_iter()
        .find(|process| process.pid == pid)
        .map(|process| {
            process
                .listeners
                .into_iter()
                .map(|listener| listener.port)
                .collect::<BTreeSet<_>>()
        })
        .ok_or("The process no longer has listening ports. Refresh the list.")?;
    if !matching_ports(expected_ports, &actual_ports) {
        return Err(
            "This process's ports changed. Refresh and review them before stopping it.".into(),
        );
    }
    validate_identity(pid, token)?;
    // Positive PIDs only, current-user ownership and start time checked above. Never signal a group.
    let result = unsafe { libc::kill(pid, if force { libc::SIGKILL } else { libc::SIGTERM }) };
    if result != 0 {
        return Err(format!(
            "Could not stop process: {}",
            std::io::Error::last_os_error()
        ));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(700) {
        if !identity(pid).is_ok_and(|current| current.token == token) {
            return Ok(StopOutcome { stopped: true });
        }
        std::thread::sleep(Duration::from_millis(35));
    }
    Ok(StopOutcome { stopped: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_parser_keeps_ipv6_and_deduplicates_sockets() {
        let parsed = parse_listeners("p42\ncnode\nu501\nf1\nn127.0.0.1:3000\nf2\nn[::1]:3000\nf3\nn127.0.0.1:3000\np43\ncpython\nu501\nn*:8000\n");
        assert_eq!(parsed.len(), 2);
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
    fn bundle_path_finds_the_enclosing_app() {
        assert_eq!(
            bundle_path("/Applications/Docker.app/Contents/MacOS/com.docker.backend").as_deref(),
            Some("/Applications/Docker.app")
        );
        assert_eq!(bundle_path("/opt/homebrew/bin/node"), None);
    }

    #[test]
    fn stop_requires_the_reviewed_port_set() {
        assert!(matching_ports(&[3000, 9229], &BTreeSet::from([3000, 9229])));
        assert!(!matching_ports(&[3000], &BTreeSet::from([3000, 9229])));
        assert!(!matching_ports(&[], &BTreeSet::new()));
    }

    #[cfg(target_os = "macos")]
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
    fn protected_pids_cannot_be_signalled() {
        assert!(stop(0, "", &[3000], true).is_err());
        assert!(stop(-1, "", &[3000], true).is_err());
        assert!(stop(std::process::id() as i32, "", &[3000], true).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_scan_and_stop_leave_neighbor_running() {
        use std::io::{BufRead, BufReader};
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn fixture() -> (Fixture, u16) {
            let mut child = Command::new("/usr/bin/python3").args(["-u", "-c", "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(120)"])
                .stdout(Stdio::piped()).spawn().unwrap();
            let mut line = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            (Fixture(child), line.trim().parse().unwrap())
        }
        let (mut target, port) = fixture();
        let (mut neighbor, neighbor_port) = fixture();
        let mut scanner = Scanner::default();
        let snapshot = scanner.scan().unwrap();
        let process = snapshot
            .processes
            .iter()
            .find(|process| process.pid == target.0.id() as i32)
            .expect("fixture must be visible");
        assert!(process
            .listeners
            .iter()
            .any(|listener| listener.port == port));
        assert!(process.memory_bytes.is_some_and(|bytes| bytes > 0));
        assert!(process.started_at > 1_600_000_000);
        assert!(process.idle_seconds.is_some());
        assert!(stop(process.pid, "stale identity", &[port], true).is_err());
        assert!(target.0.try_wait().unwrap().is_none());
        assert!(stop(process.pid, &process.identity, &[neighbor_port], false).is_err());
        stop(process.pid, &process.identity, &[port], false).unwrap();
        target.0.wait().unwrap();
        assert!(neighbor.0.try_wait().unwrap().is_none());
        let after = scanner.scan().unwrap();
        assert!(!after
            .processes
            .iter()
            .any(|process| process.pid == target.0.id() as i32));
        assert!(after
            .processes
            .iter()
            .any(|process| process.pid == neighbor.0.id() as i32));
    }
}
