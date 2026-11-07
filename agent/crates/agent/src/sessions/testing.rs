//! A WebSocket pair over loopback for the session tests: the agent's side is
//! the same socket type the agent uses with a server, without TLS.

use crate::socket::Socket;
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const WAIT: Duration = Duration::from_secs(10);

/// (the agent's end, the server's end)
pub fn socket_pair() -> (Socket, WebSocket<TcpStream>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let accepting = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tungstenite::accept(tcp).unwrap()
    });
    let tcp = TcpStream::connect(address).unwrap();
    let (client, _) = tungstenite::client(
        format!("ws://{address}/agent/v1/sessions/test"),
        MaybeTlsStream::Plain(tcp),
    )
    .unwrap();
    (client, accepting.join().unwrap())
}

/// The server's end, collecting what the agent sends.
pub struct Server {
    socket: WebSocket<TcpStream>,
    output: Vec<u8>,
}

impl Server {
    pub fn new(socket: WebSocket<TcpStream>) -> Self {
        socket
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        Self {
            socket,
            output: Vec::new(),
        }
    }

    pub fn send_bytes(&mut self, bytes: &[u8]) {
        self.socket
            .send(Message::Binary(bytes.to_vec().into()))
            .unwrap();
    }

    pub fn send_text(&mut self, text: &str) {
        self.socket.send(Message::text(text)).unwrap();
    }

    /// One message, or `None` when nothing came within the read timeout.
    fn next(&mut self) -> Option<Message> {
        match self.socket.read() {
            Ok(message) => Some(message),
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                None
            }
            Err(e) => panic!("the session socket failed: {e}"),
        }
    }

    pub fn wait_for_output(&mut self, wanted: &str) {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            if String::from_utf8_lossy(&self.output).contains(wanted) {
                return;
            }
            if let Some(Message::Binary(bytes)) = self.next() {
                self.output.extend_from_slice(&bytes);
            }
        }
        panic!(
            "no {wanted:?} in the output: {:?}",
            String::from_utf8_lossy(&self.output)
        );
    }

    /// Every output byte so far.
    pub fn output(&self) -> &[u8] {
        &self.output
    }

    /// The next text message, skipping output.
    pub fn wait_for_text(&mut self) -> String {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            match self.next() {
                Some(Message::Text(text)) => return text.as_str().to_string(),
                Some(Message::Binary(bytes)) => self.output.extend_from_slice(&bytes),
                _ => {}
            }
        }
        panic!("no text message came");
    }

    /// Reads and drops at least `count` output bytes.
    pub fn skip_bytes(&mut self, count: usize) {
        let until = Instant::now() + WAIT;
        let mut total = 0;
        while total < count {
            assert!(Instant::now() < until, "only {total} of {count} bytes came");
            if let Some(Message::Binary(bytes)) = self.next() {
                total += bytes.len();
            }
        }
    }

    /// Closes as the server does when a session ends.
    pub fn close(&mut self) {
        let _ = self.socket.close(None);
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            match self.socket.read() {
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => return,
            }
        }
    }
}
