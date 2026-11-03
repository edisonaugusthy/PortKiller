# PortKiller

A small macOS menu bar app built with Tauri 2, Rust, TypeScript, and the system WebKit. It shows which apps are listening on which ports and stops them safely.

## Use

Open `src-tauri/target/release/bundle/macos/PortKiller.app` after building. Click its socket icon in the menu bar. Right-click the icon to quit.

- Each row is an app's icon, its name and its port. The name is the project folder when there is one, so two Node servers read as `storefront` and `old-landing`. Apps from a `.app` bundle show their real icon; command-line servers show a small glyph for their runtime (Node, Python, Ruby, PostgreSQL and others). A `+1` after the port means the app listens on more ports.
- Apps are grouped into **Running** (pinned apps first, then by port) and **Idle** (no noticeable CPU for the configured time, 30 minutes by default; largest memory first). **Stop all** stops the idle apps shown, one at a time, with the usual validation for each. Pinned apps are never idle.
- Clicking an app opens its page: each port with Open (in the default browser) and Copy, then App, CPU, Memory, Uptime (or Idle) and Folder. CPU uses Activity Monitor's convention, where 100% is one fully used core.
- Hides macOS system executables and processes owned by other users. Filtering is based on ownership and executable path, so your development server on a low-numbered port is still eligible.
- The menu stays within 70% of the current screen's usable height, up to 680 logical pixels. Search stays in place while the list scrolls.
- Stop requests a graceful shutdown (`SIGTERM`). Hold Option while clicking Stop to force quit (`SIGKILL`). Both confirm inline and name every affected port, because stopping a process releases all of its ports.
- During `npm run tauri dev`, the dev server that serves PortKiller's own window is shown last as **PortKiller**, is never idle or included in Stop all, and asks "Stop :1420 and close PortKiller?" before stopping.
- Search by port, application, project, or PID. Start typing or press Command-F to search; Escape cancels a confirmation, leaves a page, clears the search, then closes the menu.
- Settings: Open at login (off by default, never enabled automatically), Count in menu bar, Idle after, Appearance (Auto, Light or Dark) and the pinned apps.

This version shows TCP servers, not outgoing client connections or UDP sockets. Containers and virtual machines can expose a host proxy process; PortKiller manages that host process, not services inside the guest. Supervisors may restart processes after they are stopped.

## Resource use

The tray runs without a dock icon or a resident webview. The popover is created on demand and destroyed on dismissal. There are no background scan timers. The count in the menu bar is the last observed count and refreshes when opened.

macOS draws the menu's glass: Liquid Glass on macOS 26 and later, the popover material on earlier versions, and a solid background when Reduce Transparency is on. The page itself paints no blur or backdrop.

While open, one scan runs every three seconds (the second after one second, since CPU needs two samples); scans never overlap. Queries target only listening PIDs. CPU time and resident memory come from one `proc_pidinfo` call per listening process; no process tree is scanned. CPU time is converted from Mach ticks, which are not nanoseconds on Apple Silicon. The page is only rewritten when what it shows changes, so most scans touch no DOM. Command/directory metadata is cached while open and discarded on close; the app page requests it on demand. App icons are drawn once per bundle at 52 px, kept while the menu is open and discarded on close. Nothing is downloaded.

Idle time is measured only by scans, so it spans openings without a background timer: a process counts as active when it used more than 1% of a core between two scans. On first sight, a process that is at least 30 minutes old and has averaged under 0.1% CPU is treated as idle since it started. Only per-process CPU totals and timestamps are kept while closed.

The release frontend has about 17 KB of JavaScript and 9 KB of CSS before compression. The native glass adds about 2.6 MB to the main process once the menu has opened. Native memory measurements vary with macOS, shared framework accounting, and the number of running servers; see `docs/verification.md` for this machine's observations.

## Development

Requires macOS 14.5+, Xcode Command Line Tools, Node.js 22.12+ (or a compatible current release), and Rust 1.90+.

```sh
npm install
npm run tauri dev
```

The app opens in the menu bar. For a browser-only UI preview with explicitly simulated processes:

```sh
npm run dev
# Open http://127.0.0.1:1420/?demo
# Add &dense for a 27-app layout check, or &empty for the empty state.
```

The demo adapter is removed from production builds. Native releases always query real processes.

```sh
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build
```

The Tauri npm wrapper also finds an existing stable Rust toolchain when its command shims are missing from PATH.

## Process controls

All inspection and signalling runs in Rust. The frontend has no shell, filesystem, or network plugin; Open builds the `http://localhost:<port>` URL in Rust from a port number. Before a stop, Rust validates the process UID, real UID, executable path, PID start time, and the complete current set of TCP listening ports. Changed identities or port sets are rejected for review. System processes, PID 0/1, negative PIDs, and PortKiller itself cannot be signalled. No `sudo` or privilege helper is used.

App icons are read by macOS from the app bundle that contains each process; `app_icon` accepts only absolute paths to existing `.app` directories. Commands and working directories remain local and are not written to logs or settings. Pins are stored as executable path and project name. Preferences are stored in the app's macOS configuration directory. The app has no analytics, telemetry, or remote assets.

The bundled app is for local use; public distribution would require your Apple signing identity and notarization.
