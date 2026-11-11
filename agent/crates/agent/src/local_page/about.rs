//! What the local page shows before sign-in (SPEC-LOCAL-PAGE-TRANSPARENCY):
//! anyone at this computer sees who manages it, what BMuster can do here,
//! who is connected right now and how to remove it; a visitor from the
//! network sees only how to remove it and the sign-in form.
//!
//! Nothing here is secret: no keys, codes or ids. The organisation is the
//! server's host name, because the agent is not told the organisation's
//! name.

use super::gate::Visitor;
use super::pages::{self, esc};
use super::Page;
use crate::removal::{self, RemoveCommand};
use crate::sessions::live::{LiveKind, NoticeSetting, Open};
use crate::updates;
use std::fmt::Write as _;

/// The details only someone at this computer sees.
pub struct About<'a> {
    /// Who manages the computer: the server's host name.
    pub manager: &'a str,
    pub server: &'a str,
    pub machine: &'a str,
    pub version: &'a str,
    pub open: &'a [Open],
    pub notice: NoticeSetting,
}

pub enum Before<'a> {
    AtThisComputer(About<'a>),
    FromTheNetwork,
}

/// The page a visitor who is not signed in sees.
pub fn signed_out(page: &Page, visitor: Visitor, hostname: &str, problem: Option<&str>) -> String {
    let server = page.session.transport.server.base();
    let machine = page
        .board
        .snapshot()
        .machine_name
        .unwrap_or_else(|| hostname.to_string());
    let open = page.live.open();
    let before = match visitor {
        Visitor::AtThisComputer => Before::AtThisComputer(About {
            manager: page.session.transport.server.host(),
            server: &server,
            machine: &machine,
            version: updates::VERSION,
            open: &open,
            notice: page.live.notice(),
        }),
        Visitor::FromTheNetwork => Before::FromTheNetwork,
    };
    render(
        &before,
        &removal::remove_command(removal::System::this()),
        hostname,
        problem,
    )
}

pub fn render(
    before: &Before<'_>,
    remove: &RemoveCommand,
    hostname: &str,
    problem: Option<&str>,
) -> String {
    let mut body = String::new();
    if let Before::AtThisComputer(about) = before {
        body.push_str(&who_manages(about));
        body.push_str(&what_it_can_do(about.notice));
        body.push_str(&right_now(about.open));
    }
    body.push_str(&remove_card(remove));
    body.push_str(&pages::sign_in_card(hostname, problem));
    pages::layout("This computer", false, &body)
}

fn who_manages(about: &About<'_>) -> String {
    pages::card(
        "Who manages this computer",
        &format!(
            "<p>This computer is managed by <strong>{}</strong> with BMuster.</p>{}",
            esc(about.manager),
            pages::rows(&[
                pages::row("Server", about.server),
                pages::row("This computer", about.machine),
                pages::row("Agent version", about.version),
            ])
        ),
    )
}

fn what_it_can_do(notice: NoticeSetting) -> String {
    let notice = match notice {
        NoticeSetting::Shown => {
            "While someone views or controls the screen, a notice on the screen names them."
        }
        NoticeSetting::Hidden => {
            "The server's settings turn the on-screen notice off: someone can view or control the screen without a notice showing."
        }
        NoticeSetting::NotSeen => {
            "While someone views or controls the screen, the agent shows a notice naming them when the server's settings ask for it (they do unless an administrator turned it off)."
        }
    };
    pages::card(
        "What BMuster can do here",
        &format!(
            r#"<p>People the server gives access can, from the BMuster console:</p>
<ul class="plain"><li>see and control the screen</li><li>open a terminal with administrator rights</li><li>move files to and from this computer</li></ul>
<p>{}</p>"#,
            esc(notice)
        ),
    )
}

fn right_now(open: &[Open]) -> String {
    if open.is_empty() {
        return pages::card("Right now", "<p>Nobody is connected right now.</p>");
    }
    let mut rows = Vec::new();
    for kind in [
        LiveKind::Desktop,
        LiveKind::Terminal,
        LiveKind::Files,
        LiveKind::Command,
    ] {
        let mut people: Vec<&str> = open
            .iter()
            .filter(|session| session.kind == kind)
            .map(|session| session.person.as_str())
            .collect();
        people.dedup();
        if !people.is_empty() {
            rows.push(pages::row(kind_label(kind), &people.join(", ")));
        }
    }
    let mut inner = String::from("<p>These people have a session open on this computer:</p>");
    let _ = write!(inner, "{}", pages::rows(&rows));
    pages::card("Right now", &inner)
}

fn kind_label(kind: LiveKind) -> &'static str {
    match kind {
        LiveKind::Desktop => "Desktop",
        LiveKind::Terminal => "Terminal",
        LiveKind::Files => "Files",
        LiveKind::Command => "Command",
    }
}

fn remove_card(remove: &RemoveCommand) -> String {
    pages::card(
        "Remove BMuster",
        &format!(
            r#"<p>{}, run this command (click it to select it all, then copy):</p>
<p><code class="command">{}</code></p>
<p>No BMuster code is needed. Administrator rights on this computer are enough.</p>
<p class="muted">It tells the server first (if it can reach it within a few seconds), so the server's Activity shows that BMuster was removed at the machine, then removes the agent's service, program and data.</p>"#,
            esc(remove.shell),
            esc(remove.command)
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::removal::{remove_command, System};

    fn about(open: &[Open]) -> About<'_> {
        About {
            manager: "bmuster.example.com",
            server: "https://bmuster.example.com",
            machine: "mint",
            version: "1.2.3",
            open,
            notice: NoticeSetting::Shown,
        }
    }

    #[test]
    fn a_visitor_at_this_computer_sees_who_manages_it_and_how_to_remove_it() {
        let html = render(
            &Before::AtThisComputer(about(&[])),
            &remove_command(System::Linux),
            "mint",
            None,
        );
        assert!(html.contains("<h1>BMuster Agent</h1>"));
        assert!(html.contains("- BMuster Agent</title>"));
        assert!(html.contains(
            "This computer is managed by <strong>bmuster.example.com</strong> with BMuster."
        ));
        assert!(html.contains("https://bmuster.example.com"));
        assert!(html.contains("<dd>mint</dd>"));
        assert!(html.contains("<dd>1.2.3</dd>"));
        assert!(html.contains("see and control the screen"));
        assert!(html.contains("a notice on the screen names them"));
        assert!(html.contains("Nobody is connected right now."));
        assert!(html.contains("sudo /opt/bmuster/versions/current/bmuster-agent uninstall --purge"));
        assert!(html.contains(
            "No BMuster code is needed. Administrator rights on this computer are enough."
        ));
        // The sign-in form comes last, after everything a visitor should know.
        let order = [
            "Who manages this computer",
            "What BMuster can do here",
            "Right now",
            "Remove BMuster",
            "to make changes",
        ]
        .map(|text| html.find(text).unwrap());
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{order:?}");
        // No scripts: the page's CSP allows none.
        assert!(!html.contains("<script"));
    }

    #[test]
    fn a_visitor_from_the_network_sees_only_removal_and_sign_in() {
        let html = render(
            &Before::FromTheNetwork,
            &remove_command(System::Windows),
            "mint",
            None,
        );
        assert!(html.contains("Remove BMuster"));
        assert!(html.contains("In PowerShell as administrator"));
        assert!(html.contains(
            "&amp; &quot;$env:ProgramFiles\\BMuster\\bmuster-agent.exe&quot; uninstall --purge"
        ));
        assert!(html.contains("to make changes"));
        for private in [
            "Who manages",
            "bmuster.example.com",
            "Right now",
            "What BMuster can do here",
            "Agent version",
        ] {
            assert!(!html.contains(private), "{private}");
        }
    }

    #[test]
    fn who_is_connected_is_listed_by_kind() {
        let open = [
            Open {
                kind: LiveKind::Desktop,
                person: "Sam <Lee>".into(),
            },
            Open {
                kind: LiveKind::Terminal,
                person: "Jack Brumley".into(),
            },
            Open {
                kind: LiveKind::Terminal,
                person: "Kim Ng".into(),
            },
        ];
        let html = render(
            &Before::AtThisComputer(About {
                notice: NoticeSetting::Hidden,
                ..about(&open)
            }),
            &remove_command(System::Linux),
            "mint",
            None,
        );
        assert!(!html.contains("Nobody is connected"));
        assert!(html.contains("<dt>Desktop</dt><dd>Sam &lt;Lee&gt;</dd>"));
        assert!(html.contains("<dt>Terminal</dt><dd>Jack Brumley, Kim Ng</dd>"));
        assert!(!html.contains("<dt>Files</dt>"));
        assert!(html.contains("turn the on-screen notice off"));
    }

    #[test]
    fn a_wrong_code_shows_above_the_form() {
        let html = render(
            &Before::FromTheNetwork,
            &remove_command(System::Linux),
            "mint",
            Some("That code is not right."),
        );
        let problem = html.find("That code is not right.").unwrap();
        assert!(problem > html.find("to make changes").unwrap());
        assert!(problem < html.find("<form").unwrap());
    }
}
