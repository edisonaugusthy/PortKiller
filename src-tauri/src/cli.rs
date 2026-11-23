//! `portkiller list`, `portkiller free <port>…` and `portkiller mcp`: the same scan and the same
//! checked stop as the menu, for terminals and coding agents. No window, tray or update check.
use crate::{
    mcp, platform,
    scanner::{self, PortProcess, Scanner},
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    io::{self, BufRead, IsTerminal, Write},
};

const USAGE: &str = "\
Usage: portkiller <command>

  list [--json]          Apps listening on ports
  free <port>... [--force]
                         Stop the apps on these ports. Name every port an app
                         listens on; otherwise you are asked first (in a
                         terminal) or nothing is stopped (in scripts).
  mcp                    Run as an MCP server over stdio for coding agents

With no command, PortKiller opens in the menu bar.
";

/// Runs a command and returns its exit code, or `None` to open the menu bar app.
pub fn run(args: &[String]) -> Option<i32> {
    let command = args.first()?.as_str();
    if !matches!(
        command,
        "list" | "free" | "mcp" | "help" | "--help" | "-h" | "--version" | "-V"
    ) {
        return None;
    }
    platform::attach_console();
    Some(match command {
        "list" => list(&args[1..]),
        "free" => free(&args[1..]),
        "mcp" => mcp::serve(),
        "--version" | "-V" => {
            println!("portkiller {}", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            print!("{USAGE}");
            0
        }
    })
}

/// What the menu shows as the row's name: the project folder, or the app when there is none.
pub fn title(process: &PortProcess) -> String {
    if process.project.is_empty() || process.project == "local" {
        process.app.clone()
    } else {
        process.project.clone()
    }
}

pub fn ports(process: &PortProcess) -> BTreeSet<u16> {
    process.listeners.iter().map(|l| l.port).collect()
}

pub fn port_list(ports: impl IntoIterator<Item = u16>) -> String {
    let list = ports
        .into_iter()
        .map(|port| format!(":{port}"))
        .collect::<Vec<_>>();
    match list.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// One listening app, as `list --json` and the MCP server report it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    pub app: String,
    pub pid: i32,
    pub ports: Vec<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
}

pub fn apps() -> Result<Vec<App>, String> {
    Ok(Scanner::default()
        .scan()?
        .processes
        .iter()
        .map(|process| App {
            name: title(process),
            app: process.app.clone(),
            pid: process.pid,
            ports: ports(process).into_iter().collect(),
            container: process.container.clone(),
            memory_bytes: process.memory_bytes,
        })
        .collect())
}

fn list(args: &[String]) -> i32 {
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => return usage(),
    };
    let apps = match apps() {
        Ok(apps) => apps,
        Err(error) => return fail(&error),
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&apps).unwrap_or_else(|_| "[]".into())
        );
        return 0;
    }
    if apps.is_empty() {
        println!("No apps are listening on ports.");
        return 0;
    }
    let ports = |app: &App| {
        app.ports
            .iter()
            .map(|port| format!(":{port}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let column = |values: Vec<usize>, heading: &str| {
        values.into_iter().max().unwrap_or(0).max(heading.len()) + 2
    };
    let port_width = column(apps.iter().map(|app| ports(app).len()).collect(), "PORTS");
    let width = column(
        apps.iter().map(|app| app.name.chars().count()).collect(),
        "NAME",
    );
    let app_width = column(
        apps.iter().map(|app| app.app.chars().count()).collect(),
        "APP",
    );
    println!(
        "{:<port_width$}{:<width$}{:<app_width$}PID",
        "PORTS", "NAME", "APP"
    );
    for app in &apps {
        let pid = match &app.container {
            Some(id) => format!("container {id}"),
            None => app.pid.to_string(),
        };
        println!(
            "{:<port_width$}{:<width$}{:<app_width$}{pid}",
            ports(app),
            app.name,
            app.app
        );
    }
    0
}

/// Who holds the requested ports, worked out from one fresh scan.
pub struct Plan {
    /// Apps to stop, each with every port it listens on.
    pub targets: Vec<(PortProcess, BTreeSet<u16>)>,
    /// Requested ports no app of this user listens on.
    pub unused: Vec<u16>,
    /// Requested ports held by a process PortKiller never stops, with its name.
    pub protected: Vec<(u16, String)>,
}

impl Plan {
    /// Targets that also listen on ports the caller did not name, with those ports.
    pub fn unnamed(&self, requested: &BTreeSet<u16>) -> Vec<(String, BTreeSet<u16>)> {
        self.targets
            .iter()
            .filter_map(|(process, ports)| {
                let extra = ports
                    .difference(requested)
                    .copied()
                    .collect::<BTreeSet<_>>();
                (!extra.is_empty()).then(|| (title(process), extra))
            })
            .collect()
    }

    pub fn all_ports(&self) -> BTreeSet<u16> {
        self.targets
            .iter()
            .flat_map(|(_, ports)| ports.iter().copied())
            .collect()
    }
}

pub fn plan(requested: &BTreeSet<u16>) -> Result<Plan, String> {
    let processes = Scanner::default().scan()?.processes;
    let mut plan = Plan {
        targets: Vec::new(),
        unused: Vec::new(),
        protected: Vec::new(),
    };
    let mut missing = Vec::new();
    for &port in requested {
        match processes
            .iter()
            .find(|process| process.listeners.iter().any(|l| l.port == port))
        {
            Some(process) => {
                if !plan
                    .targets
                    .iter()
                    .any(|(target, _)| target.identity == process.identity)
                {
                    plan.targets.push((process.clone(), ports(process)));
                }
            }
            None => missing.push(port),
        }
    }
    if !missing.is_empty() {
        // The scan leaves out system services, other users' apps and PortKiller itself.
        let raw = platform::listeners()?;
        for port in missing {
            match raw
                .iter()
                .find(|process| process.listeners.iter().any(|l| l.port == port))
            {
                Some(process) => plan.protected.push((port, process.name.clone())),
                None => plan.unused.push(port),
            }
        }
    }
    Ok(plan)
}

/// Stops every target with its full port set. Each stop revalidates owner, start time and ports.
pub fn execute(plan: &Plan, force: bool) -> Vec<Result<String, String>> {
    plan.targets
        .iter()
        .map(|(process, ports)| {
            let ports = ports.iter().copied().collect::<Vec<_>>();
            let name = title(process);
            match scanner::stop(process.pid, &process.identity, &ports, force) {
                Ok(outcome) if outcome.stopped => {
                    Ok(format!("Stopped {name} ({})", port_list(ports)))
                }
                Ok(_) => Err(format!(
                    "{name} is still stopping. Try again with --force to force quit it."
                )),
                Err(error) => Err(format!("{name}: {error}")),
            }
        })
        .collect()
}

pub fn parse_port(value: &str) -> Result<u16, String> {
    value
        .trim_start_matches(':')
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| format!("Not a port: {value}"))
}

fn free(args: &[String]) -> i32 {
    let mut force = false;
    let mut requested = BTreeSet::new();
    for arg in args {
        match arg.as_str() {
            "--force" | "-f" => force = true,
            value => match parse_port(value) {
                Ok(port) => {
                    requested.insert(port);
                }
                Err(error) => {
                    eprintln!("{error}");
                    return usage();
                }
            },
        }
    }
    if requested.is_empty() {
        return usage();
    }
    let plan = match plan(&requested) {
        Ok(plan) => plan,
        Err(error) => return fail(&error),
    };
    let mut code = 0;
    for port in &plan.unused {
        println!(":{port} is already free");
    }
    for (port, name) in &plan.protected {
        eprintln!(":{port} is held by {name}, which PortKiller does not stop");
        code = 1;
    }
    let unnamed = plan.unnamed(&requested);
    if !unnamed.is_empty() {
        let also = unnamed
            .iter()
            .map(|(name, extra)| {
                format!(
                    "{name} also listens on {}",
                    port_list(extra.iter().copied())
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let everything = plan.all_ports();
        let interactive = io::stdin().is_terminal() && io::stdout().is_terminal();
        if !interactive {
            let command = everything
                .iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(" ");
            eprintln!("{also}. Nothing was stopped. To stop it, name every port: portkiller free {command}");
            return 2;
        }
        print!("{also}. Stop and free {}? [y/N] ", port_list(everything));
        let _ = io::stdout().flush();
        let mut answer = String::new();
        let _ = io::stdin().lock().read_line(&mut answer);
        if !matches!(answer.trim(), "y" | "Y" | "yes" | "Yes") {
            println!("Nothing was stopped.");
            return 1;
        }
    }
    for result in execute(&plan, force) {
        match result {
            Ok(line) => println!("{line}"),
            Err(error) => {
                eprintln!("{error}");
                code = 1;
            }
        }
    }
    code
}

fn usage() -> i32 {
    eprint!("{USAGE}");
    2
}

fn fail(error: &str) -> i32 {
    eprintln!("portkiller: {error}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_parse_with_or_without_a_colon() {
        assert_eq!(parse_port("3000"), Ok(3000));
        assert_eq!(parse_port(":8080"), Ok(8080));
        assert!(parse_port("0").is_err());
        assert!(parse_port("70000").is_err());
        assert!(parse_port("http").is_err());
    }

    #[test]
    fn port_lists_read_like_the_menu() {
        assert_eq!(port_list([3000]), ":3000");
        assert_eq!(port_list([3000, 9229]), ":3000 and :9229");
        assert_eq!(port_list([1, 2, 3]), ":1, :2 and :3");
    }

    #[test]
    fn only_known_commands_leave_the_menu_bar_app() {
        assert_eq!(run(&[]), None);
        assert_eq!(run(&["-psn_0_12345".into()]), None);
        assert_eq!(run(&["--autostart".into()]), None);
    }

    /// A real listener: naming only one of its two ports stops nothing; naming both stops it.
    #[test]
    fn free_requires_every_port_of_the_app() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
        };
        const PYTHON: &str = if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        };
        let mut child = Command::new(PYTHON)
            .args(["-u", "-c", "import socket,time\na=socket.socket(); a.bind(('127.0.0.1',0)); a.listen()\nb=socket.socket(); b.bind(('127.0.0.1',0)); b.listen()\nprint(a.getsockname()[1], b.getsockname()[1], flush=True); time.sleep(120)"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let found = line
            .split_whitespace()
            .map(|port| port.parse::<u16>().unwrap())
            .collect::<Vec<_>>();
        let (first, second) = (found[0], found[1]);
        let one = BTreeSet::from([first]);
        let plan_one = plan(&one).unwrap();
        assert_eq!(plan_one.targets.len(), 1);
        assert_eq!(
            plan_one.unnamed(&one).len(),
            1,
            "the second port is reported"
        );
        assert!(child.try_wait().unwrap().is_none());
        let both = BTreeSet::from([first, second]);
        let plan_both = plan(&both).unwrap();
        assert!(plan_both.unnamed(&both).is_empty());
        let results = execute(&plan_both, false);
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        child.wait().unwrap();
        let after = plan(&both).unwrap();
        assert!(after.targets.is_empty());
        assert_eq!(after.unused, vec![first.min(second), first.max(second)]);
    }
}
