mod config;
mod launch;
mod mounts;
mod runtime;
mod socket;
mod spec;

fn main() {
    if let Err(err) = launch::run() {
        eprintln!("[sandbox] launch failed: {err}");
        std::process::exit(1);
    }
}
