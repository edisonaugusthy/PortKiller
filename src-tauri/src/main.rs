// No console window behind the tray app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod docker;
mod mcp;
mod platform;
mod ports;
mod scanner;

fn main() {
    // `portkiller list`, `free` and `mcp` run in the terminal and exit; anything else opens the menu bar app.
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(code) = cli::run(&args) {
        std::process::exit(code);
    }
    ports::run();
}
