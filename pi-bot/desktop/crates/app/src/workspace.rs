//! The window: bots on the left, a bot's conversations next to them, and the
//! open conversation filling the rest.
//!
//! The workspace owns which bot and conversation are selected, opens the bot
//! editor in a sheet, confirms deletions in an alert dialog and turns roster
//! and conversation events into notifications.

use std::collections::HashMap;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Subscription, Window,
    actions, div,
};
use pi_bot_api::{Bot, Client};
use pi_bot_bots::{BotEditor, BotEditorEvent, BotSidebar, BotSidebarEvent, Roster, RosterEvent};
use pi_bot_conversation::{
    ConversationList, ConversationListEvent, ConversationView, ConversationViewEvent,
    Conversations, ConversationsEvent,
};

actions!(workspace, [NewConversation, Reload, FocusComposer]);

pub const KEY_CONTEXT: &str = "Workspace";

pub struct Workspace {
    client: Client,
    roster: Entity<Roster>,
    selected_bot: Option<String>,
    /// A bot just created here; selected as soon as the roster lists it.
    select_when_listed: Option<String>,
    conversations: Option<Entity<Conversations>>,
    /// Open conversation views, kept so switching back keeps their stream.
    views: HashMap<(String, String), Entity<ConversationView>>,
    active: Option<(String, String)>,
    editor: Option<Entity<BotEditor>>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
    _conversation_subscriptions: Vec<Subscription>,
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Workspace {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let roster = cx.new(|_| Roster::new(client.clone()));
        let subscriptions = vec![cx.subscribe_in(&roster, window, Self::on_roster_event)];
        roster.update(cx, |roster, cx| roster.reload(cx));
        Self {
            client,
            roster,
            selected_bot: None,
            select_when_listed: None,
            conversations: None,
            views: HashMap::new(),
            active: None,
            editor: None,
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
            _conversation_subscriptions: Vec::new(),
        }
    }

    pub fn roster(&self) -> &Entity<Roster> {
        &self.roster
    }

    pub fn selected_bot(&self) -> Option<&str> {
        self.selected_bot.as_deref()
    }

    /// The bot editor while its sheet is open.
    pub fn editor(&self) -> Option<&Entity<BotEditor>> {
        self.editor.as_ref()
    }

    pub fn active_conversation(&self) -> Option<&Entity<ConversationView>> {
        self.active.as_ref().and_then(|key| self.views.get(key))
    }

    fn on_roster_event(
        &mut self,
        _: &Entity<Roster>,
        event: &RosterEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            RosterEvent::Changed => {
                let bots = self.roster.read(cx).bots().to_vec();
                let listed = |name: &str| bots.iter().any(|bot| bot.name == name);
                let created = self.select_when_listed.take_if(|name| listed(name));
                let still_there = self.selected_bot.as_deref().is_some_and(listed);
                if created.is_some() {
                    self.select_bot(created, window, cx);
                } else if !still_there {
                    let first = bots.first().map(|bot| bot.name.clone());
                    self.select_bot(first, window, cx);
                }
                for broken in self.roster.read(cx).broken().to_vec() {
                    window.push_notification(
                        Notification::warning(SharedString::from(broken))
                            .title("A bot definition could not be read"),
                        cx,
                    );
                }
                cx.notify();
            }
            RosterEvent::Notice(message) => window.push_notification(
                Notification::success(SharedString::from(message.clone())),
                cx,
            ),
            RosterEvent::Failed(message) => window.push_notification(
                Notification::error(SharedString::from(message.clone()))
                    .title("The change was not saved"),
                cx,
            ),
        }
    }

    fn select_bot(&mut self, name: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if name == self.selected_bot && self.conversations.is_some() {
            return;
        }
        self.selected_bot = name.clone();
        self.active = None;
        self._conversation_subscriptions.clear();
        self.conversations = name.map(|name| {
            let conversations = cx.new(|_| Conversations::new(self.client.clone(), &name));
            conversations.update(cx, |conversations, cx| conversations.reload(cx));
            self._conversation_subscriptions.push(
                cx.subscribe(&conversations, |_, _, _: &ConversationsEvent, cx| {
                    cx.notify()
                }),
            );
            conversations
        });
        if let Some(bot) = self.selected_bot.clone() {
            self.open_conversation(&bot, &fresh_conversation_id(), window, cx);
        }
        cx.notify();
    }

    fn open_conversation(
        &mut self,
        bot: &str,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = (bot.to_string(), id.to_string());
        if !self.views.contains_key(&key) {
            let client = self.client.clone();
            let view = cx.new(|cx| ConversationView::new(client, bot, id, window, cx));
            self._conversation_subscriptions.push(cx.subscribe_in(
                &view,
                window,
                Self::on_conversation_event,
            ));
            self.views.insert(key.clone(), view);
        }
        self.active = Some(key);
        if let Some(view) = self.active_conversation().cloned() {
            view.update(cx, |view, cx| view.focus_composer(window, cx));
        }
        cx.notify();
    }

    fn on_conversation_event(
        &mut self,
        view: &Entity<ConversationView>,
        event: &ConversationViewEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ConversationViewEvent::Settled => {
                if let Some(conversations) = &self.conversations
                    && conversations.read(cx).bot() == view.read(cx).bot()
                {
                    conversations.update(cx, |conversations, cx| conversations.reload(cx));
                }
            }
            ConversationViewEvent::Failed(message) => window
                .push_notification(Notification::error(SharedString::from(message.clone())), cx),
        }
    }

    fn on_sidebar_event(
        &mut self,
        event: &BotSidebarEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            BotSidebarEvent::Select(name) => self.select_bot(Some(name.clone()), window, cx),
            BotSidebarEvent::NewBot => self.open_editor(None, window, cx),
            BotSidebarEvent::Reload => self.roster.update(cx, |roster, cx| roster.reload(cx)),
        }
    }

    fn on_list_event(
        &mut self,
        event: &ConversationListEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bot) = self.selected_bot.clone() else {
            return;
        };
        match event {
            ConversationListEvent::Open(id) => self.open_conversation(&bot, id, window, cx),
            ConversationListEvent::New => self.new_conversation(&NewConversation, window, cx),
            ConversationListEvent::Reload => {
                if let Some(conversations) = &self.conversations {
                    conversations.update(cx, |conversations, cx| conversations.reload(cx));
                }
            }
            ConversationListEvent::Delete(id) => {
                self.confirm_delete_conversation(&bot, id, window, cx)
            }
        }
    }

    pub fn new_conversation(
        &mut self,
        _: &NewConversation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(bot) = self.selected_bot.clone() {
            // Reuse an open, still empty conversation instead of piling up blank ones.
            let empty = self.active.clone().filter(|key| {
                self.views.get(key).is_some_and(|view| {
                    view.read(cx).transcript().row_count() == 0 && !view.read(cx).is_running()
                })
            });
            match empty {
                Some(key) => self.open_conversation(&key.0, &key.1, window, cx),
                None => self.open_conversation(&bot, &fresh_conversation_id(), window, cx),
            }
        }
    }

    pub fn reload(&mut self, _: &Reload, _: &mut Window, cx: &mut Context<Self>) {
        self.roster.update(cx, |roster, cx| roster.reload(cx));
        if let Some(conversations) = &self.conversations {
            conversations.update(cx, |conversations, cx| conversations.reload(cx));
        }
    }

    pub fn focus_composer(
        &mut self,
        _: &FocusComposer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(view) = self.active_conversation().cloned() {
            view.update(cx, |view, cx| view.focus_composer(window, cx));
        }
    }

    fn open_editor(&mut self, bot: Option<Bot>, window: &mut Window, cx: &mut Context<Self>) {
        let models = self.roster.read(cx).models().to_vec();
        let editor = cx.new(|cx| BotEditor::new(bot, &models, window, cx));
        self._subscriptions
            .push(cx.subscribe_in(&editor, window, Self::on_editor_event));
        let title: SharedString = if editor.read(cx).is_new() {
            "New bot".into()
        } else {
            "Edit bot".into()
        };
        let view = editor.clone();
        self.editor = Some(editor);
        let workspace = cx.weak_entity();
        window.open_sheet(cx, move |sheet, _, cx| {
            let workspace = workspace.clone();
            sheet
                .title(title.clone())
                .size(gpui_kit::rems(34.))
                .child(view.clone())
                .footer(BotEditor::actions(&view, cx))
                .on_close(move |_, _, cx| {
                    workspace.update(cx, |this, cx| this.close_editor(cx)).ok();
                })
        });
        // The sheet takes focus when it opens; the first field wants it.
        if let Some(editor) = &self.editor {
            editor.update(cx, |editor, cx| editor.focus(window, cx));
        }
    }

    fn on_editor_event(
        &mut self,
        _: &Entity<BotEditor>,
        event: &BotEditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            BotEditorEvent::Create(bot) => {
                self.select_when_listed = Some(bot.name.clone());
                self.roster
                    .update(cx, |roster, cx| roster.create(bot.clone(), cx));
            }
            BotEditorEvent::Update { name, patch } => self
                .roster
                .update(cx, |roster, cx| roster.update(name, patch.clone(), cx)),
            BotEditorEvent::Cancel => {}
        }
        window.close_sheet(cx);
        self.close_editor(cx);
        self.focus_composer(&FocusComposer, window, cx);
    }

    fn close_editor(&mut self, cx: &mut Context<Self>) {
        if self.editor.take().is_some() {
            cx.notify();
        }
    }

    fn confirm_archive_bot(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let roster = self.roster.clone();
        let title: SharedString = format!("Archive \"{name}\"?").into();
        let name = name.to_string();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let roster = roster.clone();
            let name = name.clone();
            alert
                .title(title.clone())
                .description("The bot's home, including its memory and conversations, moves to the server's archive directory. Nothing is deleted.")
                .ok_text("Archive")
                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                .show_cancel(true)
                .on_ok(move |_, _, cx| {
                    roster.update(cx, |roster, cx| roster.archive(&name, cx));
                    true
                })
        });
    }

    fn confirm_delete_conversation(
        &mut self,
        bot: &str,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(conversations) = self.conversations.clone() else {
            return;
        };
        let key = (bot.to_string(), id.to_string());
        let title: SharedString = format!("Delete conversation \"{id}\"?").into();
        let workspace = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let conversations = conversations.clone();
            let key = key.clone();
            let workspace = workspace.clone();
            alert
                .title(title.clone())
                .description("Its history is removed from the bot's home. The bot's memory stays.")
                .ok_text("Delete")
                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                .show_cancel(true)
                .on_ok(move |_, window, cx| {
                    conversations.update(cx, |conversations, cx| conversations.delete(&key.1, cx));
                    workspace
                        .update(cx, |this, cx| {
                            this.views.remove(&key);
                            if this.active.as_ref() == Some(&key) {
                                this.open_conversation(
                                    &key.0,
                                    &fresh_conversation_id(),
                                    window,
                                    cx,
                                );
                            }
                        })
                        .ok();
                    true
                })
        });
    }

    fn render_bot_header(&self, bot: &Bot, cx: &Context<Self>) -> impl IntoElement {
        let edit = bot.clone();
        let archive = bot.name.clone();
        h_flex()
            .px_3()
            .py_2()
            .gap_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_sm()
                    .truncate()
                    .text_color(cx.theme().muted_foreground)
                    .child(SharedString::from(bot.description.clone())),
            )
            .child(
                Button::new(keyed("edit-bot", &bot.name))
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::Pencil)
                    .accessibility_label("Edit bot…")
                    .tooltip("Edit bot…")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_editor(Some(edit.clone()), window, cx)
                    })),
            )
            .child(
                Button::new(keyed("archive-bot", &bot.name))
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::Archive)
                    .accessibility_label("Archive bot…")
                    .tooltip("Archive bot…")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.confirm_archive_bot(&archive, window, cx)
                    })),
            )
    }
}

/// A stable element id derived from the bot name.
fn keyed(prefix: &'static str, key: &str) -> ElementId {
    (ElementId::from(prefix), SharedString::from(key.to_string())).into()
}

/// A new conversation id: sortable, unique enough for one person, and valid
/// for the server's id alphabet.
fn fresh_conversation_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{:03}", now.as_secs(), now.subsec_millis())
}

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected_bot = self.selected_bot.clone();
        let bot = selected_bot
            .as_deref()
            .and_then(|name| self.roster.read(cx).bot(name).cloned());
        let active_id = self.active.as_ref().map(|key| key.1.clone());
        h_flex()
            .size_full()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::new_conversation))
            .on_action(cx.listener(Self::reload))
            .on_action(cx.listener(Self::focus_composer))
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(BotSidebar::new(
                &self.roster,
                selected_bot.as_deref(),
                cx.listener(|this, event, window, cx| this.on_sidebar_event(event, window, cx)),
            ))
            .when_some(self.conversations.clone(), |this, conversations| {
                this.child(
                    v_flex()
                        .h_full()
                        .when_some(bot.as_ref(), |this, bot| {
                            this.child(self.render_bot_header(bot, cx))
                        })
                        .child(div().flex_1().min_h_0().child(ConversationList::new(
                            &conversations,
                            active_id.as_deref(),
                            cx.listener(|this, event, window, cx| {
                                this.on_list_event(event, window, cx)
                            }),
                        ))),
                )
            })
            .child(div().flex_1().min_w_0().h_full().map(|this| {
                match self.active_conversation().cloned() {
                    Some(view) => this.child(view),
                    None => this.child(
                        v_flex()
                            .size_full()
                            .items_center()
                            .justify_center()
                            .gap_2()
                            .text_color(cx.theme().muted_foreground)
                            .child(
                                div()
                                    .text_lg()
                                    .text_color(cx.theme().foreground)
                                    .child("No bot selected"),
                            )
                            .child("Pick a bot on the left, or create one with the + button."),
                    ),
                }
            }))
    }
}
