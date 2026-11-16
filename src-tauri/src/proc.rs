//! One place where a child process gets a deadline.
//!
//! Every CLI this app shells out to (docker, colima, podman, limactl, kubectl, brew, find)
//! can wedge: a suspended VM leaves the socket answering TCP and never replying, a daemon
//! mid-upgrade holds the API open, `colima ssh` waits on a boot that never finishes.
//! `Command::output()` waits for EOF with no bound, so one wedged child parks its caller
//! forever — and because the blocking pool is finite, enough of them park the whole command
//! surface and the window needs a force quit.
//!
//! The limits below are deliberately generous (a list that takes twenty seconds is already
//! broken) so that a slow-but-working machine never sees a timeout, while a wedged one gets
//! an error the UI can render instead of a spinner that never resolves.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// A list, a status, an inspect, a log tail: nothing legitimate comes near this.
pub const READ_LIMIT: Option<Duration> = Some(Duration::from_secs(20));
/// A start/stop/remove/prune: the engine may need a while, but never two minutes of nothing.
pub const ACTION_LIMIT: Option<Duration> = Some(Duration::from_secs(120));
/// Pulls, `colima start`, `podman machine init`: minutes of real work with no progress
/// output, so a deadline here would kill legitimate downloads. These stay unbounded.
pub const NO_LIMIT: Option<Duration> = None;

/// stdout and stderr as text, plus the exit status. Lossy on purpose: the clients print
/// UTF-8 in practice and a stray byte must not turn a list into an error.
#[derive(Debug)]
pub struct Captured {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Why a child produced no output. Callers map these onto their own vocabulary (a missing
/// optional binary is not an error, a timeout always is).
#[derive(Debug)]
pub enum ProcError {
    /// The binary itself could not be started.
    Spawn(std::io::Error),
    /// The child outlived its deadline and was killed. `detail` is its first stderr line.
    Timeout { label: String, limit: Duration, detail: String },
    /// The OS could not report the child's status.
    Wait { label: String, source: std::io::Error },
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcError::Spawn(e) => write!(f, "failed to spawn: {e}"),
            ProcError::Timeout { label, limit, detail } => {
                let seconds = limit.as_secs_f32().round().max(1.0) as u64;
                if detail.is_empty() {
                    write!(f, "{label} did not answer within {seconds}s")
                } else {
                    write!(f, "{label} did not answer within {seconds}s: {detail}")
                }
            }
            ProcError::Wait { label, source } => write!(f, "failed to wait for {label}: {source}"),
        }
    }
}

impl ProcError {
    /// True when the binary is simply not installed, which optional tooling reads as absence.
    pub fn is_missing(&self) -> bool {
        matches!(self, ProcError::Spawn(e) if e.kind() == std::io::ErrorKind::NotFound)
    }
}

/// Runs the command to completion or to `limit`, whichever comes first.
///
/// Both pipes are drained on their own threads: a child that fills a 64 KiB pipe buffer
/// blocks on write, and a parent that waits for exit before reading would deadlock on the
/// exact large outputs (a 300-row `docker ps`, an inspect dump) this app asks for.
pub fn run(cmd: &mut Command, limit: Option<Duration>) -> Result<Captured, ProcError> {
    let label = program_label(cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(ProcError::Spawn)?;
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(source) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = collected(stdout);
                let _ = collected(stderr);
                return Err(ProcError::Wait { label, source });
            }
        }
        if let Some(limit) = limit {
            if started.elapsed() >= limit {
                // Kill, then reap: the readers only see EOF once the child is gone.
                let _ = child.kill();
                let _ = child.wait();
                let err = collected(stderr).unwrap_or_default();
                let _ = collected(stdout);
                let detail = first_line(&String::from_utf8_lossy(&err));
                return Err(ProcError::Timeout { label, limit, detail });
            }
        }
        // Cheap while a fast command finishes; capped so a long pull costs no measurable CPU.
        thread::sleep(Duration::from_millis(if started.elapsed() < Duration::from_millis(200) { 2 } else { 25 }));
    };

    let out = collected(stdout).unwrap_or_default();
    let err = collected(stderr).unwrap_or_default();
    Ok(Captured {
        success: status.map(|s| s.success()).unwrap_or(false),
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
    })
}

fn drain<R: Read + Send + 'static>(mut pipe: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    })
}

/// A panicked reader thread loses its bytes but must not propagate: the deadline already
/// decided the outcome.
fn collected(handle: Option<thread::JoinHandle<Vec<u8>>>) -> Option<Vec<u8>> {
    handle.and_then(|h| h.join().ok())
}

fn program_label(cmd: &Command) -> String {
    let program = cmd.get_program().to_string_lossy().into_owned();
    // The full path is noise in a UI sentence; the file name is what the user typed.
    program.rsplit('/').next().unwrap_or(&program).to_string()
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_stdout_and_success() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf hello"]);
        let out = run(&mut cmd, READ_LIMIT).expect("sh runs");
        assert!(out.success);
        assert_eq!(out.stdout, "hello");
    }

    #[test]
    fn reports_a_nonzero_exit_with_its_stderr() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf gone >&2; exit 3"]);
        let out = run(&mut cmd, READ_LIMIT).expect("sh runs");
        assert!(!out.success);
        assert_eq!(out.stderr, "gone");
    }

    #[test]
    fn drains_an_output_larger_than_a_pipe_buffer() {
        // 512 KiB: stdout alone would deadlock a wait-then-read parent.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "head -c 524288 /dev/zero | tr '\\0' 'x'"]);
        let out = run(&mut cmd, READ_LIMIT).expect("sh runs");
        assert_eq!(out.stdout.len(), 524288);
    }

    #[test]
    fn kills_a_child_that_outlives_its_limit() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        let began = Instant::now();
        let err = run(&mut cmd, Some(Duration::from_millis(150))).expect_err("sleep exceeds the limit");
        let message = err.to_string();
        assert!(message.contains("did not answer within"), "unexpected message: {message}");
        assert!(began.elapsed() < Duration::from_secs(5), "the deadline did not fire");
    }

    #[test]
    fn a_missing_binary_is_reported_as_missing() {
        let mut cmd = Command::new("runtime-desk-no-such-binary");
        let err = run(&mut cmd, READ_LIMIT).expect_err("spawn must fail");
        assert!(err.is_missing(), "not reported as missing: {err}");
    }
}
