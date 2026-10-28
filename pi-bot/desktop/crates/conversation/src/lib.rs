//! Conversations with one bot: the list of past conversations, and the live
//! transcript with its composer and the questions the bot asks.

mod list;
mod transcript;
mod view;

pub use list::{ConversationList, ConversationListEvent, Conversations, ConversationsEvent};
pub use transcript::{Item, Transcript};
pub use view::{ConversationView, ConversationViewEvent, KEY_CONTEXT, Send, Stop};
