//! Everything that differs between operating systems, behind one small set of functions:
//! `listeners`, `identity`, `resources`, `read_details`, `signal`, `icon_source`, `icon_png`
//! and `open_url`. The rest of PortKiller is shared.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(any(target_os = "macos", windows)))]
compile_error!("PortKiller supports macOS and Windows.");
