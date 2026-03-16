//! SuperEye CLI — --stdio JSON-RPC 模式

#![cfg(windows)]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--stdio" {
        supereye::ipc::run_stdio_loop();
    } else {
        eprintln!("SuperEye daemon. Usage: supereye --stdio");
        eprintln!("  --stdio    stdin/stdout JSON-RPC mode");
        std::process::exit(1);
    }
}
