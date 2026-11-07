//! The local page's routes. Every request passes the host check; every form
//! (POST) must come from the page itself; everything but sign-in, the
//! stylesheet and `/healthz` needs a session.

use super::actions::{self, MoveForm, MoveResult, Uninstall};
use super::gate::{same_origin, SignIn, COOKIE, MAX_SESSION_MS};
use super::http::{field, Request, Response};
use super::pages::{self, Row};
use super::Page;
use crate::inventory::{self, Probe};
use crate::logging;
use crate::status::RunMode;
use bmuster_protocol::{CodeOwners, LocalEvent};
use std::sync::Arc;
use std::time::SystemTime;

/// What to do once the reply has gone out.
#[derive(Debug, PartialEq, Eq)]
pub enum After {
    Nothing,
    Restart,
    RemoveDataAndStop,
}

use super::journal::now_ms;

fn session_cookie(token: &str) -> String {
    format!(
        "{COOKIE}={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
        MAX_SESSION_MS / 1000
    )
}

fn cleared_cookie() -> String {
    format!("{COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0")
}

fn html(status: u16, body: String) -> (Response, After) {
    (Response::html(status, body), After::Nothing)
}

pub fn handle(page: &Page, request: &Request) -> (Response, After) {
    let host = request.header("host");
    if !page.hosts.allows(host) {
        return (
            Response::text(
                421,
                "This page answers only at its own address, such as https://localhost:47500.",
            ),
            After::Nothing,
        );
    }
    let method = request.method.as_str();
    let path = request.path.as_str();
    match (method, path) {
        ("GET", "/healthz") => {
            return if page.board.healthy(SystemTime::now()) {
                (Response::text(200, "ok\n"), After::Nothing)
            } else {
                (Response::text(503, "not connected\n"), After::Nothing)
            };
        }
        ("GET", "/style.css") => {
            let mut css = pages::STYLE.to_string();
            css.push_str(&pages::bar_widths());
            return (Response::css(&css), After::Nothing);
        }
        _ => {}
    }
    if method == "POST" && !same_origin(request.header("origin"), host) {
        return (
            Response::text(
                403,
                "This form did not come from this page. Open the page again and retry.",
            ),
            After::Nothing,
        );
    }
    if method != "GET" && method != "POST" {
        return (Response::text(405, "Not allowed."), After::Nothing);
    }

    let now = now_ms();
    let token = request.cookie(COOKIE);
    if (method, path) == ("POST", "/sign-in") {
        return sign_in(page, request, now);
    }
    let Some(codes) = page.gate.session(token, now) else {
        return match (method, path) {
            ("GET", "/") => html(200, pages::sign_in(&hostname(), None)),
            ("GET", _) => (Response::redirect("/"), After::Nothing),
            _ => html(
                401,
                pages::sign_in(
                    &hostname(),
                    Some("You were signed out. Sign in again, then retry."),
                ),
            ),
        };
    };

    match (method, path) {
        ("GET", "/") => html(200, status_page(page, notice(request), &codes)),
        ("POST", "/sign-out") => {
            page.gate.sign_out(token, now);
            (
                Response::redirect("/").with_header("set-cookie", cleared_cookie()),
                After::Nothing,
            )
        }
        ("POST", "/check-in-now") => {
            page.send(crate::worker::Signal::CheckInNow);
            (Response::redirect("/?notice=check-in"), After::Nothing)
        }
        ("POST", "/test-connection") => {
            let steps = actions::test_connection(page);
            page.journal.record(LocalEvent::ConnectionTested {
                codes,
                passed: steps
                    .iter()
                    .all(|step| matches!(step.result, pages::StepResult::Pass(_))),
            });
            let body = pages::layout(
                "Test connection",
                true,
                &format!(
                    "{}{}",
                    pages::card(
                        &format!(
                            "Test connection to {}",
                            page.session.transport.server.base()
                        ),
                        &format!(
                            r#"{}<div class="actions"><form method="post" action="/test-connection"><button type="submit">Test again</button></form><a class="button" href="/">Back to the status page</a></div>"#,
                            pages::steps(&steps)
                        ),
                    ),
                    pages::log_card(&logging::recent_lines())
                ),
            );
            html(200, body)
        }
        ("POST", "/restart") => {
            page.journal.record(LocalEvent::Restarted { codes });
            (
                Response::html(
                    200,
                    pages::message("Restarting", &[restart_text(page.mode)], false),
                ),
                After::Restart,
            )
        }
        ("GET", "/move") => {
            let name = current_name(page);
            html(
                200,
                pages::move_form(
                    &page.session.transport.server.base(),
                    &pages::MoveForm {
                        url: "",
                        code: "",
                        pin: "",
                        name: &name,
                    },
                    None,
                ),
            )
        }
        ("POST", "/move") => move_machine(page, request, codes),
        ("GET", "/uninstall") => html(
            200,
            pages::uninstall_form(&actions::uninstall_explanation(page), None),
        ),
        ("POST", "/uninstall") => uninstall(page, request, codes),
        _ => (Response::text(404, "Not found."), After::Nothing),
    }
}

fn hostname() -> String {
    inventory::hostname().unwrap_or_else(|_| "this machine".into())
}

fn sign_in(page: &Page, request: &Request, now: u64) -> (Response, After) {
    let form = request.form();
    let problem = match page.gate.sign_in(field(&form, "code"), now) {
        SignIn::SignedIn { token } => {
            return (
                Response::redirect("/").with_header("set-cookie", session_cookie(&token)),
                After::Nothing,
            );
        }
        SignIn::Wrong { left } => (
            401,
            format!(
                "That code is not right. {left} more {} before sign-in pauses for 5 minutes.",
                if left == 1 { "try" } else { "tries" }
            ),
        ),
        SignIn::Paused { seconds } | SignIn::LockedOut { seconds } => (
            429,
            format!(
                "Too many wrong codes. Sign-in is paused; try again in {} minute{}.",
                seconds.div_ceil(60),
                if seconds.div_ceil(60) == 1 { "" } else { "s" }
            ),
        ),
        SignIn::AlreadyUsed => (
            401,
            "That code was just used. Wait for the next code (they change every 30 seconds)."
                .into(),
        ),
    };
    html(problem.0, pages::sign_in(&hostname(), Some(&problem.1)))
}

/// Only fixed notices; nothing from the address is shown back.
fn notice(request: &Request) -> Option<&'static str> {
    match field(&request.query_pairs(), "notice") {
        "check-in" => {
            Some("Asked the agent to check in now. Refresh in a few seconds to see the result.")
        }
        _ => None,
    }
}

fn restart_text(mode: RunMode) -> String {
    match mode {
        RunMode::Service => "The agent is restarting; the service manager starts it again in about 10 seconds. Then open this page again and sign in with a new code.".into(),
        RunMode::Foreground => "The agent is restarting in place (it was started by hand). Open this page again in a few seconds and sign in with a new code.".into(),
    }
}

fn current_name(page: &Page) -> String {
    page.board.snapshot().machine_name.unwrap_or_else(hostname)
}

fn move_machine(page: &Page, request: &Request, codes: CodeOwners) -> (Response, After) {
    let fields = request.form();
    let form = MoveForm {
        url: field(&fields, "url").to_string(),
        code: field(&fields, "code").to_string(),
        pin: field(&fields, "pin").to_string(),
        name: field(&fields, "name").to_string(),
    };
    match actions::move_machine(page, &form, &codes) {
        MoveResult::Moved(moved) => {
            let said = vec![
                format!(
                    "This machine joined {} as machine {}.",
                    moved.server_url, moved.machine_id
                ),
                actions::old_server_text(&moved.old_server),
                "The agent restarts now with its new identity. Then sign in again with a code from the new server's console (the old code no longer works).".into(),
            ];
            (
                Response::html(200, pages::message("Moved to another server", &said, false)),
                After::Restart,
            )
        }
        MoveResult::Failed(problem) => {
            let restart = crate::relocate::move_pending(&page.data_dir);
            let body = pages::move_form(
                &page.session.transport.server.base(),
                &pages::MoveForm {
                    url: &form.url,
                    code: &form.code,
                    pin: &form.pin,
                    name: &form.name,
                },
                Some(&problem),
            );
            (
                Response::html(422, body),
                if restart {
                    After::Restart
                } else {
                    After::Nothing
                },
            )
        }
    }
}

fn uninstall(page: &Page, request: &Request, codes: CodeOwners) -> (Response, After) {
    if field(&request.form(), "confirm") != "yes" {
        return html(
            422,
            pages::uninstall_form(
                &actions::uninstall_explanation(page),
                Some("Tick the box to confirm."),
            ),
        );
    }
    match actions::uninstall(page, codes) {
        Uninstall::Scheduled(said) => html(200, pages::message("Uninstalling", &said, false)),
        Uninstall::RemoveDataAndStop(said) => (
            Response::html(200, pages::message("Uninstalling", &said, false)),
            After::RemoveDataAndStop,
        ),
        Uninstall::Failed(problem) => html(
            500,
            pages::uninstall_form(&actions::uninstall_explanation(page), Some(&problem)),
        ),
    }
}

/// Sends waiting events on their own thread, so the page never waits for
/// the server. Whatever fails stays queued for the next check-in.
pub fn send_events_soon(page: &Page) {
    if !page.journal.pending() {
        return;
    }
    let session = Arc::clone(&page.session);
    let journal = Arc::clone(&page.journal);
    let spawned = std::thread::Builder::new()
        .name("local-page events".into())
        .spawn(move || {
            if let Err(e) = journal.send(&session) {
                log::debug!("Local page events wait for the next check-in: {e:#}");
            }
        });
    if spawned.is_err() {
        log::warn!("Local page: could not start a thread to send its events.");
    }
}

/// Runs once the reply is sent, so the browser sees it before the agent goes.
pub fn run_after(page: &Page, after: After) {
    send_events_soon(page);
    match after {
        After::Nothing => {}
        After::Restart => page.send(crate::worker::Signal::Restart),
        After::RemoveDataAndStop => {
            match std::fs::remove_dir_all(&page.data_dir) {
                Ok(()) => log::info!("Deleted {} (identity and key).", page.data_dir.display()),
                Err(e) => log::error!("Could not delete {}: {e}", page.data_dir.display()),
            }
            page.send(crate::worker::Signal::Stop);
        }
    }
}

fn status_page(page: &Page, notice: Option<&str>, codes: &CodeOwners) -> String {
    let now = SystemTime::now();
    let snapshot = page.board.snapshot();
    let healthy = page.board.healthy(now);
    let transport = &page.session.transport;
    let host = hostname();

    let connection = pages::rows(&[
        Row {
            label: "Status",
            html: if healthy {
                r#"<span class="badge ok">Connected</span>"#.into()
            } else {
                r#"<span class="badge bad">Not connected</span>"#.into()
            },
        },
        pages::row("Server", &transport.server.base()),
        pages::row(
            "Machine name",
            snapshot
                .machine_name
                .as_deref()
                .unwrap_or("(not known until the next check-in)"),
        ),
        pages::row("Machine id", &page.session.machine_id),
        pages::row(
            "Last check-in",
            &snapshot.last_check_in.map_or_else(
                || "none since the agent started".into(),
                |at| pages::when(at, now),
            ),
        ),
        pages::row(
            "Last error",
            &snapshot.last_error.as_ref().map_or_else(
                || "none".into(),
                |(at, message)| format!("{message} ({})", pages::ago(*at, now)),
            ),
        ),
        pages::row(
            "Live socket",
            if snapshot.socket_connected {
                "open"
            } else {
                "closed"
            },
        ),
        pages::row("Certificate check", &actions::describe(transport.check())),
        pages::row(
            "Check-in",
            &format!("every {} s", snapshot.check_in_seconds),
        ),
    ]);

    let listen = page
        .listen
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let mut agent_rows = vec![
        pages::row("Version", env!("CARGO_PKG_VERSION")),
        pages::row("Updates", "automatic updates are not part of this version"),
        pages::row(
            "Started by",
            match page.mode {
                RunMode::Service => "the service manager",
                RunMode::Foreground => "hand (not a service)",
            },
        ),
        pages::row("Data folder", &page.data_dir.display().to_string()),
        pages::row("Signed in with", &super::gate::whose_code(codes)),
        pages::row("This page", &listen),
        Row {
            label: "Page certificate",
            html: format!(
                r#"<span class="mono">SHA-256 {}</span>"#,
                pages::esc(&page.fingerprint)
            ),
        },
    ];
    if !page.hosts.loopback_only {
        agent_rows.push(pages::row(
            "Firewall",
            &format!(
                "BMuster does not change the firewall. Open TCP {} yourself if this page should be reachable from the network.",
                page.hosts.port
            ),
        ));
    }

    let machine = machine_card(page, &host);
    let notice = notice.map(pages::notice).unwrap_or_default();
    let body = format!(
        "{notice}{}{}{}{}{}",
        pages::card("Connection", &connection),
        pages::actions_card(),
        machine,
        pages::card("Agent", &pages::rows(&agent_rows)),
        pages::log_card(&logging::recent_lines()),
    );
    pages::layout(&format!("Status of {host}"), true, &body)
}

fn machine_card(page: &Page, host: &str) -> String {
    let mut probe = actions::lock_probe(page);
    let probe = probe.get_or_insert_with(Probe::new);
    let load = probe.load();
    let mut rows = vec![
        pages::row("Hostname", host),
        pages::row("CPU", &format!("{:.0}% in use", load.cpu_percent)),
    ];
    match probe.inventory() {
        Ok(inventory) => {
            rows.push(Row {
                label: "Memory",
                html: format!(
                    "{} of {} in use{}",
                    pages::bytes(load.memory_used_bytes),
                    pages::bytes(inventory.memory_total_bytes),
                    pages::usage_bar(load.memory_used_bytes, inventory.memory_total_bytes)
                ),
            });
            for disk in &inventory.disks {
                rows.push(Row {
                    label: "Disk",
                    html: format!(
                        "<span class=\"mono\">{}</span>: {} of {} used{}",
                        pages::esc(&disk.mount),
                        pages::bytes(disk.used_bytes),
                        pages::bytes(disk.size_bytes),
                        pages::usage_bar(disk.used_bytes, disk.size_bytes)
                    ),
                });
            }
        }
        Err(e) => rows.push(pages::row("Details", &format!("could not be read: {e:#}"))),
    }
    pages::card("This machine", &pages::rows(&rows))
}

#[cfg(test)]
mod tests {
    use super::super::gate::{Gate, Hosts};
    use super::super::journal::Journal;
    use super::super::people::People;
    use super::*;
    use crate::client::{Security, ServerUrl, Session, TlsMode, Transport};
    use crate::status::StatusBoard;
    use crate::totp;
    use bmuster_protocol::ServerTrust;
    use ed25519_dalek::SigningKey;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Mutex;

    const SECRET: &[u8] = b"12345678901234567890";
    const HOST: &str = "localhost:47591";
    const ORIGIN: &str = "https://localhost:47591";

    fn page(mode: RunMode) -> (Page, Receiver<crate::worker::Signal>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let people = Arc::new(People::load(dir.path()));
        let journal = Arc::new(Journal::open(dir.path()));
        // Nothing listens on port 9 (discard); requests to the server fail fast.
        let transport = Transport::new(
            ServerUrl::parse("http://127.0.0.1:9").unwrap(),
            Security::once(TlsMode::Checked(ServerTrust::Public)),
        );
        let (sender, receiver) = mpsc::channel();
        let page = Page {
            data_dir: dir.path().to_path_buf(),
            session: Arc::new(Session::new(
                transport,
                "m-1".into(),
                SigningKey::from_bytes(&[1; 32]),
            )),
            signals: Mutex::new(sender),
            board: Arc::new(StatusBoard::new(60)),
            mode,
            insecure_dev_tls: false,
            gate: Gate::new(SECRET, Arc::clone(&people), Arc::clone(&journal)),
            people,
            journal,
            hosts: Hosts {
                port: 47591,
                loopback_only: true,
            },
            listen: vec!["127.0.0.1:47591".parse().unwrap()],
            fingerprint: "AB:CD".into(),
            probe: Mutex::new(None),
            busy: Mutex::new(()),
            connections: AtomicUsize::new(0),
        };
        (page, receiver, dir)
    }

    fn get(path: &str, cookie: Option<&str>) -> Request {
        let cookie = cookie.map(|token| format!("{COOKIE}={token}"));
        let mut headers = vec![("Host", HOST)];
        if let Some(cookie) = &cookie {
            headers.push(("Cookie", cookie.as_str()));
        }
        Request::new("GET", path, &headers, b"")
    }

    fn post(path: &str, body: &str, origin: Option<&str>, cookie: Option<&str>) -> Request {
        let cookie = cookie.map(|token| format!("{COOKIE}={token}"));
        let mut headers = vec![("Host", HOST)];
        if let Some(origin) = origin {
            headers.push(("Origin", origin));
        }
        if let Some(cookie) = &cookie {
            headers.push(("Cookie", cookie.as_str()));
        }
        Request::new("POST", path, &headers, body.as_bytes())
    }

    fn body(response: &Response) -> String {
        String::from_utf8_lossy(&response.body).into_owned()
    }

    fn current_code() -> String {
        totp::code_for_step(SECRET, totp::step_at(now_ms() / 1000), totp::DIGITS)
    }

    fn sign_in(page: &Page) -> String {
        let (response, _) = handle(
            page,
            &post(
                "/sign-in",
                &format!("code={}", current_code()),
                Some(ORIGIN),
                None,
            ),
        );
        assert_eq!(response.status, 303, "{}", body(&response));
        let cookie = response.header("set-cookie").unwrap();
        assert!(cookie.contains("HttpOnly; Secure; SameSite=Strict"));
        cookie
            .trim_start_matches(&format!("{COOKIE}="))
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    #[test]
    fn healthz_needs_no_sign_in_and_says_200_or_503() {
        let (page, _signals, _dir) = page(RunMode::Foreground);
        assert_eq!(handle(&page, &get("/healthz", None)).0.status, 503);
        page.board.checked_in("", 60);
        assert_eq!(handle(&page, &get("/healthz", None)).0.status, 200);
    }

    #[test]
    fn everything_else_needs_a_session() {
        let (page, _signals, _dir) = page(RunMode::Foreground);
        let (home, _) = handle(&page, &get("/", None));
        assert!(body(&home).contains("Sign in on"));
        assert_eq!(handle(&page, &get("/move", None)).0.status, 303);
        let (response, after) = handle(&page, &post("/restart", "", Some(ORIGIN), None));
        assert_eq!(response.status, 401);
        assert_eq!(after, After::Nothing);
        assert_eq!(
            handle(&page, &post("/restart", "", Some(ORIGIN), Some("forged")))
                .0
                .status,
            401
        );
    }

    #[test]
    fn signed_in_the_status_page_shows_the_connection() {
        let (page, _signals, _dir) = page(RunMode::Foreground);
        let token = sign_in(&page);
        let (response, _) = handle(&page, &get("/", Some(&token)));
        let text = body(&response);
        assert_eq!(response.status, 200);
        assert!(text.contains("Not connected"));
        assert!(text.contains("http://127.0.0.1:9"));
        assert!(text.contains("m-1"));
        assert!(text.contains("Recent log"));
        assert!(text.contains("the shared machine code"));
    }

    #[test]
    fn forms_from_elsewhere_are_refused() {
        let (page, signals, _dir) = page(RunMode::Foreground);
        let token = sign_in(&page);
        for origin in [None, Some("https://evil.example"), Some("null")] {
            let (response, after) = handle(&page, &post("/restart", "", origin, Some(&token)));
            assert_eq!(response.status, 403);
            assert_eq!(after, After::Nothing);
        }
        assert!(signals.try_recv().is_err(), "nothing was sent to the agent");
        // A wrong code from elsewhere does not even count against the limit.
        let (response, _) = handle(
            &page,
            &post(
                "/sign-in",
                "code=000000",
                Some("https://evil.example"),
                None,
            ),
        );
        assert_eq!(response.status, 403);
    }

    #[test]
    fn other_host_names_are_refused() {
        let (page, _signals, _dir) = page(RunMode::Foreground);
        let request = Request::new("GET", "/healthz", &[("Host", "rebound.example:47591")], b"");
        assert_eq!(handle(&page, &request).0.status, 421);
    }

    #[test]
    fn restart_replies_first_then_signals_the_agent() {
        let (page, signals, _dir) = page(RunMode::Service);
        let token = sign_in(&page);
        let (response, after) = handle(&page, &post("/restart", "", Some(ORIGIN), Some(&token)));
        assert_eq!(response.status, 200);
        assert!(body(&response).contains("service manager"));
        assert_eq!(after, After::Restart);
        assert!(signals.try_recv().is_err());
        // E3: the restart is recorded with whose code the session used.
        let recorded: Vec<LocalEvent> = page
            .journal
            .entries()
            .into_iter()
            .map(|entry| entry.event)
            .collect();
        assert_eq!(
            recorded,
            [
                LocalEvent::SignedIn {
                    codes: CodeOwners::Machine
                },
                LocalEvent::Restarted {
                    codes: CodeOwners::Machine
                }
            ]
        );
        run_after(&page, after);
        assert!(matches!(
            signals.try_recv(),
            Ok(crate::worker::Signal::Restart)
        ));
    }

    #[test]
    fn uninstalling_a_development_copy_deletes_its_data_and_stops() {
        let (page, signals, dir) = page(RunMode::Foreground);
        let token = sign_in(&page);
        let (unconfirmed, _) = handle(&page, &post("/uninstall", "", Some(ORIGIN), Some(&token)));
        assert_eq!(unconfirmed.status, 422);
        let (response, after) = handle(
            &page,
            &post("/uninstall", "confirm=yes", Some(ORIGIN), Some(&token)),
        );
        let text = body(&response);
        assert_eq!(response.status, 200, "{text}");
        // The server (nothing on port 9) could not be told; the page says so.
        assert!(text.contains("could not be told"), "{text}");
        assert_eq!(after, After::RemoveDataAndStop);
        assert!(page.board.is_leaving());
        run_after(&page, after);
        assert!(!dir.path().exists());
        assert!(matches!(
            signals.try_recv(),
            Ok(crate::worker::Signal::Stop)
        ));
    }

    #[test]
    fn a_failed_move_changes_nothing() {
        let (page, signals, _dir) = page(RunMode::Foreground);
        let token = sign_in(&page);
        let (response, after) = handle(
            &page,
            &post(
                "/move",
                "url=http%3A%2F%2F127.0.0.1%3A9&code=K7P-4QX-29M&pin=&name=x",
                Some(ORIGIN),
                Some(&token),
            ),
        );
        assert_eq!(response.status, 422);
        assert!(body(&response).contains("nothing changed"));
        assert_eq!(after, After::Nothing);
        assert!(!page.board.is_leaving());
        assert!(signals.try_recv().is_err());
    }
}
