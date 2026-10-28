//! Create or change a bot's definition.
//!
//! Primary task: describe the bot (name, job, model, reasoning effort, persona,
//! and optionally which tools and skills it may use). Decision information: the
//! models the server knows. Keyboard path: Tab through the fields, Enter in any
//! single-line field submits, Escape cancels (handled by the sheet that hosts
//! the editor).

use gpui_kit::component::IndexPath;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::form::{Field, Form};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, TestSupportExt as _,
    Window, div,
};
use pi_bot_api::{Bot, BotCreate, BotPatch, Model};

/// The server's reasoning levels, plus "Inherit" for none.
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const INHERIT: &str = "Inherit from Pi";

#[derive(Clone, Debug, PartialEq)]
pub enum BotEditorEvent {
    Create(BotCreate),
    Update { name: String, patch: BotPatch },
    Cancel,
}

pub struct BotEditor {
    /// `Some` when editing an existing bot; its name cannot change.
    original: Option<Bot>,
    name: Entity<InputState>,
    description: Entity<InputState>,
    model: Entity<SelectState<Vec<SharedString>>>,
    thinking: Entity<SelectState<Vec<SharedString>>>,
    prompt: Entity<TextareaState>,
    tools: Entity<InputState>,
    skills: Entity<InputState>,
    error: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<BotEditorEvent> for BotEditor {}

impl BotEditor {
    pub fn new(
        original: Option<Bot>,
        models: &[Model],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let bot = original.clone().unwrap_or_default();
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("reviewer")
                .default_value(bot.name.clone())
        });
        let description = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Reviews diffs for security issues")
                .default_value(bot.description.clone())
        });
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("You are a meticulous reviewer…")
                .default_value(bot.prompt.clone())
                .auto_grow(6, 16)
        });
        let tools = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("read, grep, bash")
                .default_value(bot.tools.join(", "))
        });
        let skills = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("review-diff, write-like-me")
                .default_value(bot.skills.join(", "))
        });

        let model_items: Vec<SharedString> = std::iter::once(SharedString::from(INHERIT))
            .chain(
                models
                    .iter()
                    .map(|model| SharedString::from(model.id.clone())),
            )
            .collect();
        let model_index = position(&model_items, bot.model.as_deref());
        let model = cx.new(|cx| {
            SelectState::new(model_items, Some(model_index), window, cx).searchable(true)
        });

        let thinking_items: Vec<SharedString> = std::iter::once(SharedString::from(INHERIT))
            .chain(
                THINKING_LEVELS
                    .iter()
                    .map(|level| SharedString::from(*level)),
            )
            .collect();
        let thinking_index = position(&thinking_items, bot.thinking.as_deref());
        let thinking =
            cx.new(|cx| SelectState::new(thinking_items, Some(thinking_index), window, cx));

        if original.is_some() {
            name.update(cx, |state, cx| state.set_readonly(true, cx));
        }

        let submit_on_enter = |this: &mut Self,
                               _: &Entity<InputState>,
                               event: &InputEvent,
                               window: &mut Window,
                               cx: &mut Context<Self>| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.submit(window, cx);
            }
        };
        let subscriptions = vec![
            cx.subscribe_in(&name, window, submit_on_enter),
            cx.subscribe_in(&description, window, submit_on_enter),
            cx.subscribe_in(&tools, window, submit_on_enter),
            cx.subscribe_in(&skills, window, submit_on_enter),
            cx.subscribe(&model, |this, _, _: &SelectEvent<Vec<SharedString>>, cx| {
                this.clear_error(cx)
            }),
            cx.subscribe(
                &thinking,
                |this, _, _: &SelectEvent<Vec<SharedString>>, cx| this.clear_error(cx),
            ),
        ];

        Self {
            original,
            name,
            description,
            model,
            thinking,
            prompt,
            tools,
            skills,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn is_new(&self) -> bool {
        self.original.is_none()
    }

    /// The validation message shown under the form, if any.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        let first = if self.is_new() {
            &self.name
        } else {
            &self.description
        };
        first.update(cx, |state, cx| state.focus(window, cx));
    }

    /// The action bar: Cancel and Create/Save with the validation message. The
    /// sheet renders it in its footer so it stays in view while the form scrolls.
    pub fn actions(editor: &Entity<Self>, cx: &App) -> impl IntoElement {
        let this = editor.read(cx);
        let error = this.error.clone();
        let label = if this.is_new() { "Create" } else { "Save" };
        let cancel = editor.clone();
        let save = editor.clone();
        v_flex()
            .gap_2()
            .when_some(error, |this, error| {
                this.child(div().text_sm().text_color(cx.theme().danger).child(error))
            })
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("cancel-bot")
                            .outline()
                            .label("Cancel")
                            .on_click(move |_, _, cx| {
                                cancel.update(cx, |this, cx| this.cancel(cx))
                            }),
                    )
                    .child(Button::new("save-bot").primary().label(label).on_click(
                        move |_, window, cx| save.update(cx, |this, cx| this.submit(window, cx)),
                    )),
            )
    }

    /// Validates and emits the create or update event, or shows what is missing
    /// and focuses that field.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().trim().to_string();
        let description = self.description.read(cx).value().trim().to_string();
        let prompt = self.prompt.read(cx).value().trim().to_string();
        let model = selected(&self.model, cx);
        let thinking = selected(&self.thinking, cx);
        let tools = parse_list(self.tools.read(cx).value().as_ref());
        let skills = parse_list(self.skills.read(cx).value().as_ref());

        let valid_name = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        let problem = if name.is_empty() {
            Some((
                "Enter a name: lowercase letters, digits, - or _.",
                Focus::Name,
            ))
        } else if self.is_new() && !valid_name {
            Some((
                "Names use lowercase letters, digits, - or _ only.",
                Focus::Name,
            ))
        } else if description.is_empty() {
            Some((
                "Enter a one-line description of the bot's job.",
                Focus::Description,
            ))
        } else if prompt.is_empty() {
            Some((
                "Enter the persona: the instructions the bot works from.",
                Focus::Prompt,
            ))
        } else {
            None
        };
        if let Some((message, field)) = problem {
            self.error = Some(message.into());
            match field {
                Focus::Name => self.name.update(cx, |state, cx| state.focus(window, cx)),
                Focus::Description => self
                    .description
                    .update(cx, |state, cx| state.focus(window, cx)),
                Focus::Prompt => self.prompt.update(cx, |state, cx| state.focus(window, cx)),
            }
            cx.notify();
            return;
        }

        let event = match &self.original {
            None => BotEditorEvent::Create(BotCreate {
                name,
                description,
                prompt,
                model,
                thinking,
                tools,
                skills,
            }),
            Some(original) => {
                let mut patch = BotPatch::new();
                if description != original.description {
                    patch = patch.description(description);
                }
                if prompt != original.prompt {
                    patch = patch.prompt(prompt);
                }
                if model != original.model {
                    patch = patch.model(model.as_deref());
                }
                if thinking != original.thinking {
                    patch = patch.thinking(thinking.as_deref());
                }
                if tools != original.tools {
                    patch = patch.tools(&tools);
                }
                if skills != original.skills {
                    patch = patch.skills(&skills);
                }
                if patch.is_empty() {
                    cx.emit(BotEditorEvent::Cancel);
                    return;
                }
                BotEditorEvent::Update {
                    name: original.name.clone(),
                    patch,
                }
            }
        };
        cx.emit(event);
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        cx.emit(BotEditorEvent::Cancel);
    }

    fn clear_error(&mut self, cx: &mut Context<Self>) {
        if self.error.take().is_some() {
            cx.notify();
        }
    }
}

/// The field a validation message points at.
enum Focus {
    Name,
    Description,
    Prompt,
}

/// Names typed as a list: commas, spaces or newlines separate them.
fn parse_list(text: &str) -> Vec<String> {
    text.split([',', ' ', '\n', '\t'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

/// The row of `value` in `items`, or the first row ("Inherit") when absent.
fn position(items: &[SharedString], value: Option<&str>) -> IndexPath {
    let row = value
        .and_then(|value| items.iter().position(|item| item.as_ref() == value))
        .unwrap_or(0);
    IndexPath::new(row)
}

/// The chosen value, with "Inherit" mapped to `None`.
fn selected(
    state: &Entity<SelectState<Vec<SharedString>>>,
    cx: &Context<BotEditor>,
) -> Option<String> {
    state
        .read(cx)
        .selected_value()
        .filter(|value| value.as_ref() != INHERIT)
        .map(|value| value.to_string())
}

impl Render for BotEditor {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let is_new = self.is_new();
        v_flex()
            .gap_4()
            .child(
                Form::new()
                    .child(
                        Field::new()
                            .label("Name")
                            .description(if is_new { "Lowercase letters, digits, - or _. It becomes the home directory name." } else { "The name is the bot's identity and cannot change." })
                            .child(Input::new(&self.name).id("bot-name").readonly(!is_new).aria_label("Name")),
                    )
                    .child(Field::new().label("Description").description("The bot's job in one line. Agents read it when choosing whom to delegate to.").child(Input::new(&self.description).id("bot-description").aria_label("Description")))
                    .child(
                        Field::new().label("Model and reasoning effort").child(
                            h_flex().gap_3().child(Select::new(&self.model).id("bot-model").accessibility_label("Model").search_placeholder("Search models…").menu_width(gpui_kit::rems(24.))).child(Select::new(&self.thinking).id("bot-thinking").accessibility_label("Reasoning effort")),
                        ),
                    )
                    .child(Field::new().label("Persona").description("Role, expertise, standards and working style. Pi's default prompt and tools stay in place.").child(div().id("bot-persona").test_support().child(Textarea::new(&self.prompt).aria_label("Persona"))))
                    .child(Field::new().label("Tools").description("Tool names or * globs the bot may use, separated by commas. Empty keeps Pi's default tools.").child(Input::new(&self.tools).id("bot-tools").aria_label("Tools")))
                    .child(Field::new().label("Skills").description("Shared skill names or paths, separated by commas. Empty keeps every skill; the bot's own skills always load.").child(Input::new(&self.skills).id("bot-skills").aria_label("Skills"))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::parse_list;

    #[test]
    fn lists_accept_commas_spaces_and_newlines() {
        assert_eq!(
            parse_list("read, grep bash\n edit,,"),
            ["read", "grep", "bash", "edit"]
        );
        assert!(parse_list("  ").is_empty());
    }
}
