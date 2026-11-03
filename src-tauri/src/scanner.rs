use crate::platform;
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
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
    /// Where the menu reads this process's icon from (an `.app` bundle on macOS, the `.exe` on Windows).
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

/// A listening process as the platform reports it, before PortKiller adds its own details.
#[derive(Default, Debug)]
pub(crate) struct RawProcess {
    pub pid: i32,
    pub name: String,
    pub listeners: BTreeSet<Listener>,
}

/// Who a PID is right now. The token changes if the PID is reused by another process.
#[derive(Debug)]
pub(crate) struct Identity {
    pub token: String,
    pub executable: String,
    pub started_at: u64,
}

fn display_name(name: &str, command: &str) -> String {
    // Windows command lines use backslashes; match them like macOS paths.
    let command = command.to_lowercase().replace('\\', "/");
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
        let candidates = platform::listeners()?
            .into_iter()
            .filter_map(|process| {
                // Other users' processes, system services and PortKiller itself fail here.
                let identity = platform::identity(process.pid).ok()?;
                Some((process, identity))
            })
            .collect::<Vec<_>>();
        let new_pids = candidates
            .iter()
            .filter(|(_, id)| !self.cache.contains_key(&id.token))
            .map(|(process, _)| process.pid)
            .collect::<Vec<_>>();
        let mut metadata = platform::read_details(&new_pids);
        let now = Instant::now();
        let wall = SystemTime::now();
        let mut processes = Vec::new();
        for (process, id) in candidates {
            // Recheck after subprocess metadata collection; do not cache a recycled PID.
            if !platform::identity(process.pid).is_ok_and(|current| current.token == id.token) {
                continue;
            }
            let info = self.cache.entry(id.token.clone()).or_insert_with(|| {
                metadata.remove(&process.pid).unwrap_or(ProcessDetails {
                    command: id.executable.clone(),
                    cwd: None,
                })
            });
            let (memory_bytes, total_cpu) = platform::resources(process.pid);
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
                bundle: platform::icon_source(&id.executable),
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
        let details = platform::read_details(&[pid])
            .remove(&pid)
            .ok_or("Process details are no longer available")?;
        validate_identity(pid, token)?;
        self.cache.insert(token.to_string(), details.clone());
        Ok(details)
    }
}

fn validate_identity(pid: i32, token: &str) -> Result<(), String> {
    if platform::identity(pid)?.token != token {
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
    let actual_ports = platform::listeners()?
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
    // Positive PIDs only, current-user ownership and start time checked above.
    platform::signal(pid, force)?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(700) {
        if !platform::identity(pid).is_ok_and(|current| current.token == token) {
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
    fn stop_requires_the_reviewed_port_set() {
        assert!(matching_ports(&[3000, 9229], &BTreeSet::from([3000, 9229])));
        assert!(!matching_ports(&[3000], &BTreeSet::from([3000, 9229])));
        assert!(!matching_ports(&[], &BTreeSet::new()));
    }

    #[test]
    fn protected_pids_cannot_be_signalled() {
        assert!(stop(0, "", &[3000], true).is_err());
        assert!(stop(-1, "", &[3000], true).is_err());
        assert!(stop(std::process::id() as i32, "", &[3000], true).is_err());
    }

    /// Runs on macOS and Windows with a real Python listener; needs `python3` (macOS) or `python` (Windows).
    #[test]
    fn native_scan_and_stop_leave_neighbor_running() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
        };
        const PYTHON: &str = if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        };
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn fixture() -> (Fixture, u16) {
            let mut child = Command::new(PYTHON).args(["-u", "-c", "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(120)"])
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
