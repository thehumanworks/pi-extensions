//! Bots: the roster kept in sync with the server, the sidebar that lists them
//! and the editor that creates or changes one.

mod editor;
mod roster;
mod sidebar;

pub use editor::{BotEditor, BotEditorEvent};
pub use roster::{LoadState, Roster, RosterEvent};
pub use sidebar::{BotSidebar, BotSidebarEvent};
