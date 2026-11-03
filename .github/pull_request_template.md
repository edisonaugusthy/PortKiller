## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was checked

- [ ] `npm run build`
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri/`
- [ ] Tried in the app or the browser demo (`/?demo`, `&windows`, `&theme=dark`); screenshots attached for visible changes

## Safety

- [ ] Does not weaken the checks before a stop (owner, start time, exact port set)
