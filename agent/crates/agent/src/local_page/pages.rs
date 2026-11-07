//! The local page's HTML: plain server-rendered pages and one small
//! stylesheet, no scripts and nothing from outside this machine. Every value
//! that did not come from this file is escaped.

use std::fmt::Write as _;
use std::time::SystemTime;

/// The console's palette (src/lib/ui/design-tokens.css): lime brand, with
/// the darker #46720e in light mode so white text on it and it on the page
/// pass WCAG AA (#65a30d is only 3.1:1 with white).
pub const STYLE: &str = r#":root {
  color-scheme: light dark;
  --bg: #f4f7f2; --card: #ffffff; --text: #161d14; --muted: #657061; --line: #d6ddd2;
  --brand: #46720e; --brand-text: #ffffff; --ok: #1d7a46; --bad: #b42318; --warn: #9a6200;
  --tint: #e9eee5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1411; --card: #171e19; --text: #e7ece6; --muted: #8c978a; --line: #2a332c;
    --brand: #a3e635; --brand-text: #14180f; --ok: #4cc283; --bad: #ff7a6b; --warn: #f0b44c;
    --tint: #1e2620;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand svg { flex-shrink: 0; }
h1 { font-size: 1.35rem; margin: 0; }
h2 { font-size: 0.8rem; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.muted { color: var(--muted); font-size: 0.9rem; }
dl { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr); gap: 4px 12px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9rem; overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
.badge.ok { background: var(--tint); } .badge.bad { background: var(--tint); }
.notice { border-left: 4px solid var(--brand); }
.problem { border-left: 4px solid var(--bad); }
form { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button, .button { display: inline-flex; align-items: center; min-height: 44px; padding: 8px 18px;
  border-radius: 999px; border: 1px solid var(--line); background: var(--tint); color: var(--text);
  font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
button.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-text); }
button.danger { background: var(--bad); border-color: var(--bad); color: var(--brand-text); }
label { display: grid; gap: 4px; font-weight: 600; }
label.check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; }
input[type=text], input[type=url] { width: 100%; min-height: 44px; padding: 8px 12px; font: inherit;
  border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); }
input.code { font-size: 1.6rem; letter-spacing: 0.3em; text-align: center; max-width: 14rem; }
.fields { display: grid; gap: 12px; }
ul.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
ul.steps li { overflow-wrap: anywhere; }
pre.log { margin: 0; max-height: 26rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem;
  background: var(--tint); border-radius: 8px; padding: 12px; }
.bar { height: 8px; border-radius: 999px; background: var(--tint); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--brand); }
"#;

/// The BMuster logo's small version (static/favicon.svg in the server),
/// inline so the page loads nothing else. Decorative: the heading names it.
const LOGO: &str = r##"<svg width="32" height="32" viewBox="8 8 240 240" aria-hidden="true"><rect x="8" y="8" width="240" height="240" rx="48" fill="#1b221d"/><circle cx="128" cy="128" r="88" fill="none" stroke="#3f4a43" stroke-width="14"/><path d="M128 128 L128 40 A88 88 0 0 1 204 84 Z" fill="#a3e635" opacity="0.35"/><path d="M128 128 L204 84" stroke="#a3e635" stroke-width="20" stroke-linecap="round"/><circle cx="128" cy="128" r="18" fill="#a3e635"/><rect x="150" y="144" width="56" height="42" rx="8" fill="#f4f7f2"/></svg>"##;

/// Escapes text for HTML content and quoted attributes.
pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn layout(title: &str, signed_in: bool, body: &str) -> String {
    let sign_out = if signed_in {
        r#"<form method="post" action="/sign-out"><button type="submit">Sign out</button></form>"#
    } else {
        ""
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} - BMuster agent</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<header><div class="brand">{LOGO}<h1>BMuster agent</h1></div>{sign_out}</header>
{body}
</main>
</body>
</html>
"#,
        title = esc(title),
    )
}

pub fn sign_in(hostname: &str, problem: Option<&str>) -> String {
    let problem = problem
        .map(|text| {
            format!(
                r#"<section class="card problem"><p>{}</p></section>"#,
                esc(text)
            )
        })
        .unwrap_or_default();
    let body = format!(
        r#"{problem}<section class="card">
<h2>Sign in on {host}</h2>
<p>Enter your 6-digit code from the BMuster console: open this machine, go to the <strong>Manage</strong> tab and choose <strong>Show local page code</strong>. Each person has their own code, and the server's Activity records whose code signed in. The code changes every 30 seconds and works even while this machine is offline.</p>
<form method="post" action="/sign-in" class="fields">
<label>Code <input class="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{{6,7}}" maxlength="7" required autofocus></label>
<div><button class="primary" type="submit">Sign in</button></div>
</form>
</section>"#,
        host = esc(hostname),
    );
    layout("Sign in", false, &body)
}

/// "12 s ago", "4 min ago", "3 h ago", "2 days ago".
pub fn ago(at: SystemTime, now: SystemTime) -> String {
    let seconds = now.duration_since(at).map_or(0, |since| since.as_secs());
    match seconds {
        0..=59 => format!("{seconds} s ago"),
        60..=3599 => format!("{} min ago", seconds / 60),
        3600..=172_799 => format!("{} h ago", seconds / 3600),
        _ => format!("{} days ago", seconds / 86_400),
    }
}

pub fn when(at: SystemTime, now: SystemTime) -> String {
    format!("{} ({})", ago(at, now), httpdate::fmt_http_date(at))
}

pub fn bytes(count: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    #[allow(clippy::cast_precision_loss)]
    let gb = count as f64 / GB;
    if gb >= 100.0 {
        format!("{gb:.0} GB")
    } else {
        format!("{gb:.1} GB")
    }
}

pub struct Row {
    pub label: &'static str,
    /// Already-escaped HTML.
    pub html: String,
}

pub fn row(label: &'static str, text: &str) -> Row {
    Row {
        label,
        html: esc(text),
    }
}

pub fn rows(rows: &[Row]) -> String {
    let mut out = String::from("<dl>");
    for row in rows {
        let _ = write!(out, "<dt>{}</dt><dd>{}</dd>", row.label, row.html);
    }
    out.push_str("</dl>");
    out
}

pub fn card(heading: &str, inner: &str) -> String {
    format!(
        r#"<section class="card"><h2>{}</h2>{inner}</section>"#,
        esc(heading)
    )
}

pub fn notice(text: &str) -> String {
    format!(
        r#"<section class="card notice"><p>{}</p></section>"#,
        esc(text)
    )
}

pub fn problem(text: &str) -> String {
    format!(
        r#"<section class="card problem"><p>{}</p></section>"#,
        esc(text)
    )
}

pub fn usage_bar(used: u64, total: u64) -> String {
    let percent = if total == 0 {
        0
    } else {
        used.saturating_mul(100) / total
    }
    .min(100);
    format!(r#"<div class="bar" role="presentation"><span class="w{percent}"></span></div>"#)
}

pub fn log_card(lines: &[String]) -> String {
    let mut text = String::new();
    // Newest first, so the latest problem is at the top on a phone.
    for line in lines.iter().rev() {
        text.push_str(&esc(line));
        text.push('\n');
    }
    if text.is_empty() {
        text.push_str("Nothing logged yet.");
    }
    card(
        "Recent log (newest first)",
        &format!(r#"<pre class="log">{text}</pre>"#),
    )
}

pub fn actions_card() -> String {
    card(
        "Actions",
        r#"<div class="actions">
<form method="post" action="/test-connection"><button class="primary" type="submit">Test connection</button></form>
<form method="post" action="/check-in-now"><button type="submit">Check in now</button></form>
<form method="post" action="/restart"><button type="submit">Restart the agent</button></form>
<a class="button" href="/move">Move to another server</a>
<a class="button" href="/uninstall">Uninstall the agent</a>
<a class="button" href="/">Refresh</a>
</div>"#,
    )
}

pub struct Step {
    pub name: &'static str,
    pub result: StepResult,
}

pub enum StepResult {
    Pass(String),
    Fail(String),
    Skipped(String),
}

pub fn steps(steps: &[Step]) -> String {
    let mut out = String::from(r#"<ul class="steps">"#);
    for step in steps {
        let (class, word, text) = match &step.result {
            StepResult::Pass(text) => ("ok", "Pass", text),
            StepResult::Fail(text) => ("bad", "Fail", text),
            StepResult::Skipped(text) => ("muted", "Not run", text),
        };
        let _ = write!(
            out,
            r#"<li><span class="badge {class}">{word}</span> <strong>{}</strong>: {}</li>"#,
            esc(step.name),
            esc(text)
        );
    }
    out.push_str("</ul>");
    out
}

pub struct MoveForm<'a> {
    pub url: &'a str,
    pub code: &'a str,
    pub pin: &'a str,
    pub name: &'a str,
}

pub fn move_form(current_server: &str, form: &MoveForm<'_>, problem_text: Option<&str>) -> String {
    let problem_html = problem_text.map(problem).unwrap_or_default();
    let body = format!(
        r#"{problem_html}<section class="card">
<h2>Move to another server</h2>
<p>This machine now belongs to <code>{current}</code>. On the new server, open <strong>Add machine</strong> and make a join code, then enter its address and the code here.</p>
<p class="muted">The agent joins the new server first, with a new key. Only when that works does it tell this server it is leaving and switch over, so a typo changes nothing. Then it restarts; sign in again with a code from the new server's console.</p>
<form method="post" action="/move" class="fields">
<label>New server address <input type="url" name="url" value="{url}" placeholder="https://bmuster.example.com" required></label>
<label>Join code <input type="text" name="code" value="{code}" placeholder="K7P-4QX-29M" autocomplete="off" required></label>
<label>Certificate pin (only for a server in local network mode) <input type="text" name="pin" value="{pin}" placeholder="sha256:..." autocomplete="off"></label>
<label>Name on the new server <input type="text" name="name" value="{name}"></label>
<div class="actions"><button class="primary" type="submit">Move this machine</button><a class="button" href="/">Cancel</a></div>
</form>
</section>"#,
        current = esc(current_server),
        url = esc(form.url),
        code = esc(form.code),
        pin = esc(form.pin),
        name = esc(form.name),
    );
    layout("Move to another server", true, &body)
}

pub fn uninstall_form(explanation: &str, problem_text: Option<&str>) -> String {
    let problem_html = problem_text.map(problem).unwrap_or_default();
    let body = format!(
        r#"{problem_html}<section class="card">
<h2>Uninstall the agent</h2>
<p>{}</p>
<form method="post" action="/uninstall" class="fields">
<label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand: this machine leaves its BMuster server and the agent, its identity and its key are deleted.</label>
<div class="actions"><button class="danger" type="submit">Uninstall the agent</button><a class="button" href="/">Cancel</a></div>
</form>
</section>"#,
        esc(explanation)
    );
    layout("Uninstall the agent", true, &body)
}

/// A page with a heading, paragraphs and a link back.
pub fn message(title: &str, paragraphs: &[String], signed_in: bool) -> String {
    let mut inner = String::new();
    for text in paragraphs {
        let _ = write!(inner, "<p>{}</p>", esc(text));
    }
    let body = format!(
        r#"<section class="card"><h2>{}</h2>{inner}<div class="actions"><a class="button" href="/">Back to the status page</a></div></section>"#,
        esc(title)
    );
    layout(title, signed_in, &body)
}

/// The usage bar's widths as classes (no inline styles under the CSP).
pub fn bar_widths() -> String {
    let mut css = String::new();
    for percent in 0..=100 {
        let _ = writeln!(css, ".bar span.w{percent} {{ width: {percent}%; }}");
    }
    css
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn escapes_everything_that_matters() {
        assert_eq!(
            esc(r#"<script>alert("x") & 'y'</script>"#),
            "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;"
        );
        let page = sign_in("<host>", Some("<b>bad</b>"));
        assert!(!page.contains("<host>"));
        assert!(!page.contains("<b>bad</b>"));
    }

    #[test]
    fn relative_times() {
        let now = SystemTime::now();
        assert_eq!(ago(now - Duration::from_secs(5), now), "5 s ago");
        assert_eq!(ago(now - Duration::from_secs(600), now), "10 min ago");
        assert_eq!(ago(now - Duration::from_secs(7200), now), "2 h ago");
        assert_eq!(
            ago(now - Duration::from_secs(3 * 86_400), now),
            "3 days ago"
        );
    }
}
