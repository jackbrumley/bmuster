//! An exec session: one command, its output as frames, then `exec-done`
//! (SPEC-COMMANDS). Each output frame is one byte naming the stream
//! (`EXEC_STDOUT` or `EXEC_STDERR`) followed by the bytes. The browser side
//! sends nothing; anything it sends is ignored.

use super::pump::{pump, Ended, Outgoing};
use crate::exec::pipe::{self, Limits, Stream};
use crate::exec::placement::Placement;
use crate::exec::spawn::{agent_account, command_line, environment, Launch};
use crate::socket::Socket;
use anyhow::Result;
use bmuster_protocol::session::{SessionEvent, Shell, EXEC_STDERR, EXEC_STDOUT};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

/// Frames waiting for the socket before the command's output waits too.
const OUTPUT_QUEUE: usize = 16;

/// What to run.
pub struct Request<'a> {
    pub shell: Shell,
    pub command: &'a str,
    pub limits: Limits,
    /// The console user's name, for `BMUSTER_USER`.
    pub console_user: &'a str,
}

/// Prepares the command. Errors here are reported to the console as `failed`.
pub fn prepare(request: &Request<'_>) -> Result<Launch> {
    let account = agent_account();
    let program = command_line(request.shell, request.command)?;
    let env = environment(&account, &program, request.console_user, false);
    Ok(Launch {
        program,
        env,
        cwd: account.home,
    })
}

/// Runs the command over `socket` until it is done, the server ends the
/// session, or `stop`.
pub fn run(
    socket: &mut Socket,
    launch: Launch,
    placement: Placement,
    limits: Limits,
    stop: &AtomicBool,
) -> Result<Ended> {
    let (output, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let cancelled = Arc::new(AtomicBool::new(false));
    let runner = {
        let cancelled = Arc::clone(&cancelled);
        std::thread::Builder::new()
            .name("exec".into())
            .spawn(move || {
                let outcome =
                    pipe::run(&launch, &placement, limits, &cancelled, |stream, bytes| {
                        let mut frame = Vec::with_capacity(bytes.len() + 1);
                        frame.push(match stream {
                            Stream::Stdout => EXEC_STDOUT,
                            Stream::Stderr => EXEC_STDERR,
                        });
                        frame.extend_from_slice(bytes);
                        let _ = output.send(Outgoing::Bytes(frame));
                    });
                let event = match outcome {
                    Ok(done) => SessionEvent::ExecDone {
                        exit_code: done.exit_code,
                        duration_ms: u64::try_from(done.duration.as_millis()).unwrap_or(u64::MAX),
                        truncated: done.truncated,
                        timed_out: done.timed_out,
                    },
                    Err(e) => SessionEvent::Failed {
                        message: format!("{e:#}"),
                    },
                };
                let _ = output.send(Outgoing::Done(event));
            })?
    };
    let ended = pump(socket, &outgoing, stop, || true, |_| Ok(()));
    // Ended early (the console or the agent stopping): the command goes too.
    cancelled.store(true, Ordering::SeqCst);
    drop(outgoing);
    if runner.join().is_err() {
        log::error!("the exec thread failed");
    }
    ended
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use std::time::Duration;

    #[test]
    fn output_frames_name_their_stream_and_the_result_comes_last() {
        let (mut client, server) = socket_pair();
        let request = Request {
            shell: Shell::Sh,
            command: "echo out; echo err >&2; exit 4",
            limits: Limits {
                timeout: Duration::from_secs(20),
                max_output_bytes: 1024,
            },
            console_user: "tester",
        };
        let launch = prepare(&request).unwrap();
        let limits = request.limits;
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            run(&mut client, launch, Placement::InProcess, limits, &stop).unwrap()
        });
        let mut server = Server::new(server);
        let done = server.wait_for_text();
        let output = server.output();
        assert!(output.windows(4).any(|w| w == b"\x01out"), "{output:?}");
        assert!(output.windows(4).any(|w| w == b"\x02err"), "{output:?}");
        let event: serde_json::Value = serde_json::from_str(&done).unwrap();
        assert_eq!(event["type"], "exec-done");
        assert_eq!(event["exitCode"], 4);
        assert_eq!(event["timedOut"], false);
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }
}
