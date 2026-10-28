use std::fmt;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use ureq::Agent;
use ureq::http::{Method, Request};

use crate::sse::Updates;
use crate::types::*;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// The server could not be reached or the connection broke.
    Transport(String),
    /// The server answered with an error status and, usually, a message.
    Http { status: u16, message: String },
    /// The answer was not the JSON this client expects.
    Decode(String),
}

impl Error {
    pub fn is_not_found(&self) -> bool {
        matches!(self, Error::Http { status: 404, .. })
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Transport(message) => write!(f, "Could not reach the server: {message}."),
            Error::Http { message, .. } => write!(f, "{message}"),
            Error::Decode(message) => write!(f, "Unexpected answer from the server: {message}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<ureq::Error> for Error {
    fn from(error: ureq::Error) -> Self {
        match error {
            ureq::Error::Json(error) => Error::Decode(error.to_string()),
            // The io error alone reads better than ureq's "io: " prefix.
            ureq::Error::Io(error) => Error::Transport(error.to_string()),
            other => Error::Transport(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// A connection to one pi-bot server. Cheap to clone; share it across threads.
#[derive(Clone, Debug)]
pub struct Client {
    agent: Agent,
    base: String,
}

impl Client {
    /// `base_url` like `http://[::1]:7733`, with or without a trailing slash.
    pub fn new(base_url: &str) -> Self {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .new_agent();
        Self {
            agent,
            base: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn health(&self) -> Result<()> {
        self.call::<Value>(Method::GET, "/health", None).map(|_| ())
    }

    pub fn models(&self) -> Result<Vec<Model>> {
        #[derive(serde::Deserialize)]
        struct Body {
            models: Vec<Model>,
        }
        self.call::<Body>(Method::GET, "/models", None)
            .map(|body| body.models)
    }

    /// Valid bots plus one message per definition the server could not parse.
    pub fn bots(&self) -> Result<(Vec<Bot>, Vec<String>)> {
        #[derive(serde::Deserialize)]
        struct Body {
            bots: Vec<Bot>,
            #[serde(default)]
            errors: Vec<String>,
        }
        self.call::<Body>(Method::GET, "/bots", None)
            .map(|body| (body.bots, body.errors))
    }

    pub fn bot(&self, name: &str) -> Result<Bot> {
        self.call(Method::GET, &bot_path(name), None)
    }

    pub fn create_bot(&self, bot: &BotCreate) -> Result<Bot> {
        self.call(Method::POST, "/bots", Some(json(bot)))
    }

    pub fn update_bot(&self, name: &str, patch: &BotPatch) -> Result<Bot> {
        self.call(Method::PATCH, &bot_path(name), Some(json(patch)))
    }

    /// Returns where the bot's home was moved.
    pub fn archive_bot(&self, name: &str) -> Result<String> {
        #[derive(serde::Deserialize)]
        struct Body {
            archived: String,
        }
        self.call::<Body>(Method::DELETE, &bot_path(name), None)
            .map(|body| body.archived)
    }

    /// Newest first.
    pub fn conversations(&self, bot: &str) -> Result<Vec<ConversationSummary>> {
        #[derive(serde::Deserialize)]
        struct Body {
            conversations: Vec<ConversationSummary>,
        }
        self.call::<Body>(
            Method::GET,
            &format!("{}/conversations", bot_path(bot)),
            None,
        )
        .map(|body| body.conversations)
    }

    pub fn conversation(&self, bot: &str, id: &str) -> Result<Conversation> {
        self.call(Method::GET, &conversation_path(bot, id), None)
    }

    /// Creates an empty conversation; an existing one is returned unchanged.
    pub fn create_conversation(
        &self,
        bot: &str,
        id: &str,
        cwd: Option<&str>,
    ) -> Result<Conversation> {
        let body = cwd
            .map(|cwd| serde_json::json!({ "cwd": cwd }))
            .unwrap_or_else(|| serde_json::json!({}));
        self.call(Method::PUT, &conversation_path(bot, id), Some(body))
    }

    /// Sends a message; the reply arrives on the stream named by the submission.
    pub fn send(
        &self,
        bot: &str,
        id: &str,
        message: &str,
        cwd: Option<&str>,
    ) -> Result<Submission> {
        let mut body = serde_json::json!({ "message": message });
        if let Some(cwd) = cwd {
            body["cwd"] = cwd.into();
        }
        self.call(Method::POST, &conversation_path(bot, id), Some(body))
    }

    pub fn abort(&self, bot: &str, id: &str) -> Result<()> {
        self.call::<Value>(
            Method::POST,
            &format!("{}/abort", conversation_path(bot, id)),
            None,
        )
        .map(|_| ())
    }

    pub fn answer(&self, bot: &str, id: &str, answer: &Answer) -> Result<()> {
        self.call::<Value>(
            Method::POST,
            &format!("{}/responses", conversation_path(bot, id)),
            Some(json(answer)),
        )
        .map(|_| ())
    }

    pub fn delete_conversation(&self, bot: &str, id: &str) -> Result<()> {
        self.call::<Value>(Method::DELETE, &conversation_path(bot, id), None)
            .map(|_| ())
    }

    /// Follow a conversation's updates from `offset` on a background thread.
    /// Connects to the conversation's event stream from `offset` on. Blocks
    /// while connecting; each item of the returned iterator blocks too.
    pub fn updates(&self, bot: &str, id: &str, offset: u64) -> Result<Updates> {
        let url = format!(
            "{}{}?view=updates&offset={offset}",
            self.base,
            conversation_path(bot, id)
        );
        Updates::open(&url)
    }

    fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.base));
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let request = request
            .body(body.map(|value| value.to_string()).unwrap_or_default())
            .map_err(|error| Error::Transport(error.to_string()))?;
        let mut response = self.agent.run(request)?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string()?;
        if !(200..300).contains(&status) {
            return Err(Error::Http {
                status,
                message: error_message(&text, status),
            });
        }
        serde_json::from_str(&text).map_err(|error| Error::Decode(error.to_string()))
    }
}

fn json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("API types serialize")
}

fn bot_path(name: &str) -> String {
    format!("/bots/{}", encode(name))
}

fn conversation_path(bot: &str, id: &str) -> String {
    format!("{}/conversations/{}", bot_path(bot), encode(id))
}

/// Percent-encode a path segment. Names and ids are already restricted to a
/// safe alphabet by the server, so this only guards against stray characters.
fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn error_message(text: &str, status: u16) -> String {
    #[derive(serde::Deserialize)]
    struct Body {
        error: Inner,
    }
    #[derive(serde::Deserialize)]
    struct Inner {
        message: String,
    }
    serde_json::from_str::<Body>(text)
        .map(|body| body.error.message)
        .unwrap_or_else(|_| format!("The server answered with status {status}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_encoded() {
        assert_eq!(
            conversation_path("reviewer", "c.1_x-2"),
            "/bots/reviewer/conversations/c.1_x-2"
        );
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn error_messages_come_from_the_body_when_present() {
        assert_eq!(
            error_message(
                r#"{"error":{"status":404,"message":"Unknown bot \"x\"."}}"#,
                404
            ),
            "Unknown bot \"x\"."
        );
        assert_eq!(
            error_message("<html>", 502),
            "The server answered with status 502."
        );
    }
}
