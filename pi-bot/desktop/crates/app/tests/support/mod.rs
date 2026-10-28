//! A scripted pi-bot server for UI tests: fixed answers per route, and a log of
//! every request so tests can assert what the app sent.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Debug, PartialEq)]
pub struct Received {
    pub method: String,
    pub path: String,
    pub body: String,
}

pub struct FakeServer {
    pub url: String,
    received: Arc<Mutex<Vec<Received>>>,
}

impl FakeServer {
    /// Serves until dropped. `respond` returns `(status, content type, body)`.
    pub fn start(
        respond: impl Fn(&Received) -> (u16, &'static str, String) + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind("[::1]:0").expect("bind a test port");
        let url = format!("http://[::1]:{}", listener.local_addr().unwrap().port());
        let received = Arc::new(Mutex::new(Vec::new()));
        let log = received.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let (status, content_type, body) = respond(&request);
                log.lock().unwrap().push(request);
                let reason = match status {
                    200 => "OK",
                    201 => "Created",
                    202 => "Accepted",
                    404 => "Not Found",
                    _ => "Error",
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self { url, received }
    }

    pub fn received(&self) -> Vec<Received> {
        self.received.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Received> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        if line.trim().is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().ok()?;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Received {
        method,
        path,
        body: String::from_utf8(body).ok()?,
    })
}

pub const BOTS: &str = r#"{"bots":[{"name":"reviewer","description":"Reviews diffs","model":"xai/grok-4.7","thinking":"high","tools":[],"skills":[],"prompt":"Be strict.","home":"/h/reviewer","file":"/h/reviewer/BOT.md"}],"errors":[]}"#;
pub const MODELS: &str = r#"{"models":[{"id":"xai/grok-4.7","provider":"xai","modelId":"grok-4.7","name":"Grok 4.7","reasoning":true,"contextWindow":256000}]}"#;
pub const CONVERSATIONS: &str = r#"{"conversations":[{"id":"older","bot":"reviewer","cwd":"/tmp","firstMessage":"Review the diff","modified":"2026-10-27T10:00:00.000Z","state":"idle"}]}"#;

/// `standard`, plus bot creation: after `POST /bots` the roster lists the new
/// bot too (name "helper"), as the real server would.
pub fn with_creation() -> impl Fn(&Received) -> (u16, &'static str, String) + Send + 'static {
    let created = Arc::new(Mutex::new(false));
    move |request| {
        let json = "application/json";
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/bots") => {
                *created.lock().unwrap() = true;
                (201, json, HELPER.into())
            }
            ("GET", "/bots") if *created.lock().unwrap() => (
                200,
                json,
                BOTS.replace("],\"errors\"", &format!(",{HELPER}],\"errors\"")),
            ),
            ("GET", "/bots/helper/conversations") => (200, json, r#"{"conversations":[]}"#.into()),
            _ => standard(request),
        }
    }
}

const HELPER: &str = r#"{"name":"helper","description":"Helps out","model":null,"thinking":null,"tools":["read"],"skills":[],"prompt":"Be helpful.","home":"/h/helper","file":"/h/helper/BOT.md"}"#;

/// Routes for one bot with one past conversation. Messages are accepted and
/// answered with a short stream that settles at once.
pub fn standard(request: &Received) -> (u16, &'static str, String) {
    let json = "application/json";
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/bots") => (200, json, BOTS.into()),
        ("GET", "/models") => (200, json, MODELS.into()),
        ("GET", "/bots/reviewer/conversations") => (200, json, CONVERSATIONS.into()),
        ("GET", path) if path.contains("?view=updates") => (
            200,
            "text/event-stream",
            "id: 1\nevent: status\ndata: {\"state\":\"running\"}\n\nid: 2\nevent: message\ndata: {\"message\":{\"role\":\"assistant\",\"text\":\"Looks fine.\"}}\n\nid: 3\nevent: settled\ndata: {\"aborted\":false}\n\n".into(),
        ),
        ("GET", path) if path.starts_with("/bots/reviewer/conversations/") => (404, json, r#"{"error":{"status":404,"message":"Unknown conversation."}}"#.into()),
        ("POST", path) if path.starts_with("/bots/reviewer/conversations/") => {
            (202, json, format!(r#"{{"submissionId":"s1","disposition":"started","offset":0,"streamUrl":"{path}?view=updates&offset=0"}}"#))
        }
        _ => (404, json, r#"{"error":{"status":404,"message":"No such route."}}"#.into()),
    }
}
