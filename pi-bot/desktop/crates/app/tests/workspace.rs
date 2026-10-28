//! The window against a scripted server: the roster loads, the first bot is
//! selected, a message typed into the composer is posted and the streamed
//! reply lands in the transcript.

mod support;

use std::time::{Duration, Instant};

use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, ElementId, TestAppContext, Window, WindowBounds,
    WindowOptions, px, size,
};
use pi_bot_api::Client;
use pi_bot_conversation::Item;
use pi_bot_desktop::Workspace;

use support::FakeServer;

/// Server replies arrive on real threads, so waits are measured in wall time.
const TIMEOUT: Duration = Duration::from_secs(10);
/// How far the GPUI test clock moves per poll, so animations and timers run.
const TICK: Duration = Duration::from_millis(50);

fn wait_until(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    what: &str,
    mut ready: impl FnMut(&mut Window, &mut App) -> bool,
) {
    let started = Instant::now();
    loop {
        cx.executor().advance_clock(TICK);
        cx.run_until_parked();
        let done = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                ready(window, cx)
            })
            .expect("the window is open");
        if done {
            return;
        }
        assert!(
            started.elapsed() < TIMEOUT,
            "timed out waiting until {what}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn keyed(prefix: &'static str, key: &str) -> ElementId {
    (ElementId::from(prefix), key.to_string()).into()
}

#[gpui_kit::test]
fn lists_bots_and_sends_a_message(cx: &mut TestAppContext) {
    let server = FakeServer::start(support::standard);
    let client = Client::new(&server.url);
    cx.update(gpui_kit::init);
    let (handle, workspace) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(700.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| Workspace::new(client, window, cx)),
            )
        })
        .expect("open window");
    let handle: AnyWindowHandle = handle;

    // The roster loads and the first bot opens with its conversations.
    wait_until(cx, handle, "the roster has loaded", |_, cx| {
        !workspace.read(cx).roster().read(cx).state().is_loading()
    });
    cx.update(|cx| {
        let roster = workspace.read(cx).roster().read(cx);
        assert_eq!(roster.state().error(), None);
        assert_eq!(roster.bots().len(), 1);
    });
    wait_until(cx, handle, "the first bot is selected", |window, cx| {
        workspace.read(cx).selected_bot() == Some("reviewer")
            && window.try_find(keyed("conversation", "older")).is_some()
            && window.try_find("send").is_some()
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("send").label(), Some("Send message"));
        assert!(window.find_by_label("New conversation").visible());
        assert!(window.find_by_label("Edit bot…").visible());
        assert!(window.find_by_label("Archive bot…").visible());
        assert!(window.find_by_label("Delete conversation older…").visible());
    })
    .unwrap();

    // Enter in the composer posts the message; the scripted stream answers.
    cx.update_window(handle, |_, window, cx| {
        let view = workspace
            .read(cx)
            .active_conversation()
            .cloned()
            .expect("a conversation is open");
        view.update(cx, |view, cx| view.focus_composer(window, cx));
        window.render_frame(cx);
        window.input("Check this", cx);
        window.press("enter", cx);
    })
    .unwrap();
    wait_until(cx, handle, "the reply has streamed in", |_, cx| {
        let view = workspace.read(cx).active_conversation().unwrap().read(cx);
        view.transcript()
            .items()
            .iter()
            .any(|item| matches!(item, Item::Assistant { text, .. } if text == "Looks fine."))
    });

    let posted = server
        .received()
        .into_iter()
        .find(|request| request.method == "POST")
        .expect("the message was posted");
    assert!(
        posted.path.starts_with("/bots/reviewer/conversations/"),
        "{}",
        posted.path
    );
    let body: serde_json::Value = serde_json::from_str(&posted.body).unwrap();
    assert_eq!(body["message"], "Check this");
    cx.update(|cx| {
        let view = workspace.read(cx).active_conversation().unwrap().read(cx);
        let items = view.transcript().items();
        assert!(matches!(&items[0], Item::User { text } if text == "Check this"));
        assert!(!view.is_running(), "the stream settled");
    });
}

#[test]
fn fake_server_answers_plain_clients() {
    let server = FakeServer::start(support::standard);
    let client = Client::new(&server.url);
    let (bots, _) = client.bots().expect("bots");
    assert_eq!(bots[0].name, "reviewer");
    assert_eq!(server.received()[0].path, "/bots");
}

#[gpui_kit::test]
fn the_new_bot_sheet_validates_before_creating(cx: &mut TestAppContext) {
    let server = FakeServer::start(support::standard);
    let client = Client::new(&server.url);
    cx.update(gpui_kit::init);
    let (handle, workspace) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(700.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| Workspace::new(client, window, cx)),
            )
        })
        .expect("open window");
    let handle: AnyWindowHandle = handle;
    wait_until(cx, handle, "the first bot is selected", |_, cx| {
        workspace.read(cx).selected_bot() == Some("reviewer")
    });

    // The + button opens the sheet, which slides in before it takes input.
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("new-bot", cx);
        assert_eq!(window.find("save-bot").label(), Some("Create"));
        assert!(workspace.read(cx).editor().is_some());
    })
    .unwrap();
    wait_until(cx, handle, "the sheet has slid in", |window, _| {
        window.find("save-bot").visible() && window.find_by_label("Name").focused() == Some(true)
    });

    // Create with an empty name explains what is missing instead of creating.
    // (In the real window Enter in the name field does the same; the headless
    // harness does not deliver Enter into a sheet, so the test clicks.)
    cx.update_window(handle, |_, window, cx| {
        window.click("save-bot", cx);
        let editor = workspace.read(cx).editor().unwrap().read(cx);
        assert_eq!(
            editor.error(),
            Some("Enter a name: lowercase letters, digits, - or _.")
        );
        assert!(
            server
                .received()
                .iter()
                .all(|request| request.method != "POST"),
            "nothing was created"
        );
    })
    .unwrap();

    // Escape closes the sheet and drops the editor.
    cx.update_window(handle, |_, window, cx| {
        window.press("escape", cx);
        window.render_frame(cx);
        assert!(window.try_find("save-bot").is_none());
    })
    .unwrap();
    wait_until(cx, handle, "the editor is closed", |_, cx| {
        workspace.read(cx).editor().is_none()
    });
}

#[gpui_kit::test]
fn creating_a_bot_posts_it_and_selects_it(cx: &mut TestAppContext) {
    let server = FakeServer::start(support::with_creation());
    let client = Client::new(&server.url);
    cx.update(gpui_kit::init);
    let (handle, workspace) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(700.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| Workspace::new(client, window, cx)),
            )
        })
        .expect("open window");
    let handle: AnyWindowHandle = handle;
    wait_until(cx, handle, "the first bot is selected", |_, cx| {
        workspace.read(cx).selected_bot() == Some("reviewer")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("new-bot", cx);
    })
    .unwrap();
    wait_until(cx, handle, "the sheet has slid in", |window, _| {
        window.find("save-bot").visible() && window.find_by_label("Name").focused() == Some(true)
    });

    // Fill the required fields plus a tool list, then create.
    cx.update_window(handle, |_, window, cx| {
        window.input("helper", cx);
        window.click("bot-description", cx);
        window.input("Helps out", cx);
        window.click("bot-persona", cx);
        window.input("Be helpful.", cx);
        window.click("bot-tools", cx);
        window.input("read", cx);
        window.click("save-bot", cx);
    })
    .unwrap();
    wait_until(cx, handle, "the new bot is selected", |window, cx| {
        workspace.read(cx).selected_bot() == Some("helper") && window.try_find("save-bot").is_none()
    });

    let posted = server
        .received()
        .into_iter()
        .find(|request| request.method == "POST" && request.path == "/bots")
        .expect("the bot was posted");
    let body: serde_json::Value = serde_json::from_str(&posted.body).unwrap();
    assert_eq!(body["name"], "helper");
    assert_eq!(body["description"], "Helps out");
    assert_eq!(body["prompt"], "Be helpful.");
    assert_eq!(body["tools"], serde_json::json!(["read"]));
    assert!(
        body.get("model").is_none(),
        "inherit sends no model: {body}"
    );
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find(keyed("edit-bot", "helper")).visible());
        assert!(
            workspace.read(cx).active_conversation().is_some(),
            "a fresh conversation is open"
        );
    })
    .unwrap();
}
