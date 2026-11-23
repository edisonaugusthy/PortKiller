//! Docker containers as their own rows. On macOS and Windows a container's published ports are
//! held by the Docker engine's host process, so stopping that row would quit Docker and every
//! container with it. When an engine row shows up, the engine is asked which running container
//! publishes each port, and those ports move to one row per container. Stopping a container row
//! runs `docker stop` on that container only, after checking its ID and port set again.
//! Without a reachable engine the list stays as it was.
use crate::platform;
use crate::scanner::{matching_ports, PortProcess, ProcessDetails, StopOutcome};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    io::{Read, Write},
    sync::mpsc,
    time::Duration,
};

const PREFIX: &str = "docker:";
const LIST_TIMEOUT: Duration = Duration::from_secs(2);
/// `docker stop` waits up to 10 seconds before the engine kills the container.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Debug, PartialEq)]
struct Container {
    id: String,
    name: String,
    /// `project/service` for Compose containers, otherwise the container name.
    title: String,
    image: String,
    command: String,
    created: u64,
    folder: Option<String>,
    ports: BTreeSet<u16>,
}

/// The container ID inside a row identity, if the row is a container.
pub fn container_id(identity: &str) -> Option<&str> {
    identity
        .strip_prefix(PREFIX)
        .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Host processes that hold ports for containers: Docker Desktop, OrbStack, Lima/Colima, WSL.
fn is_engine(process: &PortProcess) -> bool {
    let name = process.name.to_lowercase();
    process.app == "Docker"
        || ["orbstack", "limactl", "vpnkit", "wslrelay"]
            .iter()
            .any(|engine| name.contains(engine))
}

/// Moves ports that running containers publish from engine rows to one row per container.
pub fn split(processes: Vec<PortProcess>) -> Vec<PortProcess> {
    if !processes.iter().any(is_engine) {
        return processes;
    }
    match running() {
        Ok(containers) => assign(processes, &containers),
        Err(_) => processes,
    }
}

fn assign(processes: Vec<PortProcess>, containers: &[Container]) -> Vec<PortProcess> {
    let mut rows = Vec::with_capacity(processes.len() + containers.len());
    for process in processes {
        if !is_engine(&process) {
            rows.push(process);
            continue;
        }
        let mut rest = process.listeners.clone();
        for container in containers {
            let listeners = process
                .listeners
                .iter()
                .filter(|listener| container.ports.contains(&listener.port))
                .cloned()
                .collect::<Vec<_>>();
            if listeners.is_empty() {
                continue;
            }
            rest.retain(|listener| !container.ports.contains(&listener.port));
            rows.push(PortProcess {
                pid: process.pid,
                identity: format!("{PREFIX}{}", container.id),
                name: container.name.clone(),
                app: "Docker".into(),
                project: container.title.clone(),
                executable: process.executable.clone(),
                memory_bytes: None,
                cpu_percent: None,
                started_at: container.created,
                // Containers are never idle, so Stop all leaves them alone.
                idle_seconds: None,
                listeners,
                bundle: process.bundle.clone(),
                container: Some(container.id[..12].to_string()),
            });
        }
        // The engine keeps a row only for ports no container claims.
        if !rest.is_empty() {
            rows.push(PortProcess {
                listeners: rest,
                ..process
            });
        }
    }
    rows
}

pub fn details(identity: &str) -> Result<ProcessDetails, String> {
    let container = find(identity)?;
    Ok(ProcessDetails {
        command: format!("{} {}", container.image, container.command)
            .trim()
            .to_string(),
        cwd: container.folder,
    })
}

/// `docker stop` (or `docker kill` when forced) for one container whose ports are exactly `expected`.
pub fn stop(identity: &str, expected: &[u16], force: bool) -> Result<StopOutcome, String> {
    let container = find(identity)?;
    if !matching_ports(expected, &container.ports) {
        return Err(
            "This container's ports changed. Refresh and review them before stopping it.".into(),
        );
    }
    let action = if force { "kill" } else { "stop" };
    let (status, body) = request(
        "POST",
        &format!("/containers/{}/{action}", container.id),
        STOP_TIMEOUT,
    )?;
    match status {
        // 304: it had already stopped.
        204 | 304 => Ok(StopOutcome { stopped: true }),
        _ => Err(api_error(&body, "Docker could not stop the container")),
    }
}

fn find(identity: &str) -> Result<Container, String> {
    let id = container_id(identity).ok_or("Not a container")?;
    running()?
        .into_iter()
        .find(|container| container.id == id)
        .ok_or_else(|| "The container is no longer running. Refresh the list.".into())
}

fn running() -> Result<Vec<Container>, String> {
    let (status, body) = request("GET", "/containers/json", LIST_TIMEOUT)?;
    if status != 200 {
        return Err(api_error(&body, "Docker could not list containers"));
    }
    parse_containers(&body)
}

fn parse_containers(body: &[u8]) -> Result<Vec<Container>, String> {
    let list: Vec<Value> = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .filter_map(|item| {
            let id = item["Id"].as_str()?.to_string();
            container_id(&format!("{PREFIX}{id}"))?;
            let name = item["Names"]
                .as_array()
                .and_then(|names| names.first())
                .and_then(Value::as_str)
                .unwrap_or(&id[..12])
                .trim_start_matches('/')
                .to_string();
            let labels = item["Labels"].as_object();
            let label = |key: &str| {
                labels
                    .and_then(|labels| labels.get(key))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let title = match (
                label("com.docker.compose.project"),
                label("com.docker.compose.service"),
            ) {
                (Some(project), Some(service)) => format!("{project}/{service}"),
                _ => name.clone(),
            };
            let ports = item["Ports"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|port| port["Type"].as_str() == Some("tcp"))
                .filter_map(|port| u16::try_from(port["PublicPort"].as_u64()?).ok())
                .filter(|port| *port > 0)
                .collect::<BTreeSet<_>>();
            Some(Container {
                name,
                title,
                image: item["Image"].as_str().unwrap_or_default().to_string(),
                command: item["Command"].as_str().unwrap_or_default().to_string(),
                created: item["Created"].as_u64().unwrap_or_default(),
                folder: label("com.docker.compose.project.working_dir"),
                ports,
                id,
            })
        })
        .filter(|container| !container.ports.is_empty())
        .collect())
}

fn api_error(body: &[u8], fallback: &str) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .map(|message| format!("{fallback}: {message}"))
        .unwrap_or_else(|| fallback.to_string())
}

/// One HTTP/1.0 request to the engine's local socket or pipe; the engine closes the connection
/// after answering. Runs on its own thread so a hung engine cannot hold up a scan.
fn request(method: &str, path: &str, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
    let message = format!("{method} {path} HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n");
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let mut stream = platform::docker_connect(timeout)?;
            stream
                .write_all(message.as_bytes())
                .map_err(|e| format!("Could not reach Docker: {e}"))?;
            let mut data = Vec::new();
            Read::by_ref(&mut stream)
                .take(RESPONSE_LIMIT + 1)
                .read_to_end(&mut data)
                .map_err(|e| format!("Could not read Docker's answer: {e}"))?;
            Ok::<_, String>(data)
        })();
        let _ = sender.send(result);
    });
    let data = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Docker did not answer in time".to_string())??;
    if data.len() as u64 > RESPONSE_LIMIT {
        return Err("Docker's answer exceeded the size limit".into());
    }
    parse_response(&data)
}

fn parse_response(data: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = data
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("Docker sent an incomplete answer")?;
    let head = String::from_utf8_lossy(&data[..split]).to_lowercase();
    let body = &data[split + 4..];
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("Docker sent an unexpected answer")?;
    let headers = head
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect::<HashMap<_, _>>();
    let body = if headers.get("transfer-encoding").map(String::as_str) == Some("chunked") {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    Ok((status, body))
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("Docker sent an incomplete answer")?;
        let size = std::str::from_utf8(&data[..line_end])
            .ok()
            .and_then(|line| usize::from_str_radix(line.split(';').next()?.trim(), 16).ok())
            .ok_or("Docker sent an unexpected answer")?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok(body);
        }
        body.extend_from_slice(data.get(..size).ok_or("Docker sent an incomplete answer")?);
        data = data.get(size + 2..).unwrap_or_default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::Listener;

    const ID_A: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const ID_B: &str = "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn listing() -> String {
        format!(
            r#"[
          {{"Id":"{ID_A}","Names":["/storefront-db-1"],"Image":"postgres:17","Command":"docker-entrypoint.sh postgres","Created":1763900000,
            "Ports":[{{"IP":"0.0.0.0","PrivatePort":5432,"PublicPort":5432,"Type":"tcp"}},{{"IP":"::","PrivatePort":5432,"PublicPort":5432,"Type":"tcp"}}],
            "Labels":{{"com.docker.compose.project":"storefront","com.docker.compose.service":"db","com.docker.compose.project.working_dir":"/Users/me/code/storefront"}}}},
          {{"Id":"{ID_B}","Names":["/minio"],"Image":"minio/minio","Command":"server /data","Created":1763900001,
            "Ports":[{{"IP":"127.0.0.1","PrivatePort":9000,"PublicPort":9000,"Type":"tcp"}},{{"PrivatePort":9001,"Type":"tcp"}},{{"IP":"0.0.0.0","PrivatePort":53,"PublicPort":5353,"Type":"udp"}}],
            "Labels":{{}}}},
          {{"Id":"c0ffee","Names":["/bad-id"],"Ports":[{{"PublicPort":1234,"Type":"tcp"}}]}},
          {{"Id":"{ID_A}0","Names":["/long-id"],"Ports":[{{"PublicPort":1235,"Type":"tcp"}}]}}
        ]"#
        )
    }

    fn engine(ports: &[u16]) -> PortProcess {
        PortProcess {
            pid: 6011,
            identity: "6011:1:2".into(),
            name: "com.docker.backend".into(),
            app: "Docker".into(),
            project: "local".into(),
            executable: "/Applications/Docker.app/Contents/MacOS/com.docker.backend".into(),
            memory_bytes: Some(1),
            cpu_percent: None,
            started_at: 1,
            idle_seconds: Some(0),
            listeners: ports
                .iter()
                .map(|port| Listener {
                    port: *port,
                    address: "*".into(),
                })
                .collect(),
            bundle: Some("/Applications/Docker.app".into()),
            container: None,
        }
    }

    #[test]
    fn container_listing_keeps_published_tcp_ports_and_valid_ids() {
        let containers = parse_containers(listing().as_bytes()).unwrap();
        assert_eq!(containers.len(), 2, "malformed IDs are dropped");
        assert_eq!(containers[0].title, "storefront/db");
        assert_eq!(
            containers[0].folder.as_deref(),
            Some("/Users/me/code/storefront")
        );
        assert_eq!(containers[0].ports, BTreeSet::from([5432]));
        assert_eq!(containers[1].title, "minio");
        assert_eq!(
            containers[1].ports,
            BTreeSet::from([9000]),
            "unpublished and UDP ports are not listeners"
        );
    }

    #[test]
    fn engine_ports_move_to_container_rows() {
        let containers = parse_containers(listing().as_bytes()).unwrap();
        let mut other = engine(&[3000]);
        other.name = "node".into();
        other.app = "node".into();
        let rows = assign(vec![engine(&[5432, 9000, 7777]), other], &containers);
        let ports = |row: &PortProcess| row.listeners.iter().map(|l| l.port).collect::<Vec<_>>();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].identity, format!("docker:{ID_A}"));
        assert_eq!(rows[0].project, "storefront/db");
        assert_eq!(rows[0].container.as_deref(), Some(&ID_A[..12]));
        assert_eq!(ports(&rows[0]), [5432]);
        assert_eq!(rows[0].idle_seconds, None);
        assert_eq!(ports(&rows[1]), [9000]);
        assert_eq!(
            rows[2].identity, "6011:1:2",
            "the engine keeps unclaimed ports"
        );
        assert_eq!(ports(&rows[2]), [7777]);
        assert_eq!(rows[3].name, "node", "other apps are untouched");
        let only_containers = assign(vec![engine(&[5432])], &containers);
        assert_eq!(
            only_containers.len(),
            1,
            "an engine with no ports left is hidden"
        );
    }

    #[test]
    fn container_identities_are_strict() {
        assert_eq!(container_id(&format!("docker:{ID_A}")), Some(ID_A));
        assert_eq!(container_id("docker:../../version"), None);
        assert_eq!(container_id(&format!("docker:{ID_A}/kill")), None);
        assert_eq!(container_id("8421:1:2"), None);
    }

    #[test]
    fn engine_answers_parse_plain_and_chunked() {
        let (status, body) =
            parse_response(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n[]").unwrap();
        assert_eq!((status, body.as_slice()), (200, b"[]".as_slice()));
        let (status, body) = parse_response(
            b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"me\r\n10\r\nssage\":\"gone\"}  \r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(status, 404);
        assert_eq!(api_error(&body, "Failed"), "Failed: gone");
        assert!(parse_response(b"HTTP/1.0 200 OK\r\n").is_err());
    }
}
