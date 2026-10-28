//! Client for the pi-bot server (`pi-bot-server`, OpenAPI 3.1.0 at `/openapi.json`).
//!
//! Requests are blocking and meant to run on a background thread; update streams run on
//! their own thread and deliver [`Update`]s through a channel the UI can await.

mod client;
mod sse;
pub mod types;

pub use client::{Client, Error, Result};
pub use sse::Updates;
pub use types::*;

/// The address a freshly installed server listens on.
pub const DEFAULT_SERVER_URL: &str = "http://[::1]:7733";
