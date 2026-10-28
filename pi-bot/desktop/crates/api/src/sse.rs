//! Server-sent events, read as a blocking iterator over one HTTP response.
//! Callers pull the next event from a background thread; dropping the
//! [`Updates`] closes the connection after the read in flight.

use std::io::{BufRead, BufReader, Lines, Read};
use std::time::Duration;

use ureq::Agent;

use crate::client::{Error, Result};
use crate::types::{StreamEvent, Update};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A live update stream. Each [`Iterator::next`] blocks until the server sends
/// an event (keep-alive comments are skipped) and ends once the stream closes.
/// An `Err` item is final: the connection broke.
pub struct Updates {
    lines: Lines<BufReader<Box<dyn Read + Send>>>,
    block: Vec<String>,
}

impl Updates {
    pub(crate) fn open(url: &str) -> Result<Self> {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_global(None)
            .build()
            .new_agent();
        let response = agent.get(url).call()?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(Error::Http {
                status,
                message: format!("The update stream answered with status {status}."),
            });
        }
        let reader: Box<dyn Read + Send> = Box::new(response.into_body().into_reader());
        Ok(Self {
            lines: BufReader::new(reader).lines(),
            block: Vec::new(),
        })
    }
}

impl Iterator for Updates {
    type Item = Result<Update>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.lines.next()? {
                Ok(line) if line.is_empty() => {
                    let update = parse_block(&self.block);
                    self.block.clear();
                    if let Some(update) = update {
                        return Some(Ok(update));
                    }
                }
                Ok(line) => self.block.push(line),
                Err(error) => return Some(Err(Error::Transport(error.to_string()))),
            }
        }
    }
}

/// One SSE block: `id`, `event` and `data` lines (comments start with `:`).
/// Blocks without an event name, such as keep-alives, yield `None`.
pub(crate) fn parse_block(lines: &[String]) -> Option<Update> {
    let mut id = None;
    let mut event = None;
    let mut data = String::new();
    for line in lines {
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line.as_str(), ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" => id = value.parse::<u64>().ok(),
            "event" => event = Some(value.to_string()),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            _ => {}
        }
    }
    let event = event?;
    let tagged = serde_json::json!({ "event": event, "data": serde_json::from_str::<serde_json::Value>(&data).ok()? });
    let event = serde_json::from_value::<StreamEvent>(tagged).ok()?;
    Some(Update { offset: id?, event })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ConversationState, DeltaKind, ToolPhase};

    fn block(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    #[test]
    fn parses_events_with_offsets() {
        let update = parse_block(&block(
            "id: 7\nevent: delta\ndata: {\"kind\":\"text\",\"text\":\"Hi\"}",
        ))
        .unwrap();
        assert_eq!(update.offset, 7);
        assert_eq!(
            update.event,
            StreamEvent::Delta {
                kind: DeltaKind::Text,
                text: "Hi".into()
            }
        );

        let update = parse_block(&block(
            "id: 1\nevent: status\ndata: {\"state\":\"running\",\"model\":\"xai/grok-4.7\"}",
        ))
        .unwrap();
        assert_eq!(
            update.event,
            StreamEvent::Status {
                state: ConversationState::Running,
                model: Some("xai/grok-4.7".into()),
                thinking: None
            }
        );

        let update = parse_block(&block(
            "id: 17\nevent: tool\ndata: {\"phase\":\"end\",\"toolCallId\":\"c1\",\"toolName\":\"bash\",\"isError\":false,\"durationMs\":12,\"summary\":\"/tmp\\n\"}",
        ))
        .unwrap();
        match update.event {
            StreamEvent::Tool {
                phase,
                tool_name,
                summary,
                ..
            } => {
                assert_eq!(phase, ToolPhase::End);
                assert_eq!(tool_name, "bash");
                assert_eq!(summary.as_deref(), Some("/tmp\n"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn keep_alives_and_unknown_events_are_skipped() {
        assert_eq!(parse_block(&block(": ping")), None);
        assert_eq!(parse_block(&block(": updates from 3")), None);
        assert_eq!(parse_block(&block("id: 2\nevent: made_up\ndata: {}")), None);
        assert_eq!(
            parse_block(&block("id: 2\nevent: settled\ndata: {\"aborted\":true}"))
                .unwrap()
                .event,
            StreamEvent::Settled { aborted: true }
        );
    }
}
