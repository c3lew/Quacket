// Prevents the console window from flashing up alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    quacket_lib::run()
}
