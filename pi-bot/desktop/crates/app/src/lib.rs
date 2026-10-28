//! The pi-bot desktop window. `main.rs` parses options and opens it; tests
//! open it against a scripted server.

mod workspace;

pub use workspace::{FocusComposer, KEY_CONTEXT, NewConversation, Reload, Workspace};
