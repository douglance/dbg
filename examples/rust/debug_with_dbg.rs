use std::env;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread::sleep;
use std::time::Duration;

const DEFAULT_DBG_SOCK: &str = "/tmp/dbg-rust.sock";
const DEFAULT_DBG_EVENTS_DB: &str = "/tmp/dbg-rust-events.db";
const COMMAND_READ_TIMEOUT: Duration = Duration::from_secs(20);
const COMMAND_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_RETRY_ATTEMPTS: usize = 3;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const PAUSE_WAIT_POLLS: usize = 60; // 15 seconds at 250ms

#[derive(Clone, Debug)]
struct RunConfig {
    workspace_root: PathBuf,
    dbg_sock: String,
    dbg_events_db: String,
    target_src: PathBuf,
    target_bin: PathBuf,
}

fn main() {
    let config = parse_config();

    if let Err(error) = run(config.clone()) {
        eprintln!("error: {error}");
        eprintln!(
            "hint: on macOS, if LLDB attach is denied, grant Terminal/your shell Developer Tools access and retry"
        );
        let _ = close_session(&config, false);
        std::process::exit(1);
    }
}

fn run(config: RunConfig) -> Result<(), String> {
    cleanup_old_state(&config)?;

    compile_target(&config)?;
    ensure_daemon_running(&config)?;

    run_command_retry(
        &config,
        "attach-lldb",
        &json_attach_lldb(config.target_bin.to_string_lossy().as_ref()),
    )?;
    let attach_status = wait_for_status(&config, "post-attach")?;
    println!("post-attach status: {attach_status}");

    run_command_retry(
        &config,
        "frames",
        r#"{"cmd":"q","args":"SELECT function, file, line FROM frames LIMIT 5"}"#,
    )?;

    let threads = run_command_retry(
        &config,
        "threads",
        r#"{"cmd":"q","args":"SELECT id, name FROM threads LIMIT 5"}"#,
    )?;
    if threads.contains(r#""rows":[]"#) {
        return Err("thread query succeeded but returned no threads".to_string());
    }

    ensure_paused(&config)?;
    run_command_retry(&config, "step-over", r#"{"cmd":"n"}"#)?;
    let post_step_status = wait_for_status(&config, "post-step")?;
    println!("post-step status: {post_step_status}");

    run_command_retry(&config, "trace", r#"{"cmd":"trace","args":"5"}"#)?;

    close_session(&config, true)?;

    println!("done: dbg self-check sequence completed");
    Ok(())
}

fn parse_config() -> RunConfig {
    let workspace_root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let target_src = env::var("RUST_DEBUG_TARGET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("examples/rust/target.rs"));

    let target_bin = env::var("RUST_DEBUG_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/dbg-rust-target"));

    RunConfig {
        workspace_root,
        dbg_sock: env::var("DBG_SOCK").unwrap_or_else(|_| DEFAULT_DBG_SOCK.to_string()),
        dbg_events_db: env::var("DBG_EVENTS_DB")
            .unwrap_or_else(|_| DEFAULT_DBG_EVENTS_DB.to_string()),
        target_src,
        target_bin,
    }
}

fn cleanup_old_state(config: &RunConfig) -> Result<(), String> {
    let _ = fs::remove_file(&config.dbg_sock);
    for suffix in ["", "-wal", "-shm"] {
        let path = format!("{}{}", config.dbg_events_db, suffix);
        let _ = fs::remove_file(path);
    }

    // Best-effort close in case a stale daemon is still reachable.
    let _ = close_session(config, false);
    Ok(())
}

fn compile_target(config: &RunConfig) -> Result<(), String> {
    if !config.target_src.exists() {
        return Err(format!(
            "target source not found: {}",
            config.target_src.to_string_lossy()
        ));
    }

    let output = Command::new("rustc")
        .arg("-g")
        .arg(&config.target_src)
        .arg("-o")
        .arg(&config.target_bin)
        .output()
        .map_err(|e| format!("failed to invoke rustc: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "rustc failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    println!("compiled target: {}", config.target_bin.to_string_lossy());
    Ok(())
}

fn ensure_daemon_running(config: &RunConfig) -> Result<(), String> {
    let output = run_cli(config, ["status"])?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            println!("daemon status: {}", stdout.trim());
        }
        return Ok(());
    }

    Err(format!(
        "failed to start dbg daemon:\n{}",
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn run_command_retry(config: &RunConfig, label: &str, json_line: &str) -> Result<String, String> {
    println!("===== {label} =====");
    println!("request: {json_line}");

    let mut last_error = String::new();
    for attempt in 1..=COMMAND_RETRY_ATTEMPTS {
        let response = send_socket_command(&config.dbg_sock, json_line)?;
        println!("response[{attempt}/{COMMAND_RETRY_ATTEMPTS}]: {response}");

        if response_ok(&response) {
            return Ok(response);
        }

        last_error = response;
        if attempt < COMMAND_RETRY_ATTEMPTS {
            sleep(POLL_INTERVAL);
        }
    }

    Err(format!("command '{label}' failed after retries: {last_error}"))
}

fn send_socket_command(socket_path: &str, json_line: &str) -> Result<String, String> {
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|e| format!("connect {socket_path} failed: {e}"))?;
    stream
        .set_read_timeout(Some(COMMAND_READ_TIMEOUT))
        .map_err(|e| format!("failed to set socket read timeout: {e}"))?;
    stream
        .set_write_timeout(Some(COMMAND_WRITE_TIMEOUT))
        .map_err(|e| format!("failed to set socket write timeout: {e}"))?;

    stream
        .write_all(format!("{json_line}\n").as_bytes())
        .map_err(|e| format!("write to socket failed: {e}"))?;

    let mut line = String::new();
    let mut reader = BufReader::new(stream);
    reader
        .read_line(&mut line)
        .map_err(|e| match e.kind() {
            ErrorKind::TimedOut | ErrorKind::WouldBlock => {
                format!("timeout waiting for daemon response on {socket_path}")
            }
            _ => format!("read from socket failed: {e}"),
        })?;

    if line.trim().is_empty() {
        return Err("daemon closed socket without a response".to_string());
    }

    Ok(line.trim().to_string())
}

fn close_session(config: &RunConfig, verbose: bool) -> Result<(), String> {
    if !Path::new(&config.dbg_sock).exists() {
        return Ok(());
    }
    if verbose {
        println!("===== close =====");
    }
    let response = send_socket_command(&config.dbg_sock, r#"{"cmd":"close"}"#)?;
    if verbose {
        println!("response: {response}");
    }
    Ok(())
}

fn wait_for_status(config: &RunConfig, label: &str) -> Result<String, String> {
    println!("===== {label} =====");
    for attempt in 1..=PAUSE_WAIT_POLLS {
        let response = send_socket_command(&config.dbg_sock, r#"{"cmd":"status"}"#)?;
        println!("status[{attempt}/{PAUSE_WAIT_POLLS}]: {response}");
        if response_ok(&response) && response.contains(r#""connected":true"#) {
            return Ok(response);
        }
        sleep(POLL_INTERVAL);
    }

    Err(format!(
        "status did not reach connected=true within {}s",
        PAUSE_WAIT_POLLS as f64 * POLL_INTERVAL.as_secs_f64()
    ))
}

fn ensure_paused(config: &RunConfig) -> Result<(), String> {
    println!("===== wait-paused =====");
    for attempt in 1..=PAUSE_WAIT_POLLS {
        let status = send_socket_command(&config.dbg_sock, r#"{"cmd":"status"}"#)?;
        println!("pause-check[{attempt}/{PAUSE_WAIT_POLLS}]: {status}");
        if response_ok(&status) && status.contains(r#""status":"paused""#) {
            return Ok(());
        }
        if response_ok(&status) && status.contains(r#""status":"running""#) {
            let pause_response = send_socket_command(&config.dbg_sock, r#"{"cmd":"pause"}"#)?;
            println!("pause-request: {pause_response}");
        }
        sleep(POLL_INTERVAL);
    }

    Err(format!(
        "session did not become paused within {}s",
        PAUSE_WAIT_POLLS as f64 * POLL_INTERVAL.as_secs_f64()
    ))
}

fn response_ok(response: &str) -> bool {
    response.contains(r#""ok":true"#)
}

fn run_cli<I, S>(config: &RunConfig, args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let cli_path = config.workspace_root.join("packages/cli/dist/cli.js");
    if !cli_path.exists() {
        return Err(format!(
            "missing CLI build artifact: {} (run `pnpm build` first)",
            cli_path.to_string_lossy()
        ));
    }

    let mut command = Command::new("node");
    command
        .arg(&cli_path)
        .current_dir(&config.workspace_root)
        .env("DBG_SOCK", &config.dbg_sock)
        .env("DBG_EVENTS_DB", &config.dbg_events_db);

    for arg in args {
        command.arg(arg.as_ref());
    }

    command
        .output()
        .map_err(|e| format!("failed to execute node CLI: {e}"))
}

fn json_attach_lldb(path: &str) -> String {
    format!(
        "{{\"cmd\":\"attach-lldb\",\"args\":\"{}\"}}",
        json_escape(path)
    )
}

fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let code = c as u32;
                out.push_str(&format!("\\u{:04x}", code));
            }
            c => out.push(c),
        }
    }
    out
}

#[allow(dead_code)]
fn _is_executable(path: &Path) -> bool {
    path.exists()
}
