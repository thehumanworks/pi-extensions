//! One conversation: transcript, composer, the bot's questions, stop.
//!
//! Primary task: read what the bot did and tell it what to do next. Immediate
//! actions: send (Enter), stop, answer a request. Decision information: model,
//! reasoning effort, whether the bot is running. States: loading the snapshot,
//! empty (a new conversation), streaming, disconnected (retrying), failed.
//! Keyboard path: the composer has focus; Enter sends, Shift+Enter breaks a
//! line, Escape while running stops.

use std::time::Duration;

use gpui_kit::component::avatar::Avatar;
use gpui_kit::component::bubble::{Bubble, BubbleVariant};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::message::{Message, MessageAlignment, MessageContent};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, AsyncApp, Context, ElementId, Entity, EventEmitter,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Task, WeakEntity, Window, actions, div, rems,
};
use pi_bot_api::{Answer, Client, Conversation, Request, RequestMethod, Update};

use crate::transcript::{Applied, Item, NoticeLevel, Row, Transcript};

actions!(conversation, [Send, Stop]);

/// How long to wait before reconnecting a broken update stream.
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// Key context of the conversation view; bind `Stop` and `Send` in it.
pub const KEY_CONTEXT: &str = "Conversation";

#[derive(Clone, Debug, PartialEq)]
pub enum ConversationViewEvent {
    /// The bot finished a turn; lists showing this conversation should refresh.
    Settled,
    /// A request to the server failed; the text says what to do.
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
enum Connection {
    Loading,
    Live,
    /// The stream broke or the server went away after a successful load; the
    /// view keeps what it has and retries on its own.
    Reconnecting,
    /// The first load failed; the user retries.
    Failed(String),
}

pub struct ConversationView {
    client: Client,
    bot: String,
    id: String,
    transcript: Transcript,
    connection: Connection,
    /// A message is in flight to the server (not the bot's reply).
    sending: bool,
    scroller: Entity<MessageScrollerState>,
    composer: Entity<TextareaState>,
    focus_handle: FocusHandle,
    _stream: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ConversationViewEvent> for ConversationView {}

impl Focusable for ConversationView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl ConversationView {
    /// Opens the conversation `id` of `bot`. A conversation that does not exist
    /// yet is shown empty and created by the first message.
    pub fn new(
        client: Client,
        bot: &str,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(format!("Message {bot}"))
                .auto_grow(1, 8)
                .submit_on_enter(true)
        });
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let subscriptions = vec![cx.subscribe_in(
            &composer,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { shift: false, .. }) {
                    this.send(&Send, window, cx);
                }
            },
        )];
        let mut view = Self {
            client,
            bot: bot.to_string(),
            id: id.to_string(),
            transcript: Transcript::default(),
            connection: Connection::Loading,
            sending: false,
            scroller,
            composer,
            focus_handle: cx.focus_handle(),
            _stream: None,
            _subscriptions: subscriptions,
        };
        view.load(cx);
        view
    }

    pub fn bot(&self) -> &str {
        &self.bot
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn transcript(&self) -> &Transcript {
        &self.transcript
    }

    pub fn is_running(&self) -> bool {
        self.transcript.is_running()
    }

    pub fn focus_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |state, cx| state.focus(window, cx));
    }

    /// Fetches the snapshot, then follows updates from its offset. A load that
    /// fails while reconnecting is retried after `RECONNECT_DELAY`.
    fn load(&mut self, cx: &mut Context<Self>) {
        let retrying = self.connection == Connection::Reconnecting;
        if !retrying {
            self.connection = Connection::Loading;
        }
        cx.notify();
        let client = self.client.clone();
        let (bot, id) = (self.bot.clone(), self.id.clone());
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx
                .background_spawn(async move { client.conversation(&bot, &id) })
                .await;
            this.update(cx, |this, cx| match result {
                Ok(snapshot) => this.show_snapshot(&snapshot, cx),
                Err(error) if error.is_not_found() => {
                    this.transcript = Transcript::default();
                    this.connection = Connection::Live;
                    this.sync_scroller(cx);
                    cx.notify();
                }
                Err(_) if retrying => this.retry_later(cx),
                Err(error) => {
                    this.connection = Connection::Failed(error.to_string());
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn retry_later(&mut self, cx: &mut Context<Self>) {
        self.connection = Connection::Reconnecting;
        cx.notify();
        self._stream = Some(
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                cx.background_executor().timer(RECONNECT_DELAY).await;
                this.update(cx, |this, cx| this.load(cx)).ok();
            }),
        );
    }

    fn show_snapshot(&mut self, snapshot: &Conversation, cx: &mut Context<Self>) {
        self.transcript = Transcript::from_snapshot(snapshot);
        self.connection = Connection::Live;
        self.sync_scroller(cx);
        self.follow(cx);
        cx.notify();
    }

    /// Streams updates from the transcript's offset until the view is dropped.
    /// Reconnects after a broken stream; takes a new snapshot after a gap.
    fn follow(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let (bot, id, offset) = (self.bot.clone(), self.id.clone(), self.transcript.offset());
        self._stream = Some(
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                // Connecting and every read block, so the stream lives on the
                // background executor and travels back with each event.
                let mut stream = cx
                    .background_spawn(async move { client.updates(&bot, &id, offset) })
                    .await;
                let mut gap = false;
                loop {
                    let (next, updates) = match stream {
                        Ok(updates) => {
                            cx.background_spawn(async move {
                                let mut updates = updates;
                                let next = updates.next();
                                (next, updates)
                            })
                            .await
                        }
                        Err(error) => {
                            Self::lost_connection(&this, error, cx);
                            break;
                        }
                    };
                    stream = Ok(updates);
                    match next {
                        None => break,
                        Some(Ok(update)) => {
                            match this.update(cx, |this, cx| this.apply(&update, cx)) {
                                Ok(Applied::Gap) => {
                                    gap = true;
                                    break;
                                }
                                Ok(_) => {}
                                Err(_) => return,
                            }
                        }
                        Some(Err(error)) => {
                            Self::lost_connection(&this, error, cx);
                            break;
                        }
                    }
                }
                if !gap {
                    cx.background_executor().timer(RECONNECT_DELAY).await;
                }
                // Either way a fresh snapshot is the safe way back in sync.
                this.update(cx, |this, cx| this.load(cx)).ok();
            }),
        );
    }

    fn lost_connection(this: &WeakEntity<Self>, error: pi_bot_api::Error, cx: &mut AsyncApp) {
        this.update(cx, |this, cx| {
            this.connection = Connection::Reconnecting;
            this.transcript_notice(NoticeLevel::Warning, format!("{error} Reconnecting…"), cx);
        })
        .ok();
    }

    fn apply(&mut self, update: &Update, cx: &mut Context<Self>) -> Applied {
        let was_running = self.transcript.is_running();
        let applied = self.transcript.apply(update);
        if applied == Applied::Changed {
            self.connection = Connection::Live;
            self.sync_scroller(cx);
            if was_running && !self.transcript.is_running() {
                cx.emit(ConversationViewEvent::Settled);
            }
            cx.notify();
        }
        applied
    }

    fn transcript_notice(&mut self, level: NoticeLevel, text: String, cx: &mut Context<Self>) {
        let synthetic = Update {
            offset: self.transcript.offset(),
            event: pi_bot_api::StreamEvent::Notice {
                level: api_level(level),
                message: text,
            },
        };
        self.transcript.apply(&synthetic);
        self.sync_scroller(cx);
        cx.notify();
    }

    /// Keeps the virtual list's row count in step with the transcript and
    /// remeasures the last row, which grows while the bot streams.
    fn sync_scroller(&mut self, cx: &mut Context<Self>) {
        let count = self.transcript.row_count();
        self.scroller.update(cx, |scroller, cx| {
            let current = scroller.item_count();
            if count > current {
                scroller.append(count - current, cx);
            } else if count < current {
                scroller.reset(count, cx);
            }
            if let Some(last) = count.checked_sub(1) {
                scroller.remeasure_items(last..last + 1, cx);
            }
        });
    }

    /// Sends the composer's text: as the answer to an open text request when
    /// there is one, otherwise as the next message to the bot.
    pub fn send(&mut self, _: &Send, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if text.is_empty() || self.sending || !matches!(self.connection, Connection::Live) {
            return;
        }
        if let Some(request) = self
            .transcript
            .pending()
            .iter()
            .find(|request| matches!(request.method, RequestMethod::Input | RequestMethod::Editor))
            .cloned()
        {
            self.composer
                .update(cx, |state, cx| state.clean(window, cx));
            self.answer(Answer::value(request.id, text), cx);
            return;
        }
        self.composer
            .update(cx, |state, cx| state.clean(window, cx));
        self.transcript.push_local_user(&text);
        self.sending = true;
        self.sync_scroller(cx);
        self.scroller
            .update(cx, |scroller, cx| scroller.scroll_to_end(cx));
        cx.notify();
        let first_message = self._stream.is_none();
        let client = self.client.clone();
        let (bot, id) = (self.bot.clone(), self.id.clone());
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx
                .background_spawn(async move { client.send(&bot, &id, &text, None) })
                .await;
            this.update(cx, |this, cx| {
                this.sending = false;
                match result {
                    Ok(submission) => {
                        if first_message {
                            // The conversation now exists: follow it from just before our message.
                            this.transcript.set_offset(submission.offset);
                            this.follow(cx);
                        }
                    }
                    Err(error) => {
                        this.transcript_notice(
                            NoticeLevel::Error,
                            format!("The message was not sent: {error}"),
                            cx,
                        );
                        cx.emit(ConversationViewEvent::Failed(error.to_string()));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn stop(&mut self, _: &Stop, _: &mut Window, cx: &mut Context<Self>) {
        if !self.transcript.is_running() {
            return;
        }
        let client = self.client.clone();
        let (bot, id) = (self.bot.clone(), self.id.clone());
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx
                .background_spawn(async move { client.abort(&bot, &id) })
                .await;
            if let Err(error) = result {
                this.update(cx, |_, cx| {
                    cx.emit(ConversationViewEvent::Failed(format!(
                        "Could not stop the bot: {error}"
                    )))
                })
                .ok();
            }
        })
        .detach();
    }

    /// Answers one of the bot's questions. The server confirms by closing the request on the stream.
    pub fn answer(&mut self, answer: Answer, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let (bot, id) = (self.bot.clone(), self.id.clone());
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx
                .background_spawn(async move { client.answer(&bot, &id, &answer) })
                .await;
            if let Err(error) = result {
                this.update(cx, |_, cx| {
                    cx.emit(ConversationViewEvent::Failed(format!(
                        "The answer was not delivered: {error}"
                    )))
                })
                .ok();
            }
        })
        .detach();
    }

    fn render_row(&self, index: usize, view: WeakEntity<Self>, cx: &App) -> AnyElement {
        match self.transcript.row(index) {
            Some(Row::Item(item)) => render_item(index, item, &self.bot, cx),
            Some(Row::Partial(partial)) => render_item(
                index,
                &Item::Assistant {
                    text: partial.text.clone(),
                    thinking: Some(partial.thinking.clone()).filter(|t| !t.is_empty()),
                    streaming: true,
                },
                &self.bot,
                cx,
            ),
            Some(Row::Request(request)) => render_request(request, view, cx),
            None => div().into_any_element(),
        }
    }

    fn render_header(&self, cx: &Context<Self>) -> impl IntoElement {
        let running = self.transcript.is_running();
        h_flex()
            .px_4()
            .py_2()
            .gap_3()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                Avatar::new()
                    .name(SharedString::from(self.bot.clone()))
                    .small(),
            )
            .child(
                div()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(SharedString::from(self.bot.clone())),
            )
            .child(
                div()
                    .text_xs()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_color(cx.theme().muted_foreground)
                    .truncate()
                    .child(SharedString::from(self.id.clone())),
            )
            .child(div().flex_1())
            .when_some(self.transcript.model(), |this, model| {
                this.child(
                    Tag::secondary()
                        .small()
                        .child(SharedString::from(model.to_string())),
                )
            })
            .when_some(self.transcript.thinking(), |this, thinking| {
                this.child(
                    Tag::secondary()
                        .small()
                        .child(SharedString::from(thinking.to_string())),
                )
            })
            .when(running, |this| {
                this.child(
                    h_flex()
                        .gap_1()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(Spinner::new().xsmall())
                        .child("Running"),
                )
            })
    }

    fn render_composer(&self, cx: &Context<Self>) -> impl IntoElement {
        let running = self.transcript.is_running();
        let live = matches!(self.connection, Connection::Live);
        let text_request =
            self.transcript.pending().iter().find(|request| {
                matches!(request.method, RequestMethod::Input | RequestMethod::Editor)
            });
        let placeholder: SharedString = match text_request {
            Some(request) => request
                .placeholder
                .clone()
                .unwrap_or_else(|| format!("Answer: {}", request.title))
                .into(),
            None => format!("Message {}", self.bot).into(),
        };
        v_flex()
            .px_4()
            .pb_3()
            .pt_2()
            .gap_2()
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                h_flex()
                    .items_end()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(Textarea::new(&self.composer).aria_label(placeholder.clone()).disabled(!live)))
                    .when(running, |this| {
                        this.child(Button::new("stop").danger().outline().icon(gpui_kit::assets::IconName::CircleStop).label("Stop").tooltip("Stop the bot (Escape)").on_click(cx.listener(|this, _, window, cx| this.stop(&Stop, window, cx))))
                    })
                    .child(
                        Button::new("send")
                            .primary()
                            .icon(gpui_kit::assets::IconName::SendHorizontal)
                            .accessibility_label(if text_request.is_some() { "Send answer" } else { "Send message" })
                            .tooltip("Send (Enter)")
                            .loading(self.sending)
                            .disabled(!live)
                            .on_click(cx.listener(|this, _, window, cx| this.send(&Send, window, cx))),
                    ),
            )
            .child(div().text_xs().text_color(cx.theme().muted_foreground).child(match (&self.connection, running) {
                (Connection::Loading, _) => "Loading…",
                (Connection::Reconnecting, _) => "Reconnecting to the server…",
                (Connection::Failed(_), _) => "Not connected. Check that pi-bot-server is running.",
                (Connection::Live, true) => "Enter sends a follow-up while the bot works. Shift+Enter for a new line.",
                (Connection::Live, false) => "Enter to send. Shift+Enter for a new line.",
            }))
    }
}

impl Render for ConversationView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity().clone();
        let empty = self.transcript.row_count() == 0;
        v_flex()
            .size_full()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::stop))
            .bg(cx.theme().background)
            .child(self.render_header(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .map(|this| match (&self.connection, empty) {
                        (Connection::Loading, true) => this.child(h_flex().h_full().justify_center().gap_2().text_color(cx.theme().muted_foreground).child(Spinner::new().small()).child("Loading conversation…")),
                        (Connection::Failed(message), _) => this.child(
                            v_flex()
                                .h_full()
                                .items_center()
                                .justify_center()
                                .gap_3()
                                .child(div().text_color(cx.theme().danger).child(SharedString::from(message.clone())))
                                .child(Button::new("retry-conversation").outline().label("Retry").on_click(cx.listener(|this, _, _, cx| this.load(cx)))),
                        ),
                        (_, true) => this.child(
                            v_flex()
                                .h_full()
                                .items_center()
                                .justify_center()
                                .gap_1()
                                .text_color(cx.theme().muted_foreground)
                                .child(div().text_lg().text_color(cx.theme().foreground).child(SharedString::from(format!("New conversation with {}", self.bot))))
                                .child("Describe the task. The bot works in the server's directory and remembers across conversations."),
                        ),
                        _ => this.child(
                            MessageScroller::new("transcript", self.scroller.clone(), move |index, _, cx| view.read(cx).render_row(index, view.downgrade(), cx))
                                .with_content_style(gpui_kit::StyleRefinement::default())
                                .with_jump_button_label("Jump to latest"),
                        ),
                    }),
            )
            .child(self.render_composer(cx))
    }
}

fn render_item(index: usize, item: &Item, bot: &str, cx: &App) -> AnyElement {
    let row = |alignment: MessageAlignment, content: AnyElement| {
        div()
            .px_4()
            .py_1()
            .w_full()
            .child(
                Message::new()
                    .alignment(alignment)
                    .content(MessageContent::new().child(content)),
            )
            .into_any_element()
    };
    match item {
        Item::User { text } => row(
            MessageAlignment::End,
            Bubble::new()
                .alignment(MessageAlignment::End)
                .with_variant(BubbleVariant::Filled)
                .child(SharedString::from(text.clone()))
                .into_any_element(),
        ),
        Item::Assistant {
            text,
            thinking,
            streaming,
        } => {
            let body = v_flex()
                .gap_1()
                .max_w(rems(44.))
                .when_some(
                    thinking.as_ref().filter(|_| text.is_empty() && *streaming),
                    |this, _| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(Spinner::new().xsmall())
                                .child("Thinking…"),
                        )
                    },
                )
                .when(!text.is_empty(), |this| {
                    this.child(
                        TextView::markdown(("assistant", index), SharedString::from(text.clone()))
                            .selectable(true),
                    )
                })
                .when(*streaming && !text.is_empty(), |this| {
                    this.child(Spinner::new().xsmall())
                });
            div()
                .px_4()
                .py_1()
                .w_full()
                .child(
                    Message::new()
                        .alignment(MessageAlignment::Start)
                        .avatar(
                            Avatar::new()
                                .name(SharedString::from(bot.to_string()))
                                .small(),
                        )
                        .content(
                            MessageContent::new().child(
                                Bubble::new().with_variant(BubbleVariant::Muted).child(body),
                            ),
                        ),
                )
                .into_any_element()
        }
        Item::Tool {
            name,
            summary,
            result,
            ..
        } => {
            let (icon, color) = match result {
                None => (
                    gpui_kit::assets::IconName::LoaderCircle,
                    cx.theme().muted_foreground,
                ),
                Some(result) if result.is_error => {
                    (gpui_kit::assets::IconName::CircleX, cx.theme().danger)
                }
                Some(_) => (gpui_kit::assets::IconName::CircleCheck, cx.theme().success),
            };
            let output = result
                .as_ref()
                .map(|result| {
                    result
                        .text
                        .trim()
                        .lines()
                        .take(3)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|text| !text.is_empty());
            div()
                .px_4()
                .py_0p5()
                .pl(rems(3.5))
                .w_full()
                .child(
                    v_flex()
                        .gap_0p5()
                        .text_sm()
                        .child(
                            h_flex()
                                .gap_2()
                                .text_color(cx.theme().muted_foreground)
                                .child(
                                    gpui_kit::component::Icon::new(icon)
                                        .xsmall()
                                        .text_color(color),
                                )
                                .child(
                                    div()
                                        .font_family(cx.theme().mono_font_family.clone())
                                        .child(SharedString::from(name.clone())),
                                )
                                .child(div().truncate().child(SharedString::from(summary.clone()))),
                        )
                        .when_some(output, |this, output| {
                            this.child(
                                div()
                                    .text_xs()
                                    .font_family(cx.theme().mono_font_family.clone())
                                    .text_color(if result.as_ref().is_some_and(|r| r.is_error) {
                                        cx.theme().danger
                                    } else {
                                        cx.theme().muted_foreground
                                    })
                                    .child(SharedString::from(output)),
                            )
                        }),
                )
                .into_any_element()
        }
        Item::Notice { level, text } => {
            let color = match level {
                NoticeLevel::Info => cx.theme().muted_foreground,
                NoticeLevel::Warning => cx.theme().warning,
                NoticeLevel::Error => cx.theme().danger,
            };
            div()
                .px_4()
                .py_1()
                .w_full()
                .flex()
                .justify_center()
                .text_xs()
                .text_color(color)
                .child(SharedString::from(text.clone()))
                .into_any_element()
        }
    }
}

/// A question from the bot with its answers as buttons. Text answers go
/// through the composer, which says so in its placeholder.
fn render_request(request: &Request, view: WeakEntity<ConversationView>, cx: &App) -> AnyElement {
    let id = request.id.as_str();
    let answers: Vec<AnyElement> = match request.method {
        RequestMethod::Confirm => vec![
            Button::new(keyed("request-cancel", id))
                .outline()
                .label("Not now")
                .on_click(answer_handler(
                    view.clone(),
                    Answer::confirmed(request.id.clone(), false),
                ))
                .into_any_element(),
            Button::new(keyed("request-confirm", id))
                .primary()
                .label("Confirm")
                .on_click(answer_handler(
                    view,
                    Answer::confirmed(request.id.clone(), true),
                ))
                .into_any_element(),
        ],
        RequestMethod::Select => {
            let dismiss = Button::new(keyed("request-dismiss", id))
                .ghost()
                .label("Dismiss")
                .on_click(answer_handler(
                    view.clone(),
                    Answer::cancelled(request.id.clone()),
                ))
                .into_any_element();
            request
                .options
                .iter()
                .map(|option| {
                    Button::new(keyed("request-option", &format!("{id}:{option}")))
                        .outline()
                        .label(SharedString::from(option.clone()))
                        .on_click(answer_handler(
                            view.clone(),
                            Answer::value(request.id.clone(), option.clone()),
                        ))
                        .into_any_element()
                })
                .chain(std::iter::once(dismiss))
                .collect()
        }
        RequestMethod::Input | RequestMethod::Editor => vec![
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child("Type the answer in the composer and press Enter.")
                .into_any_element(),
            Button::new(keyed("request-dismiss", id))
                .ghost()
                .label("Dismiss")
                .on_click(answer_handler(view, Answer::cancelled(request.id.clone())))
                .into_any_element(),
        ],
    };
    div()
        .px_4()
        .py_1()
        .w_full()
        .child(
            v_flex()
                .max_w(rems(44.))
                .gap_2()
                .p_3()
                .rounded(cx.theme().radius_lg)
                .border_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().secondary)
                .child(
                    div()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child(SharedString::from(request.title.clone())),
                )
                .when_some(request.message.clone(), |this, message| {
                    this.child(div().text_sm().child(SharedString::from(message)))
                })
                .child(h_flex().gap_2().flex_wrap().children(answers)),
        )
        .into_any_element()
}

/// A stable element id derived from the request id.
fn keyed(prefix: &'static str, key: &str) -> ElementId {
    (ElementId::from(prefix), SharedString::from(key.to_string())).into()
}

fn answer_handler(
    view: WeakEntity<ConversationView>,
    answer: Answer,
) -> impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static {
    move |_, _, cx| {
        let answer = answer.clone();
        view.update(cx, |this, cx| this.answer(answer, cx)).ok();
    }
}

fn api_level(level: NoticeLevel) -> pi_bot_api::NoticeLevel {
    match level {
        NoticeLevel::Info => pi_bot_api::NoticeLevel::Info,
        NoticeLevel::Warning => pi_bot_api::NoticeLevel::Warning,
        NoticeLevel::Error => pi_bot_api::NoticeLevel::Error,
    }
}
