//! Wire types, one per schema in the server's OpenAPI document.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub name: String,
    pub description: String,
    /// `provider/model-id`; `None` inherits the host's model.
    pub model: Option<String>,
    pub thinking: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    /// The persona: the body of BOT.md.
    pub prompt: String,
    pub home: String,
    pub file: String,
    /// The complete BOT.md; only `GET /bots/{bot}` includes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCreate {
    pub name: String,
    pub description: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

/// A partial update: only the fields that were set are sent; `None` for an
/// optional setting sends `null`, which clears it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct BotPatch {
    fields: serde_json::Map<String, Value>,
}

impl BotPatch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.fields
            .insert("description".into(), description.into().into());
        self
    }

    pub fn prompt(mut self, prompt: impl Into<String>) -> Self {
        self.fields.insert("prompt".into(), prompt.into().into());
        self
    }

    pub fn model(mut self, model: Option<&str>) -> Self {
        self.fields.insert("model".into(), model.into());
        self
    }

    pub fn thinking(mut self, thinking: Option<&str>) -> Self {
        self.fields.insert("thinking".into(), thinking.into());
        self
    }

    pub fn tools(mut self, tools: &[String]) -> Self {
        self.fields.insert("tools".into(), tools.into());
        self
    }

    pub fn skills(mut self, skills: &[String]) -> Self {
        self.fields.insert("skills".into(), skills.into());
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationState {
    #[default]
    Idle,
    Starting,
    Running,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub bot: String,
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub first_message: Option<String>,
    /// RFC 3339 timestamp of the last change.
    pub modified: String,
    pub state: ConversationState,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    #[serde(flatten)]
    pub summary: ConversationSummary,
    /// Subscribe from here to miss nothing after this snapshot.
    pub offset: u64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// The assistant message being streamed right now.
    #[serde(default)]
    pub partial: Option<Partial>,
    #[serde(default)]
    pub pending_requests: Vec<Request>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
    ToolResult,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(default)]
    pub id: Option<String>,
    pub role: Role,
    /// Milliseconds since the epoch.
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct Partial {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thinking: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestMethod {
    Select,
    Confirm,
    Input,
    Editor,
}

/// A question the bot (an extension in its Pi process) asks the person.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub method: RequestMethod,
    pub title: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub prefill: Option<String>,
}

/// The answer to a [`Request`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

impl Answer {
    pub fn value(request_id: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            value: Some(value.into()),
            confirmed: None,
            cancelled: None,
        }
    }

    pub fn confirmed(request_id: impl Into<String>, confirmed: bool) -> Self {
        Self {
            request_id: request_id.into(),
            value: None,
            confirmed: Some(confirmed),
            cancelled: None,
        }
    }

    pub fn cancelled(request_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            value: None,
            confirmed: None,
            cancelled: Some(true),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub submission_id: String,
    pub disposition: String,
    pub offset: u64,
    /// Relative URL of the update stream starting just before the message.
    pub stream_url: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// `provider/model-id`, the value a bot's `model` takes.
    pub id: String,
    pub provider: String,
    pub model_id: String,
    pub name: String,
    pub reasoning: bool,
    pub context_window: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeltaKind {
    Text,
    Thinking,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPhase {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// One server-sent event of a conversation's update stream.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum StreamEvent {
    Status {
        state: ConversationState,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        thinking: Option<String>,
    },
    Delta {
        kind: DeltaKind,
        text: String,
    },
    Message {
        message: Message,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        phase: ToolPhase,
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Option<Value>,
        #[serde(default)]
        is_error: Option<bool>,
        #[serde(default)]
        duration_ms: Option<f64>,
        #[serde(default)]
        summary: Option<String>,
    },
    Request(Request),
    #[serde(rename_all = "camelCase")]
    RequestClosed {
        request_id: String,
    },
    Notice {
        level: NoticeLevel,
        message: String,
    },
    Error {
        message: String,
    },
    Settled {
        aborted: bool,
    },
    /// The requested offset is older than the server keeps: take a new snapshot.
    #[serde(rename_all = "camelCase")]
    Gap {
        from: u64,
        first_offset: u64,
    },
}

/// A stream event with its position in the stream.
#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    pub offset: u64,
    pub event: StreamEvent,
}
