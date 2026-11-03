# PortKiller

## Commits and pull requests

- Never add AI attribution: no `Co-Authored-By: Claude …` trailer, no "Generated with Claude Code" line, no session links. Commits are authored by the maintainer only.
- `.githooks/commit-msg` strips such lines as a safety net; enable it with `git config core.hooksPath .githooks`.

## Design

- Keep it as simple as Linear or Apple Notes: icon, name and port in the list; details one click away. No taglines, helper text or secondary labels — if a screen needs them, fix the layout.
- Every change should help users, developers and agents at once, and must not weaken the stop safety checks (owner, start time and full port set are revalidated in Rust before every stop).

## Code

- Platform differences live only in `src-tauri/src/platform/` (`macos.rs`, `windows.rs`) behind the same functions; everything else is shared.
- Before committing: `npm run build`, and in `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
