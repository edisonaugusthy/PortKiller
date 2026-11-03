# Contributing to PortKiller

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an issue with the **Bug report** or **Feature request** form. For bugs, the most useful details are your OS and version, the PortKiller version (the release you installed), what you did and what happened. Screenshots help.

Security problems — anything that could stop a process it should not, or run code — go to [SECURITY.md](SECURITY.md), not a public issue.

## Working on the code

```sh
npm install
npm run tauri dev                 # the real app
npm run dev                       # browser preview: http://127.0.0.1:1420/?demo
git config core.hooksPath .githooks
```

The browser preview takes `&windows`, `&theme=dark`, `&dense`, `&empty` and `&update`, so most interface work needs neither a real process list nor Windows.

- **Interface:** `src/main.ts` renders everything as plain HTML strings; `src/style.css` holds every color for both themes and both platforms.
- **Shared Rust:** `src-tauri/src/scanner.rs` (grouping, CPU and idle, stop validation) and `ports.rs` (tray, window, settings, updates).
- **Platform Rust:** only `src-tauri/src/platform/macos.rs` and `windows.rs` differ between systems. Keep new OS-specific code there, behind the same function names.

## Before you open a pull request

```sh
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI runs the same checks on macOS and Windows.

Please keep changes in the spirit of the project:

- **Simple.** Fewer elements and fewer words. No taglines, helper text or secondary labels; if a screen needs them, change the layout.
- **Safe.** Never weaken the checks before a stop (owner, start time, exact port set). Stopping must always be confirmed.
- **Light.** No background timers, no new runtime dependencies without a good reason, nothing loaded from the network except the update check.

Write commit messages in the imperative ("Add …", "Fix …") with a short body explaining why. Commits should not carry AI co-author trailers; the hook in `.githooks/` removes them.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
