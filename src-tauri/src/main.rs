// No console window behind the tray app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
mod ports;
mod scanner;

fn main() {
    ports::run();
}
