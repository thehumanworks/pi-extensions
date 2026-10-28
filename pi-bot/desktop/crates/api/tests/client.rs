//! The client against a scripted HTTP server: request shapes, decoding, error
//! mapping and the update stream.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use pi_bot_api::{
    Answer, BotCreate, BotPatch, Client, ConversationState, Error, Role, StreamEvent,
};

struct Received {
    method: String,
    path: String,
    body: String,
}

/// Serves one scripted response per connection, in order, and reports what it received.
fn serve(responses: Vec<&'static str>) -> (String, mpsc::Receiver<Received>) {
    let listener = TcpListener::bind("[::1]:0").unwrap();
    let url = format!("http://[::1]:{}", listener.local_addr().unwrap().port());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap().to_string();
            let path = parts.next().unwrap().to_string();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            tx.send(Received {
                method,
                path,
                body: String::from_utf8(body).unwrap(),
            })
            .unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    (url, rx)
}

fn json_response(status: &str, body: &str) -> &'static str {
    Box::leak(format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_boxed_str())
}

#[test]
fn reads_bots_and_sends_the_documented_bodies() {
    let (url, received) = serve(vec![
        json_response(
            "200 OK",
            r#"{"bots":[{"name":"tbot","description":"test bot","model":"xai/grok-4.7","thinking":null,"tools":[],"skills":[],"prompt":"Be terse.","home":"/h/tbot","file":"/h/tbot/BOT.md"}],"errors":["bad/BOT.md: no description"]}"#,
        ),
        json_response(
            "201 Created",
            r#"{"name":"new","description":"d","model":null,"thinking":"high","tools":["read"],"skills":[],"prompt":"p","home":"/h/new","file":"/h/new/BOT.md"}"#,
        ),
        json_response(
            "200 OK",
            r#"{"name":"new","description":"d2","model":null,"thinking":null,"tools":[],"skills":[],"prompt":"p","home":"/h/new","file":"/h/new/BOT.md"}"#,
        ),
        json_response(
            "202 Accepted",
            r#"{"submissionId":"s1","disposition":"started","offset":4,"streamUrl":"/bots/new/conversations/c1?view=updates&offset=4"}"#,
        ),
        json_response("200 OK", r#"{"requestId":"r1","closed":true}"#),
    ]);
    let client = Client::new(&format!("{url}/"));

    let (bots, errors) = client.bots().unwrap();
    assert_eq!(bots[0].name, "tbot");
    assert_eq!(bots[0].model.as_deref(), Some("xai/grok-4.7"));
    assert_eq!(errors, vec!["bad/BOT.md: no description"]);
    let got = received.recv().unwrap();
    assert_eq!(
        (got.method.as_str(), got.path.as_str(), got.body.as_str()),
        ("GET", "/bots", "")
    );

    let created = client
        .create_bot(&BotCreate {
            name: "new".into(),
            description: "d".into(),
            prompt: "p".into(),
            thinking: Some("high".into()),
            tools: vec!["read".into()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(created.thinking.as_deref(), Some("high"));
    let got = received.recv().unwrap();
    assert_eq!(got.method, "POST");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&got.body).unwrap(),
        serde_json::json!({"name":"new","description":"d","prompt":"p","thinking":"high","tools":["read"]})
    );

    client
        .update_bot(
            "new",
            &BotPatch::new().description("d2").model(None).tools(&[]),
        )
        .unwrap();
    let got = received.recv().unwrap();
    assert_eq!(
        (got.method.as_str(), got.path.as_str()),
        ("PATCH", "/bots/new")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&got.body).unwrap(),
        serde_json::json!({"description":"d2","model":null,"tools":[]})
    );

    let submission = client.send("new", "c1", "hello", Some("/work")).unwrap();
    assert_eq!(submission.offset, 4);
    let got = received.recv().unwrap();
    assert_eq!(got.path, "/bots/new/conversations/c1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&got.body).unwrap(),
        serde_json::json!({"message":"hello","cwd":"/work"})
    );

    client
        .answer("new", "c1", &Answer::confirmed("r1", true))
        .unwrap();
    let got = received.recv().unwrap();
    assert_eq!(got.path, "/bots/new/conversations/c1/responses");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&got.body).unwrap(),
        serde_json::json!({"requestId":"r1","confirmed":true})
    );
}

#[test]
fn decodes_a_conversation_snapshot() {
    let (url, _received) = serve(vec![json_response(
        "200 OK",
        r#"{"id":"c1","bot":"tbot","cwd":"/tmp","modified":"2026-10-27T15:00:00.000Z","state":"idle","offset":30,"model":"xai/grok-4.7","thinking":"medium",
            "messages":[{"timestamp":1,"role":"user","text":"hi"},{"timestamp":2,"role":"assistant","text":"Hello.","thinking":"t","toolCalls":[{"id":"c","name":"bash","arguments":{"command":"pwd"}}],"model":"xai/grok-4.7","stopReason":"stop","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":0.5}},{"role":"toolResult","text":"/tmp","toolCallId":"c","toolName":"bash","isError":false}],
            "pendingRequests":[{"id":"r","method":"confirm","title":"Send?","message":"To: x"}]}"#,
    )]);
    let conversation = Client::new(&url).conversation("tbot", "c1").unwrap();
    assert_eq!(conversation.summary.state, ConversationState::Idle);
    assert_eq!(conversation.offset, 30);
    assert_eq!(
        conversation
            .messages
            .iter()
            .map(|m| m.role)
            .collect::<Vec<_>>(),
        [Role::User, Role::Assistant, Role::ToolResult]
    );
    assert_eq!(
        conversation.messages[1].tool_calls[0].arguments["command"],
        "pwd"
    );
    assert_eq!(conversation.messages[1].usage.as_ref().unwrap().cost, 0.5);
    assert_eq!(conversation.pending_requests[0].title, "Send?");
}

#[test]
fn errors_carry_the_server_message_and_unreachable_servers_are_transport_errors() {
    let (url, _received) = serve(vec![json_response(
        "404 Not Found",
        r#"{"error":{"status":404,"message":"Unknown bot \"x\"."}}"#,
    )]);
    let error = Client::new(&url).bot("x").unwrap_err();
    assert!(error.is_not_found());
    assert_eq!(error.to_string(), "Unknown bot \"x\".");

    let closed = TcpListener::bind("[::1]:0").unwrap();
    let dead = format!("http://[::1]:{}", closed.local_addr().unwrap().port());
    drop(closed);
    assert!(matches!(
        Client::new(&dead).health(),
        Err(Error::Transport(_))
    ));
}

#[test]
fn follows_an_update_stream_until_the_server_closes_it() {
    let body = "id: 4\nevent: status\ndata: {\"state\":\"running\"}\n\n: ping\n\nid: 5\nevent: delta\ndata: {\"kind\":\"text\",\"text\":\"ok\"}\n\nid: 6\nevent: settled\ndata: {\"aborted\":false}\n\n";
    let response = Box::leak(format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_boxed_str());
    let (url, received) = serve(vec![response]);
    let updates = Client::new(&url).updates("tbot", "c1", 4).unwrap();
    let collected: Vec<_> = updates.map(|update| update.unwrap()).collect();
    assert_eq!(
        received.recv().unwrap().path,
        "/bots/tbot/conversations/c1?view=updates&offset=4"
    );
    assert_eq!(
        collected.iter().map(|u| u.offset).collect::<Vec<_>>(),
        [4, 5, 6]
    );
    assert_eq!(
        collected[1].event,
        StreamEvent::Delta {
            kind: pi_bot_api::DeltaKind::Text,
            text: "ok".into()
        }
    );
    assert_eq!(collected[2].event, StreamEvent::Settled { aborted: false });
}
