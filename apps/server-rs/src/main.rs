use omega_server::config::{Env, env_from_os, parse_config};
use omega_server::serve::serve;
use std::process::ExitCode;

const USAGE: &str = "usage: omega-server [serve]";

fn main() -> ExitCode {
    let command = std::env::args_os().nth(1);
    match command.as_ref().map(|c| c.to_str()) {
        None | Some(Some("serve")) => run_serve(),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn run_serve() -> ExitCode {
    let env: Env = match env_from_os(std::env::vars_os()) {
        Ok(env) => env,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::FAILURE;
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("working directory: {err}");
            return ExitCode::FAILURE;
        }
    };
    let config = match parse_config(&env, &cwd) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::FAILURE;
        }
    };
    if config.public_origin.is_some() && !config.trust_proxy {
        eprintln!("PUBLIC_ORIGIN is set without TRUST_PROXY=loopback: all tunnelled clients will share one rate-limit bucket");
    }
    if !["127.0.0.1", "::1", "localhost"].contains(&config.hostname.as_str()) {
        eprintln!(
            "HOST={} is not loopback: the server is reachable without the tunnel (ADR 0015 §3)",
            config.hostname
        );
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    let served = runtime.block_on(serve(config));
    // Connections past the drain deadline are cut here rather than awaited.
    runtime.shutdown_timeout(std::time::Duration::from_millis(500));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("serve: {err}");
            ExitCode::FAILURE
        }
    }
}
