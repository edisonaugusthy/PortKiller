# Verification — 3 November 2026 (releases and updates)

- Updater: Tauri's updater plugin with the system TLS (Security framework, Schannel), so no extra crypto library is compiled in. `cargo clippy -D warnings` passed for macOS and for Windows (cross-checked from macOS); `cargo test` 8 passed.
- A local release build with the signing key (`--config src-tauri/tauri.release.conf.json`) produced `PortKiller.app.tar.gz` and its `.sig`; a normal `npm run tauri build` without the key still works.
- Browser demo (`?demo&update`, with and without `&windows`): the list shows "Version 0.2.0 is available" with Update.
- `.github/workflows/release.yml` and `ci.yml` parse as YAML. Neither has run on GitHub yet, so the published release, `latest.json` and an in-app update from one real version to the next are still unverified.

# Verification — 3 November 2026 (Windows port)

## Windows support

PortKiller now builds for Windows from the same code. Platform code moved into `src-tauri/src/platform/macos.rs` (unchanged behavior) and a new `windows.rs` that uses `netstat2` for the listening-socket table, `sysinfo` for process identity, owner, CPU, memory, command line and folder, and `taskkill /F` to end a process. The frontend switches to a Windows 11 look and wording ("End task", "Start with Windows", "Exit") when it runs on Windows.

- macOS: `cargo test` 8 passed, `cargo clippy --all-targets -D warnings` and `cargo fmt --check` passed, TypeScript and Vite build passed (17.5 kB JS, 11.9 kB CSS before compression), and the browser demo still shows the macOS look and wording.
- Windows, compiled from macOS: `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings` passed. Tauri's build script needs Windows' resource compiler, which macOS lacks; a scratch stand-in that writes an empty resource file was used for this check only. Nothing Windows-specific has run yet.
- Browser demo with `?demo&windows`: list, hover End task, confirmation naming every port ("End :3000 and :9229?"), End all, settings with the Windows toggle and drop-downs. No console errors.
- Not yet verified on Windows: the scan against real processes, ending a process, Acrylic glass, flyout placement above the tray, and the installer. CI (`.github/workflows/ci.yml`) runs tests, Clippy and `tauri build` on `windows-latest` and uploads the installer once the repository is pushed to GitHub.

# Verification — 3 November 2026

## Liquid Glass revision

The popover follows the approved "PortKiller Liquid Glass" design: one row per app (icon, name, port), Running and Idle groups, an app page with ports and five properties, and settings with Appearance (Auto, Light, Dark). The window is 360 logical pixels wide. macOS draws the glass (`LiquidGlassRegular`, falling back to the `Popover` material before macOS 26); the page paints no backdrop. The CPU chart, sparklines, summary cards and sort control were removed.

- `cargo test`: 8 tests passed, including two new ones: `bundle_path` finds the enclosing `.app`, and `app_icon` renders Calculator's real icon as PNG while rejecting non-bundle and relative paths.
- `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`: passed. TypeScript type check and Vite build: passed (16.6 kB JS, 9.4 kB CSS before compression; previously 24.9 kB and 16.8 kB).
- Browser demo (`?demo`, `?demo&dense`, `?demo&empty`, light and dark): rows, hover stop, inline stop confirmation naming every port (three-port Docker row wraps instead of truncating), Stop all with idle rows marked, notice after stopping, app page with Open/Copy, settings with switches, idle threshold, Appearance and Unpin, type-to-search, list scrolling. No console errors.
- PortKiller's own dev server (the port the page is served from) is listed last as PortKiller, excluded from Idle and Stop all, and its confirmation reads "Stop :1420 and close PortKiller?".
- `npm run tauri build`: signed (ad hoc) ARM64 `PortKiller.app`, 3.41 MiB; `codesign --verify --deep --strict` passed. The app launched and opened its popover (a WebContent process started and was removed on dismissal). The native glass itself could not be screenshotted here because Screen Recording permission was not granted, so its look in the real menu bar still needs a manual check.

Memory, main process physical footprint (`vmmap -summary`), same session and same running servers, each build measured twice:

| Build | Tray only | After 3 opens and closes |
| --- | --- | --- |
| Before this revision | 15.6 MiB | 25.1 MiB |
| This revision | 15.9–16.0 MiB | 28.1–28.2 MiB |
| This revision, icons disabled (test only) | 16.2 MiB | 27.9 MiB |
| This revision, glass disabled (test only) | 16.1 MiB | 25.6 MiB |

Native Liquid Glass accounts for about 2.6 MiB that AppKit keeps after the first opening. App icons cost no measurable memory. CPU stayed at 0.0% while closed.

# Earlier verification — 31 October 2026

## Usage insights revision (Direction C)

The popover now groups processes into pinned, active and idle apps, shows CPU/memory summary cards and per-app sparklines, and has an app details page. The window is 436 logical pixels wide and capped at 70% of the usable screen height, up to 680 pixels; only the list scrolls.

- `cargo test`: 6 tests passed, including a new check that task CPU time is converted from Mach ticks to nanoseconds (300 ms of busy work must read as at least 250 ms). Before this revision, CPU % on Apple Silicon read about 40× too low.
- `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`: passed. TypeScript type check and Vite build: passed (24.9 kB JS, 16.8 kB CSS before compression).
- A one-off native scan of this Mac listed 19 processes with plausible CPU (an actively rebuilding Vite server near 83%, idle Node servers near 0%), resident memory and uptimes. Two Node servers up for over a day with near-zero lifetime CPU were reported idle since start, as designed.
- Per-app CPU was compared with macOS `top` over the same four-second window for 16 listening processes; every value matched within 0.2 points (for example Vite 0.9% vs 0.7%, `hex` 1.7% vs 1.6%). The summary card used to add these one-core percentages and label the sum "CPU", which read like whole-Mac usage (6.5% here, really 0.6% of 11 cores). It now divides by the logical core count and is labelled "CPU of Mac".
- Browser demo (`?demo`, `?demo&dense`, light and dark): list capped and scrolling with sticky section headings at a 1000px-tall viewport; sorting; type-to-search; Stop all idle (5 apps, 937 MB) then summary update; search-scoped Stop all idle; pin and unpin from details; details chart, memory trend, ports with Open/Copy; settings with idle threshold.
- `npm run tauri build`: produced a signed (ad hoc) ARM64 `PortKiller.app`, 3.41 MiB. The native popover itself was not clicked through in this revision.

# Earlier verification — 29 October 2026

## Compact single-line revision

The current interface uses one 28px row per port, showing only port number, application/project, and Stop. Resource statistics and expandable detail panels have been removed. The native window is capped at half the active display's usable height and at most 440 logical pixels, including its outer padding.

A development fixture with 21 ports was checked at desktop and narrow widths. All rows measured 28px and names stayed on one line. At a 720px browser viewport, the panel measured 338px plus 22px outer padding. At 320×640, the panel measured 298px plus padding, with no horizontal overflow. Scroll offset remained at 228px across a refresh. Stopping the sample process using port 9229 disclosed both 3000 and 9229 and removed both rows, reducing 21 rows to 19. Option-click selected the Force quit confirmation.

The revised production frontend is 8.47 kB JavaScript and 6.64 kB CSS before compression. Type checking, Clippy, and the signed release build were rerun for this revision. The remaining sections describe the initial implementation's verification.

Tested on Apple Silicon, macOS 27.0.1, using Rust 1.99.0 and Node.js 26.3.0.

## Checks

- TypeScript type check and Vite production build: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 5 tests passed. The native test starts two real local TCP servers, verifies discovery, rejects a stale identity and a changed port set, stops the target, and confirms its neighbor remains running. Other tests cover IPv6/socket deduplication, system executable filtering, and protected PID rejection.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- Rust formatting: applied with `cargo fmt`.
- `npm run tauri build`: produced an ARM64 `PortKiller.app`, approximately 5.0 MiB.
- `codesign --verify --deep --strict` on the final app: passed. The bundle is signed ad hoc for local use and is not notarized for public distribution.
- Production JavaScript: 10.22 kB (4.31 kB gzip). CSS: 7.99 kB (2.30 kB gzip). The development demo adapter and its sample projects are absent from production assets.

## Interface

The native release was launched and displayed the machine's actual listeners. macOS services such as Control Center and rapportd were absent, while user development servers, PostgreSQL, and user application listeners appeared. Native display scaling was checked after changing sizing to logical pixels.

The browser development preview was used to check the approved colors, expanded process details, and the stop confirmation. Confirming a sample process with two ports reduced the count from five to three. Real process termination was independently tested by the native test above.

Native UI automation repeatedly lost the popover when desktop focus changed, so an automated native click-through of every control was not completed. Losing focus destroys the popover as intended. Launch-at-login changes were not enabled during testing; the control uses the Tauri autostart plugin and reports OS errors.

## Memory observations

Measurements are snapshots from this Mac, not a fixed RAM guarantee:

| State | Main process physical footprint | CPU |
| --- | --- | --- |
| Tray only, before opening a popover | 15.7 MiB | 0.0% |
| Idle after opening/dismissing several times | 25.3 MiB | 0.0% |
| Final release after opening/dismissing | 25.7 MiB (27.6 MiB peak) | 0.0% |

Footprint was read using `vmmap -summary`; CPU and RSS were inspected with `ps`. RSS includes resident shared-framework pages and is not directly comparable to physical footprint. These figures are for the main process, not the sum of all WebKit helpers.

Closing the popover removed its WebContent process. GPU helper teardown can be delayed, and WebKit's small Networking helper can remain resident. No periodic scan worker or frontend timer remains after the webview is destroyed. The menu bar count intentionally retains the last observed value until the next open.

## Local toolchain note

This machine's Rust toolchain lacks the LLVM library used by `rust-objcopy`. Cargo printed a non-fatal stripping warning during release builds; compilation, bundling, signing, and subsequent launch succeeded. No toolchain settings were changed.
