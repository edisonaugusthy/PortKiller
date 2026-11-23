//! `portkiller mcp`: a Model Context Protocol server over stdio (one JSON-RPC message per line)
//! with two tools, `list_ports` and `stop_port`. Stops go through the same Rust checks as the menu.
use crate::cli::{self, port_list};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{self, BufRead, Write},
};

const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Use list_ports to see which of the user's apps listen on TCP ports, \
and stop_port to free ports, for example after an 'address already in use' error. Prefer these \
to kill or taskkill: PortKiller checks again, right before stopping, that the process belongs to \
the user, is the same process, still listens on exactly those ports, and is not a system \
process. Docker containers are stopped one at a time, never the Docker engine.";

pub fn serve() -> i32 {
    let mut output = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(&message),
            Err(_) => Some(failure(Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            if writeln!(output, "{reply}")
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    }
    0
}

/// The reply to one message, or `None` for notifications.
fn handle(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let params = &message["params"];
    Some(match message["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = VERSIONS
                .iter()
                .find(|version| **version == requested)
                .unwrap_or(&VERSIONS[0]);
            success(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "portkiller", "title": "PortKiller", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => success(id, json!({})),
        "tools/list" => success(id, json!({ "tools": tools() })),
        "tools/call" => match params["name"].as_str() {
            Some("list_ports") => success(id, list_ports()),
            Some("stop_port") => success(id, stop_port(&params["arguments"])),
            _ => failure(id, -32602, "Unknown tool"),
        },
        _ => failure(id, -32601, "Method not found"),
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "list_ports",
            "title": "List open ports",
            "description": "List the user's apps that listen on TCP ports: name (project folder or app), app, pid, every port it listens on, and the Docker container ID when a container publishes the port.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        },
        {
            "name": "stop_port",
            "title": "Free ports",
            "description": "Stop the app or Docker container listening on these ports so they are free. Name every port the app listens on (see list_ports): if it also holds ports you did not name, nothing is stopped and the reply lists them. Right before stopping, PortKiller checks that the process is the user's own, is the same process, still listens on exactly those ports, and is not a system process. Containers get docker stop; the Docker engine itself is never stopped.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ports": { "type": "array", "items": { "type": "integer", "minimum": 1, "maximum": 65535 }, "minItems": 1, "description": "Every port to free." },
                    "force": { "type": "boolean", "default": false, "description": "Force quit (SIGKILL, or docker kill) instead of asking the app to quit. Windows always ends the task at once." },
                },
                "required": ["ports"],
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false },
        },
    ])
}

fn text(message: String, error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": error })
}

fn list_ports() -> Value {
    match cli::apps() {
        Ok(apps) => {
            let apps = serde_json::to_value(&apps).unwrap_or_default();
            json!({
                "content": [{ "type": "text", "text": apps.to_string() }],
                "structuredContent": { "apps": apps },
                "isError": false,
            })
        }
        Err(error) => text(error, true),
    }
}

fn stop_port(arguments: &Value) -> Value {
    let requested = arguments["ports"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|port| {
            port.as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port > 0)
                .ok_or_else(|| format!("Not a port: {port}"))
        })
        .collect::<Result<BTreeSet<_>, _>>();
    let requested = match requested {
        Ok(ports) if !ports.is_empty() => ports,
        Ok(_) => return text("Name at least one port.".into(), true),
        Err(error) => return text(error, true),
    };
    let force = arguments["force"].as_bool().unwrap_or(false);
    let plan = match cli::plan(&requested) {
        Ok(plan) => plan,
        Err(error) => return text(error, true),
    };
    let mut lines = Vec::new();
    let mut failed = false;
    for port in &plan.unused {
        lines.push(format!(":{port} is already free."));
    }
    for (port, name) in &plan.protected {
        lines.push(format!(
            ":{port} is held by {name}, which PortKiller does not stop."
        ));
        failed = true;
    }
    let unnamed = plan.unnamed(&requested);
    if !unnamed.is_empty() {
        for (name, extra) in unnamed {
            lines.push(format!(
                "{name} also listens on {}.",
                port_list(extra.iter().copied())
            ));
        }
        let all = plan.all_ports().into_iter().collect::<Vec<_>>();
        lines.push(format!(
            "Nothing was stopped. To stop it, call stop_port again with ports {all:?}."
        ));
        return text(lines.join("\n"), true);
    }
    for result in cli::execute(&plan, force) {
        match result {
            Ok(line) => lines.push(format!("{line}.")),
            Err(error) => {
                lines.push(error);
                failed = true;
            }
        }
    }
    text(lines.join("\n"), failed)
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_negotiates_a_supported_version() {
        let reply = handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(reply["result"]["serverInfo"]["name"], "portkiller");
        let reply = handle(&json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], VERSIONS[0]);
        assert!(handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }

    #[test]
    fn tools_are_listed_and_unknown_calls_fail() {
        let reply = handle(&json!({"jsonrpc":"2.0","id":"a","method":"tools/list"})).unwrap();
        let names = reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["list_ports", "stop_port"]);
        let reply = handle(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kill_everything"}})).unwrap();
        assert_eq!(reply["error"]["code"], -32602);
        let reply = handle(&json!({"jsonrpc":"2.0","id":4,"method":"resources/list"})).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
    }

    #[test]
    fn stop_port_rejects_bad_ports_before_scanning() {
        for arguments in [
            json!({}),
            json!({"ports": []}),
            json!({"ports": [0]}),
            json!({"ports": [70000]}),
            json!({"ports": ["3000"]}),
        ] {
            let result = stop_port(&arguments);
            assert_eq!(result["isError"], true, "{arguments}");
        }
    }
}
