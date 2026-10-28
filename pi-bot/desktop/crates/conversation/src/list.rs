//! A bot's past conversations, newest first.
//!
//! Primary task: resume a conversation or start a new one. Each row shows the
//! first message (or the id), when it last changed and whether it is running.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    App, AppContext as _, AsyncApp, Context, ElementId, Entity, EventEmitter, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Task, WeakEntity, Window, div, rems,
};
use pi_bot_api::{Client, ConversationState, ConversationSummary};

#[derive(Clone, Debug, PartialEq)]
pub enum ConversationsEvent {
    Changed,
}

/// The summaries of one bot's conversations, reloaded on demand.
pub struct Conversations {
    client: Client,
    bot: String,
    items: Vec<ConversationSummary>,
    loading: bool,
    error: Option<String>,
    revision: u64,
    _load: Option<Task<()>>,
}

impl EventEmitter<ConversationsEvent> for Conversations {}

impl Conversations {
    pub fn new(client: Client, bot: &str) -> Self {
        Self {
            client,
            bot: bot.to_string(),
            items: Vec::new(),
            loading: false,
            error: None,
            revision: 0,
            _load: None,
        }
    }

    pub fn bot(&self) -> &str {
        &self.bot
    }

    pub fn items(&self) -> &[ConversationSummary] {
        &self.items
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        let revision = self.revision;
        self.loading = true;
        cx.notify();
        let client = self.client.clone();
        let bot = self.bot.clone();
        self._load = Some(
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                let result = cx
                    .background_spawn(async move { client.conversations(&bot) })
                    .await;
                this.update(cx, |this, cx| {
                    if this.revision != revision {
                        return;
                    }
                    this.loading = false;
                    match result {
                        Ok(items) => {
                            this.items = items;
                            this.error = None;
                        }
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.emit(ConversationsEvent::Changed);
                    cx.notify();
                })
                .ok();
            }),
        );
    }

    /// Removes the conversation on the server, then reloads.
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let bot = self.bot.clone();
        let id = id.to_string();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx
                .background_spawn(async move { client.delete_conversation(&bot, &id) })
                .await;
            this.update(cx, |this, cx| {
                if let Err(error) = result {
                    this.error = Some(error.to_string());
                    cx.notify();
                }
                this.reload(cx);
            })
            .ok();
        })
        .detach();
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ConversationListEvent {
    Open(String),
    New,
    /// The person asked to delete this conversation; the owner confirms first.
    Delete(String),
    Reload,
}

type Handler = std::rc::Rc<dyn Fn(&ConversationListEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ConversationList {
    conversations: Entity<Conversations>,
    selected: Option<String>,
    on_event: Handler,
}

impl ConversationList {
    pub fn new(
        conversations: &Entity<Conversations>,
        selected: Option<&str>,
        on_event: impl Fn(&ConversationListEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            conversations: conversations.clone(),
            selected: selected.map(str::to_string),
            on_event: std::rc::Rc::new(on_event),
        }
    }

    fn row(&self, summary: &ConversationSummary, cx: &App) -> impl IntoElement {
        let id = summary.id.clone();
        let selected = self.selected.as_deref() == Some(id.as_str());
        let title: SharedString = summary
            .name
            .clone()
            .or_else(|| summary.first_message.clone())
            .map(|text| first_line(&text, 60))
            .unwrap_or_else(|| id.clone())
            .into();
        let running = !matches!(summary.state, ConversationState::Idle);
        let on_open = self.on_event.clone();
        let on_delete = self.on_event.clone();
        let delete_id = id.clone();
        ListItem::new(keyed("conversation", &id))
            .accessibility_label(format!("{title}, {}", relative_time(&summary.modified)))
            .selected(selected)
            .on_click(move |_, window, cx| {
                on_open(&ConversationListEvent::Open(id.clone()), window, cx)
            })
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .py_1()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_sm().truncate().child(title))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(relative_time(&summary.modified))
                                    .when(running, |this| this.child("Running")),
                            ),
                    )
                    .when(running, |this| this.child(Spinner::new().xsmall()))
                    .child(
                        Button::new(keyed("delete-conversation", &delete_id))
                            .ghost()
                            .xsmall()
                            .icon(gpui_kit::assets::IconName::X)
                            .accessibility_label(format!("Delete conversation {delete_id}…"))
                            .tooltip("Delete…")
                            .on_click(move |_, window, cx| {
                                on_delete(
                                    &ConversationListEvent::Delete(delete_id.clone()),
                                    window,
                                    cx,
                                )
                            }),
                    ),
            )
    }
}

impl RenderOnce for ConversationList {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let conversations = self.conversations.read(cx);
        let items = conversations.items().to_vec();
        let loading = conversations.is_loading();
        let error = conversations.error().map(str::to_string);
        let on_new = self.on_event.clone();
        let on_reload = self.on_event.clone();

        v_flex()
            .h_full()
            .w(rems(17.))
            .border_r_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().background)
            .child(
                h_flex()
                    .px_3()
                    .py_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("Conversations"),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                Button::new("reload-conversations")
                                    .ghost()
                                    .small()
                                    .icon(gpui_kit::assets::IconName::RefreshCw)
                                    .accessibility_label("Reload conversations")
                                    .tooltip("Reload conversations")
                                    .loading(loading && !items.is_empty())
                                    .on_click(move |_, window, cx| {
                                        on_reload(&ConversationListEvent::Reload, window, cx)
                                    }),
                            )
                            .child(
                                Button::new("new-conversation")
                                    .ghost()
                                    .small()
                                    .icon(gpui_kit::assets::IconName::SquarePen)
                                    .accessibility_label("New conversation")
                                    .tooltip("New conversation")
                                    .on_click(move |_, window, cx| {
                                        on_new(&ConversationListEvent::New, window, cx)
                                    }),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .px_1()
                    .py_1()
                    .overflow_y_scrollbar()
                    .when_some(error, |this, error| {
                        this.child(
                            div()
                                .px_2()
                                .py_1()
                                .text_sm()
                                .text_color(cx.theme().danger)
                                .child(SharedString::from(error)),
                        )
                    })
                    .when(loading && items.is_empty(), |this| {
                        this.child(
                            h_flex()
                                .px_2()
                                .py_1()
                                .gap_2()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(Spinner::new().small())
                                .child("Loading…"),
                        )
                    })
                    .when(!loading && items.is_empty(), |this| {
                        this.child(
                            div()
                                .px_2()
                                .py_1()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child("No conversations yet. Send a message to start one."),
                        )
                    })
                    .children(items.iter().map(|summary| self.row(summary, cx))),
            )
    }
}

/// A stable element id derived from the conversation id, never from its row.
fn keyed(prefix: &'static str, key: &str) -> ElementId {
    (ElementId::from(prefix), SharedString::from(key.to_string())).into()
}

fn first_line(text: &str, limit: usize) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() <= limit {
        return line.to_string();
    }
    let mut out: String = line.chars().take(limit).collect();
    out.push('…');
    out
}

/// "today 14:05", "Mon 09:12" or "2026-10-20" from an RFC 3339 timestamp; the
/// raw value when it cannot be read.
fn relative_time(modified: &str) -> SharedString {
    let Some((date, time)) = modified.split_once('T') else {
        return modified.into();
    };
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0);
    let hhmm = &time[..time.len().min(5)];
    match days_since_epoch(date) {
        Some(day) if day == today => format!("today {hhmm}").into(),
        Some(day) if day + 1 == today => format!("yesterday {hhmm}").into(),
        _ => date.to_string().into(),
    }
}

fn days_since_epoch(date: &str) -> Option<u64> {
    let mut parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    // Days from civil date, Howard Hinnant's algorithm.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u64::try_from(era * 146_097 + doe - 719_468).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_counted_from_the_epoch() {
        assert_eq!(days_since_epoch("1970-01-01"), Some(0));
        assert_eq!(days_since_epoch("2026-10-27"), Some(20_753));
        assert_eq!(days_since_epoch("nope"), None);
    }

    #[test]
    fn first_lines_are_trimmed_and_cut() {
        assert_eq!(first_line("\n  hello world\nmore", 60), "hello world");
        assert_eq!(first_line("abcdef", 3), "abc…");
    }
}
