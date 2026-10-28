//! The roster as a sidebar: one row per bot, the selected one filled.
//!
//! Primary task: pick the bot to talk to. Immediate actions: new bot, reload.
//! States: loading (first load shows a spinner row), empty (explains how to
//! create a bot), failed (message and a retry button), loaded.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::sidebar::{
    Sidebar, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuItem,
};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, Entity, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
    div, rems,
};
use pi_bot_api::Bot;

use crate::roster::{LoadState, Roster};

/// What the person asked for; the owner decides what happens.
#[derive(Clone, Debug, PartialEq)]
pub enum BotSidebarEvent {
    Select(String),
    NewBot,
    Reload,
}

type Handler = std::rc::Rc<dyn Fn(&BotSidebarEvent, &mut Window, &mut App)>;

/// The width that fits a bot name, its description and the selection fill.
const WIDTH_REMS: f32 = 17.;

#[derive(IntoElement)]
pub struct BotSidebar {
    roster: Entity<Roster>,
    selected: Option<String>,
    on_event: Handler,
}

impl BotSidebar {
    pub fn new(
        roster: &Entity<Roster>,
        selected: Option<&str>,
        on_event: impl Fn(&BotSidebarEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            roster: roster.clone(),
            selected: selected.map(str::to_string),
            on_event: std::rc::Rc::new(on_event),
        }
    }

    fn item(&self, bot: &Bot) -> SidebarMenuItem {
        let selected = self.selected.as_deref() == Some(bot.name.as_str());
        let name = bot.name.clone();
        let description = SharedString::from(bot.description.clone());
        let on_event = self.on_event.clone();
        SidebarMenuItem::new(SharedString::from(bot.name.clone()))
            .accessibility_label(format!("{}: {}", bot.name, bot.description))
            .active(selected)
            .suffix(move |_, cx| {
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .truncate()
                    .max_w(rems(8.))
                    .child(description.clone())
            })
            .on_click(move |_, window, cx| {
                on_event(&BotSidebarEvent::Select(name.clone()), window, cx)
            })
    }
}

impl RenderOnce for BotSidebar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let roster = self.roster.read(cx);
        let state = roster.state().clone();
        let bots: Vec<Bot> = roster.bots().to_vec();
        let on_new = self.on_event.clone();
        let on_reload = self.on_event.clone();

        let header = SidebarHeader::new().child(
            h_flex()
                .w_full()
                .justify_between()
                .child(
                    div()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child("Bots"),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new("reload-bots")
                                .ghost()
                                .small()
                                .icon(gpui_kit::assets::IconName::RefreshCw)
                                .accessibility_label("Reload bots")
                                .tooltip("Reload bots")
                                .loading(state.is_loading() && !bots.is_empty())
                                .on_click(move |_, window, cx| {
                                    on_reload(&BotSidebarEvent::Reload, window, cx)
                                }),
                        )
                        .child(
                            Button::new("new-bot")
                                .ghost()
                                .small()
                                .icon(gpui_kit::assets::IconName::Plus)
                                .accessibility_label("New bot…")
                                .tooltip("New bot…")
                                .on_click(move |_, window, cx| {
                                    on_new(&BotSidebarEvent::NewBot, window, cx)
                                }),
                        ),
                ),
        );

        let mut menu = SidebarMenu::new();
        for bot in &bots {
            menu = menu.child(self.item(bot));
        }

        let footer = match (&state, bots.is_empty()) {
            (LoadState::Loading, true) => Some(status_row(
                Spinner::new().small().into_any_element(),
                "Loading bots…",
                cx,
            )),
            (LoadState::Failed(message), _) => {
                let on_retry = self.on_event.clone();
                Some(
                    v_flex()
                        .gap_2()
                        .child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().danger)
                                .child(SharedString::from(message.clone())),
                        )
                        .child(
                            Button::new("retry-bots")
                                .outline()
                                .small()
                                .label("Retry")
                                .on_click(move |_, window, cx| {
                                    on_retry(&BotSidebarEvent::Reload, window, cx)
                                }),
                        )
                        .into_any_element(),
                )
            }
            (LoadState::Loaded, true) => Some(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("No bots yet. Create one with the + button, or with /bot new in Pi.")
                    .into_any_element(),
            ),
            _ => None,
        };

        let mut sidebar = Sidebar::new("bots")
            .w(rems(WIDTH_REMS))
            .header(header)
            .child(menu);
        if let Some(footer) = footer {
            sidebar = sidebar.footer(SidebarFooter::new().child(footer));
        }
        sidebar
    }
}

fn status_row(
    indicator: gpui_kit::AnyElement,
    text: &'static str,
    cx: &App,
) -> gpui_kit::AnyElement {
    h_flex()
        .gap_2()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .child(indicator)
        .child(text)
        .into_any_element()
}
