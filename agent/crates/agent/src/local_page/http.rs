//! Just enough HTTP/1.1 for the local page: one request per connection,
//! small bodies, every response closes the connection.

use std::io::{self, Read, Write};

/// Larger requests are refused: the page has only short forms.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024;
const MAX_HEADERS: usize = 48;

/// Every response forbids outside content, framing and caching.
const SECURITY_HEADERS: [(&str, &str); 6] = [
    (
        "content-security-policy",
        "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; \
         frame-ancestors 'none'; base-uri 'none'",
    ),
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    // Not `no-referrer`: with it Chrome sends `Origin: null` on the page's own
    // forms, and the origin check refuses them.
    ("referrer-policy", "same-origin"),
    ("cache-control", "no-store"),
    ("connection", "close"),
];

#[derive(Debug)]
pub struct Request {
    pub method: String,
    /// The path without the query string.
    pub path: String,
    pub query: String,
    /// Names in lower case.
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum ReadError {
    /// The connection failed or closed; nothing to answer.
    Closed,
    /// Not a request this page accepts; answer 400.
    Bad(&'static str),
}

impl From<io::Error> for ReadError {
    fn from(_: io::Error) -> Self {
        ReadError::Closed
    }
}

impl Request {
    #[cfg(test)]
    pub fn new(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Self {
        let (path, query) = split_target(target);
        Self {
            method: method.into(),
            path,
            query,
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_ascii_lowercase(), (*value).to_string()))
                .collect(),
            body: body.to_vec(),
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .filter(|(key, _)| key == "cookie")
            .flat_map(|(_, value)| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
    }

    /// The `application/x-www-form-urlencoded` body as name and value pairs.
    pub fn form(&self) -> Vec<(String, String)> {
        parse_pairs(&String::from_utf8_lossy(&self.body))
    }

    pub fn query_pairs(&self) -> Vec<(String, String)> {
        parse_pairs(&self.query)
    }
}

/// The value of `name` in decoded pairs, or "".
pub fn field<'a>(pairs: &'a [(String, String)], name: &str) -> &'a str {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map_or("", |(_, value)| value.as_str())
}

fn split_target(target: &str) -> (String, String) {
    match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
    }
}

fn parse_pairs(text: &str) -> Vec<(String, String)> {
    text.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(name), decode(value))
        })
        .collect()
}

/// Percent-decoding with `+` as a space; bad escapes are kept as typed.
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high << 4 | low);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Reads one request: the head up to [`MAX_HEAD`], then a body of exactly
/// `Content-Length` bytes up to [`MAX_BODY`].
pub fn read_request(stream: &mut impl Read) -> Result<Request, ReadError> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        if let Some(at) = find(&buffer, b"\r\n\r\n") {
            if at > MAX_HEAD {
                return Err(ReadError::Bad("the request head is too large"));
            }
            break at + 4;
        }
        if buffer.len() > MAX_HEAD {
            return Err(ReadError::Bad("the request head is too large"));
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(ReadError::Closed);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut headers);
    match parsed.parse(&buffer[..head_end]) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) | Err(_) => {
            return Err(ReadError::Bad("not an HTTP request"))
        }
    }
    let method = parsed.method.unwrap_or_default().to_string();
    let (path, query) = split_target(parsed.path.unwrap_or("/"));
    let headers: Vec<(String, String)> = parsed
        .headers
        .iter()
        .map(|h| {
            (
                h.name.to_ascii_lowercase(),
                String::from_utf8_lossy(h.value).into_owned(),
            )
        })
        .collect();
    if headers.iter().any(|(name, _)| name == "transfer-encoding") {
        return Err(ReadError::Bad("chunked requests are not accepted"));
    }
    let length = match headers.iter().find(|(name, _)| name == "content-length") {
        Some((_, value)) => value
            .trim()
            .parse::<usize>()
            .map_err(|_| ReadError::Bad("bad Content-Length"))?,
        None => 0,
    };
    if length > MAX_BODY {
        return Err(ReadError::Bad("the request body is too large"));
    }
    let mut body = buffer[head_end..].to_vec();
    if body.len() > length {
        return Err(ReadError::Bad("more data than Content-Length"));
    }
    while body.len() < length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(ReadError::Closed);
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > length {
            return Err(ReadError::Bad("more data than Content-Length"));
        }
    }
    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn html(status: u16, body: String) -> Self {
        Self {
            status,
            headers: vec![("content-type", "text/html; charset=utf-8".into())],
            body: body.into_bytes(),
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type", "text/plain; charset=utf-8".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn css(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type", "text/css; charset=utf-8".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    /// 303 See Other: after a form, the browser loads `location` with GET.
    pub fn redirect(location: &str) -> Self {
        Self {
            status: 303,
            headers: vec![("location", location.into())],
            body: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &'static str, value: String) -> Self {
        self.headers.push((name, value));
        self
    }

    #[cfg(test)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn write_to(&self, out: &mut impl Write) -> io::Result<()> {
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (name, value) in SECURITY_HEADERS
            .iter()
            .map(|(name, value)| (*name, *value))
            .chain(
                self.headers
                    .iter()
                    .map(|(name, value)| (*name, value.as_str())),
            )
        {
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        head.push_str(&format!("content-length: {}\r\n\r\n", self.body.len()));
        out.write_all(head.as_bytes())?;
        out.write_all(&self.body)?;
        out.flush()
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        303 => "See Other",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        421 => "Misdirected Request",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_form_post() {
        let raw = b"POST /sign-in?x=1 HTTP/1.1\r\nHost: localhost:47500\r\nCookie: a=1; bmuster_local_session=abc\r\nContent-Length: 11\r\n\r\ncode=123+45";
        let request = read_request(&mut &raw[..]).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/sign-in");
        assert_eq!(request.query, "x=1");
        assert_eq!(request.header("host"), Some("localhost:47500"));
        assert_eq!(request.cookie("bmuster_local_session"), Some("abc"));
        assert_eq!(field(&request.form(), "code"), "123 45");
    }

    #[test]
    fn refuses_oversized_and_chunked_requests() {
        let big = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD + 10));
        assert!(matches!(
            read_request(&mut big.as_bytes()),
            Err(ReadError::Bad(_))
        ));
        let body = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(matches!(
            read_request(&mut body.as_bytes()),
            Err(ReadError::Bad(_))
        ));
        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
        assert!(matches!(
            read_request(&mut &chunked[..]),
            Err(ReadError::Bad(_))
        ));
        assert!(matches!(
            read_request(&mut &b"GET / HTTP/1.1\r\n"[..]),
            Err(ReadError::Closed)
        ));
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(
            decode("https%3A%2F%2Fexample.com%2F"),
            "https://example.com/"
        );
        assert_eq!(decode("a%zzb%"), "a%zzb%");
        assert_eq!(decode("sha256%3Aab%2B%2F%3D"), "sha256:ab+/=");
    }

    #[test]
    fn responses_carry_the_security_headers() {
        let mut out = Vec::new();
        Response::text(200, "ok").write_to(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("content-security-policy: default-src 'none'"));
        assert!(text.contains("x-frame-options: DENY"));
        assert!(text.contains("cache-control: no-store"));
        assert!(text.contains("referrer-policy: same-origin"));
        assert!(text.ends_with("content-length: 2\r\n\r\nok"));
    }
}
