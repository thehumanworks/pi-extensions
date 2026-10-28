//! The transcript model: messages and events folded into display items.
//!
//! Kept free of GPUI so it can be tested without a window.

use pi_bot_api::{
    Conversation, ConversationState, DeltaKind, Message, Partial, Request, Role, StreamEvent,
    ToolPhase, Update,
};

/// One row of the transcript.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    User {
        text: String,
    },
    Assistant {
        text: String,
        thinking: Option<String>,
        streaming: bool,
    },
    /// A tool call with its result once it ended.
    Tool {
        call_id: String,
        name: String,
        summary: String,
        result: Option<ToolResult>,
    },
    /// A line from the server or the bot's host that is not part of the dialogue.
    Notice {
        level: NoticeLevel,
        text: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

impl From<pi_bot_api::NoticeLevel> for NoticeLevel {
    fn from(level: pi_bot_api::NoticeLevel) -> Self {
        match level {
            pi_bot_api::NoticeLevel::Info => NoticeLevel::Info,
            pi_bot_api::NoticeLevel::Warning => NoticeLevel::Warning,
            pi_bot_api::NoticeLevel::Error => NoticeLevel::Error,
        }
    }
}

/// Everything shown for one conversation, updated from snapshots and streams.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Transcript {
    items: Vec<Item>,
    /// The assistant message being streamed; shown after `items`.
    partial: Option<Partial>,
    pending: Vec<Request>,
    state: ConversationState,
    model: Option<String>,
    thinking: Option<String>,
    offset: u64,
}

impl Transcript {
    pub fn from_snapshot(snapshot: &Conversation) -> Self {
        let mut transcript = Self {
            items: Vec::new(),
            partial: snapshot
                .partial
                .clone()
                .filter(|partial| !partial.text.is_empty() || !partial.thinking.is_empty()),
            pending: snapshot.pending_requests.clone(),
            state: snapshot.summary.state,
            model: snapshot.model.clone(),
            thinking: snapshot.thinking.clone(),
            offset: snapshot.offset,
        };
        for message in &snapshot.messages {
            transcript.push_message(message);
        }
        transcript
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    pub fn partial(&self) -> Option<&Partial> {
        self.partial.as_ref()
    }

    pub fn pending(&self) -> &[Request] {
        &self.pending
    }

    pub fn state(&self) -> ConversationState {
        self.state
    }

    pub fn is_running(&self) -> bool {
        !matches!(self.state, ConversationState::Idle)
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn thinking(&self) -> Option<&str> {
        self.thinking.as_deref()
    }

    /// The stream offset to subscribe from so nothing is missed or repeated.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Moves the subscription point forward, for example to where the server
    /// placed the first message of a conversation it just created.
    pub fn set_offset(&mut self, offset: u64) {
        self.offset = self.offset.max(offset);
    }

    /// Rows to render: items, then the streaming message, then open requests.
    pub fn row_count(&self) -> usize {
        self.items.len() + usize::from(self.partial.is_some()) + self.pending.len()
    }

    pub fn row(&self, index: usize) -> Option<Row<'_>> {
        if let Some(item) = self.items.get(index) {
            return Some(Row::Item(item));
        }
        let mut rest = index - self.items.len();
        if let Some(partial) = &self.partial {
            if rest == 0 {
                return Some(Row::Partial(partial));
            }
            rest -= 1;
        }
        self.pending.get(rest).map(Row::Request)
    }

    /// Applies one stream update. Returns `true` when the offset was new.
    /// Gaps are reported through [`Applied::Gap`] so the owner can take a new snapshot.
    pub fn apply(&mut self, update: &Update) -> Applied {
        if update.offset < self.offset {
            return Applied::Stale;
        }
        self.offset = update.offset + 1;
        match &update.event {
            StreamEvent::Status {
                state,
                model,
                thinking,
            } => {
                self.state = *state;
                if model.is_some() {
                    self.model = model.clone();
                }
                if thinking.is_some() {
                    self.thinking = thinking.clone();
                }
                if matches!(state, ConversationState::Idle) {
                    self.partial = None;
                }
            }
            StreamEvent::Delta { kind, text } => {
                let partial = self.partial.get_or_insert_with(Partial::default);
                match kind {
                    DeltaKind::Text => partial.text.push_str(text),
                    DeltaKind::Thinking => partial.thinking.push_str(text),
                }
            }
            StreamEvent::Message { message } => {
                if message.role == Role::Assistant {
                    self.partial = None;
                }
                self.push_message(message);
            }
            StreamEvent::Tool {
                phase: ToolPhase::Start,
                tool_call_id,
                tool_name,
                args,
                ..
            } => {
                if !self.items.iter().any(
                    |item| matches!(item, Item::Tool { call_id, .. } if call_id == tool_call_id),
                ) {
                    self.items.push(Item::Tool {
                        call_id: tool_call_id.clone(),
                        name: tool_name.clone(),
                        summary: summarize_args(tool_name, args.as_ref()),
                        result: None,
                    });
                }
            }
            StreamEvent::Tool {
                phase: ToolPhase::End,
                tool_call_id,
                is_error,
                summary,
                ..
            } => {
                if let Some(Item::Tool { result, .. }) = self.items.iter_mut().find(
                    |item| matches!(item, Item::Tool { call_id, .. } if call_id == tool_call_id),
                ) {
                    *result = Some(ToolResult {
                        text: summary.clone().unwrap_or_default(),
                        is_error: is_error.unwrap_or(false),
                    });
                }
            }
            StreamEvent::Request(request) => {
                if !self.pending.iter().any(|pending| pending.id == request.id) {
                    self.pending.push(request.clone());
                }
            }
            StreamEvent::RequestClosed { request_id } => {
                self.pending.retain(|request| &request.id != request_id)
            }
            StreamEvent::Notice { level, message } => self.items.push(Item::Notice {
                level: (*level).into(),
                text: message.clone(),
            }),
            StreamEvent::Error { message } => self.items.push(Item::Notice {
                level: NoticeLevel::Error,
                text: message.clone(),
            }),
            StreamEvent::Settled { aborted } => {
                self.state = ConversationState::Idle;
                if let Some(partial) = self
                    .partial
                    .take()
                    .filter(|partial| !partial.text.is_empty())
                {
                    self.items.push(Item::Assistant {
                        text: partial.text,
                        thinking: Some(partial.thinking).filter(|t| !t.is_empty()),
                        streaming: false,
                    });
                }
                if *aborted {
                    self.items.push(Item::Notice {
                        level: NoticeLevel::Warning,
                        text: "Stopped.".into(),
                    });
                }
                self.pending.clear();
            }
            StreamEvent::Gap { .. } => return Applied::Gap,
        }
        Applied::Changed
    }

    /// Optimistically shows the person's message before the server echoes it.
    /// The echo is skipped when it matches the last user item.
    pub fn push_local_user(&mut self, text: &str) {
        self.items.push(Item::User {
            text: text.to_string(),
        });
        self.state = ConversationState::Running;
    }

    fn push_message(&mut self, message: &Message) {
        match message.role {
            Role::User => {
                if matches!(self.items.last(), Some(Item::User { text }) if *text == message.text) {
                    return;
                }
                self.items.push(Item::User {
                    text: message.text.clone(),
                });
            }
            Role::Assistant => {
                let text = message.text.trim();
                let has_text = !text.is_empty();
                if has_text || message.tool_calls.is_empty() {
                    let text = if has_text {
                        text.to_string()
                    } else {
                        message
                            .error_message
                            .clone()
                            .unwrap_or_else(|| "(no reply)".into())
                    };
                    // While streaming, tool rows arrive before the message that
                    // carries their text; the text still belongs in front of them.
                    let before_own_tools = self
                        .items
                        .iter()
                        .position(|item| {
                            matches!(item, Item::Tool { call_id, .. }
                                if message.tool_calls.iter().any(|call| call.id == *call_id))
                        })
                        .unwrap_or(self.items.len());
                    self.items.insert(
                        before_own_tools,
                        Item::Assistant {
                            text,
                            thinking: message.thinking.clone().filter(|t| !t.trim().is_empty()),
                            streaming: false,
                        },
                    );
                }
                for call in &message.tool_calls {
                    if !self.items.iter().any(
                        |item| matches!(item, Item::Tool { call_id, .. } if *call_id == call.id),
                    ) {
                        self.items.push(Item::Tool {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            summary: summarize_args(&call.name, Some(&call.arguments)),
                            result: None,
                        });
                    }
                }
                if let Some(error) = &message.error_message
                    && has_text
                {
                    self.items.push(Item::Notice {
                        level: NoticeLevel::Error,
                        text: error.clone(),
                    });
                }
            }
            Role::ToolResult => {
                let Some(call_id) = &message.tool_call_id else {
                    return;
                };
                match self
                    .items
                    .iter_mut()
                    .find(|item| matches!(item, Item::Tool { call_id: id, .. } if id == call_id))
                {
                    Some(Item::Tool { result, .. }) => {
                        *result = Some(ToolResult {
                            text: message.text.clone(),
                            is_error: message.is_error.unwrap_or(false),
                        })
                    }
                    _ => self.items.push(Item::Tool {
                        call_id: call_id.clone(),
                        name: message.tool_name.clone().unwrap_or_else(|| "tool".into()),
                        summary: String::new(),
                        result: Some(ToolResult {
                            text: message.text.clone(),
                            is_error: message.is_error.unwrap_or(false),
                        }),
                    }),
                }
            }
        }
    }
}

/// What a tool call did, in one line: the command, path or query when known.
fn summarize_args(tool: &str, args: Option<&serde_json::Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    let keys = [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "task",
        "message",
        "cmd",
    ];
    let text = keys
        .iter()
        .find_map(|key| {
            args.get(key)
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| args.to_string());
    let first_line = text.lines().next().unwrap_or_default();
    let _ = tool;
    truncate(first_line, 120)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    Changed,
    /// Older than what is already shown.
    Stale,
    /// The server no longer has the events from this offset.
    Gap,
}

pub enum Row<'a> {
    Item(&'a Item),
    Partial(&'a Partial),
    Request(&'a Request),
}

#[cfg(test)]
mod tests {
    use super::*;
    use pi_bot_api::{ConversationSummary, RequestMethod};

    fn update(offset: u64, event: StreamEvent) -> Update {
        Update { offset, event }
    }

    fn snapshot() -> Conversation {
        Conversation {
            summary: ConversationSummary {
                id: "c1".into(),
                bot: "tbot".into(),
                ..Default::default()
            },
            offset: 3,
            messages: vec![
                Message {
                    role: Role::User,
                    text: "hi".into(),
                    ..blank()
                },
                Message {
                    role: Role::Assistant,
                    text: "Checking.".into(),
                    tool_calls: vec![pi_bot_api::ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "pwd"}),
                    }],
                    ..blank()
                },
                Message {
                    role: Role::ToolResult,
                    text: "/tmp\n".into(),
                    tool_call_id: Some("t1".into()),
                    tool_name: Some("bash".into()),
                    is_error: Some(false),
                    ..blank()
                },
                Message {
                    role: Role::Assistant,
                    text: "You are in /tmp.".into(),
                    ..blank()
                },
            ],
            ..Default::default()
        }
    }

    fn blank() -> Message {
        Message {
            id: None,
            role: Role::User,
            timestamp: None,
            text: String::new(),
            thinking: None,
            tool_calls: vec![],
            tool_call_id: None,
            tool_name: None,
            is_error: None,
            model: None,
            stop_reason: None,
            error_message: None,
            usage: None,
        }
    }

    #[test]
    fn streamed_tool_rows_keep_their_text_in_front() {
        let mut transcript = Transcript::default();
        transcript.apply(&update(
            0,
            StreamEvent::Tool {
                phase: ToolPhase::Start,
                tool_call_id: "t1".into(),
                tool_name: "bash".into(),
                args: Some(serde_json::json!({"command": "pwd"})),
                is_error: None,
                duration_ms: None,
                summary: None,
            },
        ));
        transcript.apply(&update(
            1,
            StreamEvent::Message {
                message: Message {
                    role: Role::Assistant,
                    text: "Checking.".into(),
                    tool_calls: vec![pi_bot_api::ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({}),
                    }],
                    ..blank()
                },
            },
        ));
        assert_eq!(
            transcript.items()[0],
            Item::Assistant {
                text: "Checking.".into(),
                thinking: None,
                streaming: false
            }
        );
        assert!(matches!(transcript.items()[1], Item::Tool { ref call_id, .. } if call_id == "t1"));
        assert_eq!(transcript.row_count(), 2);
    }

    #[test]
    fn folds_tool_calls_and_results_into_one_row() {
        let transcript = Transcript::from_snapshot(&snapshot());
        assert_eq!(transcript.row_count(), 4);
        assert_eq!(transcript.items()[0], Item::User { text: "hi".into() });
        assert_eq!(
            transcript.items()[1],
            Item::Assistant {
                text: "Checking.".into(),
                thinking: None,
                streaming: false
            }
        );
        assert_eq!(
            transcript.items()[2],
            Item::Tool {
                call_id: "t1".into(),
                name: "bash".into(),
                summary: "pwd".into(),
                result: Some(ToolResult {
                    text: "/tmp\n".into(),
                    is_error: false
                })
            }
        );
        assert_eq!(
            transcript.items()[3],
            Item::Assistant {
                text: "You are in /tmp.".into(),
                thinking: None,
                streaming: false
            }
        );
        assert_eq!(transcript.offset(), 3);
    }

    #[test]
    fn streams_deltas_into_a_partial_then_a_message() {
        let mut transcript = Transcript::from_snapshot(&snapshot());
        transcript.push_local_user("again");
        assert!(transcript.is_running());

        assert_eq!(
            transcript.apply(&update(
                3,
                StreamEvent::Status {
                    state: ConversationState::Running,
                    model: Some("xai/grok-4.7".into()),
                    thinking: None
                }
            )),
            Applied::Changed
        );
        assert_eq!(
            transcript.apply(&update(
                4,
                StreamEvent::Message {
                    message: Message {
                        role: Role::User,
                        text: "again".into(),
                        ..blank()
                    }
                }
            )),
            Applied::Changed
        );
        assert_eq!(
            transcript
                .items()
                .iter()
                .filter(|item| matches!(item, Item::User { .. }))
                .count(),
            2,
            "the echo of the local message is not duplicated"
        );
        transcript.apply(&update(
            5,
            StreamEvent::Delta {
                kind: DeltaKind::Text,
                text: "Hel".into(),
            },
        ));
        transcript.apply(&update(
            6,
            StreamEvent::Delta {
                kind: DeltaKind::Text,
                text: "lo".into(),
            },
        ));
        assert_eq!(transcript.partial().unwrap().text, "Hello");
        assert_eq!(transcript.row_count(), 6);
        assert!(matches!(transcript.row(5), Some(Row::Partial(_))));

        transcript.apply(&update(
            7,
            StreamEvent::Message {
                message: Message {
                    role: Role::Assistant,
                    text: "Hello".into(),
                    ..blank()
                },
            },
        ));
        assert!(transcript.partial().is_none());
        transcript.apply(&update(8, StreamEvent::Settled { aborted: false }));
        assert!(!transcript.is_running());
        assert_eq!(transcript.offset(), 9);
        assert_eq!(
            transcript.apply(&update(2, StreamEvent::Settled { aborted: false })),
            Applied::Stale
        );
        assert_eq!(transcript.model(), Some("xai/grok-4.7"));
    }

    #[test]
    fn requests_open_and_close_and_gaps_are_reported() {
        let mut transcript = Transcript::default();
        let request = Request {
            id: "r1".into(),
            method: RequestMethod::Confirm,
            title: "Send email?".into(),
            message: None,
            options: vec![],
            placeholder: None,
            prefill: None,
        };
        transcript.apply(&update(0, StreamEvent::Request(request.clone())));
        assert_eq!(transcript.pending(), &[request]);
        assert!(matches!(transcript.row(0), Some(Row::Request(_))));
        transcript.apply(&update(
            1,
            StreamEvent::RequestClosed {
                request_id: "r1".into(),
            },
        ));
        assert!(transcript.pending().is_empty());
        assert_eq!(
            transcript.apply(&update(
                2,
                StreamEvent::Gap {
                    from: 2,
                    first_offset: 10
                }
            )),
            Applied::Gap
        );
        transcript.apply(&update(3, StreamEvent::Settled { aborted: true }));
        assert_eq!(
            transcript.items().last(),
            Some(&Item::Notice {
                level: NoticeLevel::Warning,
                text: "Stopped.".into()
            })
        );
    }
}
