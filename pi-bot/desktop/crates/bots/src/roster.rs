//! The list of bots and models known to the server, loaded in the background.

use gpui_kit::{AppContext as _, AsyncApp, Context, EventEmitter, Task, WeakEntity};
use pi_bot_api::{Bot, BotCreate, BotPatch, Client, Model};

/// Where an asynchronous load stands. Earlier data stays usable while reloading.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum LoadState {
    #[default]
    Idle,
    Loading,
    Loaded,
    Failed(String),
}

impl LoadState {
    pub fn is_loading(&self) -> bool {
        matches!(self, LoadState::Loading)
    }

    pub fn error(&self) -> Option<&str> {
        match self {
            LoadState::Failed(message) => Some(message),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RosterEvent {
    /// Bots or models changed, or a load started or ended.
    Changed,
    /// A bot was created, updated or archived; shown as a notification.
    Notice(String),
    /// A write failed; the message says what and how to recover.
    Failed(String),
}

/// Bots and models from one server. Writes refresh the list when they succeed.
pub struct Roster {
    client: Client,
    bots: Vec<Bot>,
    /// Definitions the server could not parse, one message each.
    broken: Vec<String>,
    models: Vec<Model>,
    state: LoadState,
    models_state: LoadState,
    /// Rejects results of superseded loads.
    revision: u64,
    _load: Option<Task<()>>,
    _write: Option<Task<()>>,
}

impl EventEmitter<RosterEvent> for Roster {}

impl Roster {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            bots: Vec::new(),
            broken: Vec::new(),
            models: Vec::new(),
            state: LoadState::Idle,
            models_state: LoadState::Idle,
            revision: 0,
            _load: None,
            _write: None,
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn bots(&self) -> &[Bot] {
        &self.bots
    }

    pub fn bot(&self, name: &str) -> Option<&Bot> {
        self.bots.iter().find(|bot| bot.name == name)
    }

    pub fn broken(&self) -> &[String] {
        &self.broken
    }

    pub fn models(&self) -> &[Model] {
        &self.models
    }

    pub fn state(&self) -> &LoadState {
        &self.state
    }

    pub fn models_state(&self) -> &LoadState {
        &self.models_state
    }

    /// Reload bots. Models load once; call [`Roster::reload_models`] to refresh them.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        let revision = self.revision;
        self.state = LoadState::Loading;
        cx.emit(RosterEvent::Changed);
        cx.notify();
        let client = self.client.clone();
        self._load = Some(
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                let result = cx.background_spawn(async move { client.bots() }).await;
                this.update(cx, |this, cx| {
                    if this.revision != revision {
                        return;
                    }
                    match result {
                        Ok((bots, broken)) => {
                            this.bots = bots;
                            this.broken = broken;
                            this.state = LoadState::Loaded;
                        }
                        Err(error) => this.state = LoadState::Failed(error.to_string()),
                    }
                    cx.emit(RosterEvent::Changed);
                    cx.notify();
                })
                .ok();
            }),
        );
        if self.models.is_empty() && !self.models_state.is_loading() {
            self.reload_models(cx);
        }
    }

    pub fn reload_models(&mut self, cx: &mut Context<Self>) {
        self.models_state = LoadState::Loading;
        let client = self.client.clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = cx.background_spawn(async move { client.models() }).await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(models) => {
                        this.models = models;
                        this.models_state = LoadState::Loaded;
                    }
                    Err(error) => this.models_state = LoadState::Failed(error.to_string()),
                }
                cx.emit(RosterEvent::Changed);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn create(&mut self, bot: BotCreate, cx: &mut Context<Self>) {
        let name = bot.name.clone();
        self.write(cx, format!("Created \"{name}\"."), move |client| {
            client.create_bot(&bot).map(|_| ())
        });
    }

    pub fn update(&mut self, name: &str, patch: BotPatch, cx: &mut Context<Self>) {
        let owned = name.to_string();
        self.write(cx, format!("Saved \"{name}\"."), move |client| {
            client.update_bot(&owned, &patch).map(|_| ())
        });
    }

    /// Moves the bot's home into the server's archive directory.
    pub fn archive(&mut self, name: &str, cx: &mut Context<Self>) {
        let owned = name.to_string();
        self.write(cx, format!("Archived \"{name}\"."), move |client| {
            client.archive_bot(&owned).map(|_| ())
        });
    }

    /// Runs one write in the background, then reloads and reports the outcome.
    fn write(
        &mut self,
        cx: &mut Context<Self>,
        success: String,
        operation: impl FnOnce(&Client) -> pi_bot_api::Result<()> + Send + 'static,
    ) {
        let client = self.client.clone();
        self._write = Some(
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                let result = cx.background_spawn(async move { operation(&client) }).await;
                this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        cx.emit(RosterEvent::Notice(success));
                        this.reload(cx);
                    }
                    Err(error) => cx.emit(RosterEvent::Failed(error.to_string())),
                })
                .ok();
            }),
        );
    }
}
