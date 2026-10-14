use omega_server::cli::{Io, run_cli};
use omega_server::config::{Env, admin_socket_for, env_from_os, parse_config};
use omega_server::log::{stderr_line, stdout_line};
use omega_server::serve::{ServeError, serve};
use std::process::ExitCode;

const USAGE: &str = "usage: omega-server [serve | admin <verb> ... | backup <verb> ...]";

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let command = args.next();
    // Arguments that are not UTF-8 cannot be ids, files we were told to read, or verbs: usage.
    let rest: Option<Vec<String>> = args.map(|a| a.into_string().ok()).collect();
    match (command.as_ref().map(|c| c.to_str()), rest) {
        (None | Some(Some("serve")), _) => run_serve(),
        (Some(Some("admin")), Some(rest)) => run_admin(&rest),
        (Some(Some("backup")), Some(rest)) => run_backup(&rest),
        _ => {
            stderr_line(USAGE);
            ExitCode::from(2)
        }
    }
}

/// `omega-server admin <verb> ...`: the operator CLI, over the admin socket only.
fn run_admin(args: &[String]) -> ExitCode {
    let env: Env = match env_from_os(std::env::vars_os()) {
        Ok(env) => env,
        Err(err) => {
            stderr_line(&err.to_string());
            return ExitCode::from(2);
        }
    };
    let Ok(cwd) = std::env::current_dir() else {
        stderr_line("working directory: unavailable");
        return ExitCode::FAILURE;
    };
    let code = run_cli(
        args,
        &mut Io {
            env: &env,
            cwd: &cwd,
            out: &mut |line| stdout_line(line),
            err: &mut |line| stderr_line(line),
        },
    );
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// `omega-server backup <verb> ...`: snapshots and restores of `DB_PATH` (`BACKUP_DIR` for the snapshots).
fn run_backup(args: &[String]) -> ExitCode {
    let env: Env = ["DB_PATH", "BACKUP_DIR"]
        .into_iter()
        .filter_map(|key| Some((key.to_owned(), std::env::var(key).ok()?)))
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let code = omega_server::backup::run_backup(args, &env, now, &mut |line| stdout_line(line), &mut |line| stderr_line(line));
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// Worker threads of the release runtime (PORTING.md "Performance"). Two is the measured default: one thread (the
/// current-thread scheduler) matches Bun's CPU but not its tail latency under bursts; a thread per core costs
/// 1.3-2x the CPU of two for no latency gain. `OMEGA_WORKER_THREADS=1` selects the current-thread scheduler.
#[cfg(not(feature = "test-hooks"))]
fn worker_threads(raw: Option<&str>) -> Option<usize> {
    match raw {
        None => Some(2),
        Some(n) => n.parse().ok().filter(|n| *n >= 1),
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
    let admin_socket = match admin_socket_for(&env, &cwd) {
        Ok(socket) => socket,
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
    omega_server::test_hooks::stop_when_stdin_closes();
    #[cfg(feature = "test-hooks")]
    let mut builder = tokio::runtime::Builder::new_current_thread();
    #[cfg(not(feature = "test-hooks"))]
    let mut builder = match worker_threads(std::env::var("OMEGA_WORKER_THREADS").ok().as_deref()) {
        Some(1) => tokio::runtime::Builder::new_current_thread(),
        Some(n) => {
            let mut b = tokio::runtime::Builder::new_multi_thread();
            b.worker_threads(n);
            b
        }
        None => {
            stderr_line("invalid OMEGA_WORKER_THREADS: expected a whole number of at least 1");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match builder.enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            stderr_line(&format!("runtime: {err}"));
            return ExitCode::FAILURE;
        }
    };
    let served = runtime.block_on(serve(config, admin_socket));
    // Connections past the drain deadline are cut here rather than awaited.
    runtime.shutdown_timeout(std::time::Duration::from_millis(500));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        // The shutdown already logged what went wrong.
        Err(ServeError::Logged) => ExitCode::FAILURE,
        Err(err) => {
            stderr_line(&err.to_string());
            ExitCode::FAILURE
        }
    }
}

#[cfg(all(test, not(feature = "test-hooks")))]
mod tests {
    use super::worker_threads;

    #[test]
    fn worker_threads_defaults_to_two_and_takes_whole_numbers_from_one() {
        assert_eq!(worker_threads(None), Some(2));
        assert_eq!(worker_threads(Some("1")), Some(1));
        assert_eq!(worker_threads(Some("8")), Some(8));
        for bad in ["0", "", "-1", "two", "1.5"] {
            assert_eq!(worker_threads(Some(bad)), None, "{bad}");
        }
    }
}
