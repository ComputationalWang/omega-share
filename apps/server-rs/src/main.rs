use omega_server::config::{Env, env_from_os, parse_config};
use omega_server::log::stderr_line;
use omega_server::serve::serve;
use std::process::ExitCode;

const USAGE: &str = "usage: omega-server [serve]";

fn main() -> ExitCode {
    let command = std::env::args_os().nth(1);
    match command.as_ref().map(|c| c.to_str()) {
        None | Some(Some("serve")) => run_serve(),
        _ => {
            stderr_line(USAGE);
            ExitCode::from(2)
        }
    }
}

fn run_serve() -> ExitCode {
    let env: Env = match env_from_os(std::env::vars_os()) {
        Ok(env) => env,
        Err(err) => {
            stderr_line(&err.to_string());
            return ExitCode::FAILURE;
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            stderr_line(&format!("working directory: {err}"));
            return ExitCode::FAILURE;
        }
    };
    let config = match parse_config(&env, &cwd) {
        Ok(config) => config,
        Err(err) => {
            stderr_line(&err.to_string());
            return ExitCode::FAILURE;
        }
    };
    if config.public_origin.is_some() && !config.trust_proxy {
        stderr_line("PUBLIC_ORIGIN is set without TRUST_PROXY=loopback: all tunnelled clients will share one rate-limit bucket");
    }
    if !["127.0.0.1", "::1", "localhost"].contains(&config.hostname.as_str()) {
        stderr_line(&format!(
            "HOST={} is not loopback: the server is reachable without the tunnel (ADR 0015 §3)",
            config.hostname
        ));
    }
    // The black-box suite needs `POST /__test/time` to know a woken task's work is done, which only
    // holds on one thread (see test_hooks.rs); the default and release builds stay multi-thread.
    #[cfg(feature = "test-hooks")]
    let mut builder = tokio::runtime::Builder::new_current_thread();
    #[cfg(not(feature = "test-hooks"))]
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    #[cfg(feature = "test-hooks")]
    omega_server::test_hooks::stop_when_stdin_closes();
    let runtime = match builder.enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            stderr_line(&format!("runtime: {err}"));
            return ExitCode::FAILURE;
        }
    };
    let served = runtime.block_on(serve(config));
    // Connections past the drain deadline are cut here rather than awaited.
    runtime.shutdown_timeout(std::time::Duration::from_millis(500));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            stderr_line(&err.to_string());
            ExitCode::FAILURE
        }
    }
}
