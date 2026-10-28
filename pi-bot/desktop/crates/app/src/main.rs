//! pi-bot desktop: a window on the bots served by `pi-bot-server`.
//!
//! ```text
//! pi-bot-desktop [--server URL]
//!   --server URL   pi-bot-server address (default $PI_BOT_SERVER_URL or http://[::1]:7733)
//! ```

use gpui_kit::{
    AppContext as _, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, px, size,
};
use pi_bot_api::{Client, DEFAULT_SERVER_URL};

use pi_bot_desktop::{FocusComposer, KEY_CONTEXT, NewConversation, Reload, Workspace};

#[derive(Debug, PartialEq)]
struct Options {
    server: String,
}

fn parse_options(
    args: impl IntoIterator<Item = String>,
    env_server: Option<String>,
) -> Result<Options, String> {
    let mut server = env_server.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--server" => {
                server = args
                    .next()
                    .ok_or("--server needs a URL, like http://[::1]:7733")?
            }
            "-h" | "--help" => return Err(String::new()),
            other if other.starts_with("--server=") => {
                server = other["--server=".len()..].to_string()
            }
            other => return Err(format!("Unknown argument {other}")),
        }
    }
    if !server.starts_with("http://") && !server.starts_with("https://") {
        return Err(format!(
            "The server URL must start with http:// or https://, got {server}"
        ));
    }
    Ok(Options { server })
}

fn main() {
    let options = match parse_options(
        std::env::args().skip(1),
        std::env::var("PI_BOT_SERVER_URL").ok(),
    ) {
        Ok(options) => options,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("{message}\n");
            }
            eprintln!(
                "Usage: pi-bot-desktop [--server URL]\n  --server URL   pi-bot-server address (default $PI_BOT_SERVER_URL or {DEFAULT_SERVER_URL})"
            );
            std::process::exit(if message.is_empty() { 0 } else { 2 });
        }
    };
    let client = Client::new(&options.server);

    gpui_kit::application()
        .with_assets(gpui_kit::assets::AllAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.bind_keys([
                KeyBinding::new("cmd-n", NewConversation, Some(KEY_CONTEXT)),
                KeyBinding::new("ctrl-n", NewConversation, Some(KEY_CONTEXT)),
                KeyBinding::new("cmd-r", Reload, Some(KEY_CONTEXT)),
                KeyBinding::new("ctrl-r", Reload, Some(KEY_CONTEXT)),
                KeyBinding::new("cmd-l", FocusComposer, Some(KEY_CONTEXT)),
                KeyBinding::new("ctrl-l", FocusComposer, Some(KEY_CONTEXT)),
                KeyBinding::new(
                    "escape",
                    pi_bot_conversation::Stop,
                    Some(pi_bot_conversation::KEY_CONTEXT),
                ),
            ]);
            let options = WindowOptions {
                titlebar: Some(TitlebarOptions {
                    title: Some("pi-bot".into()),
                    ..Default::default()
                }),
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1180.), px(760.)),
                    cx,
                ))),
                window_min_size: Some(size(px(720.), px(480.))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| Workspace::new(client, window, cx))
            })
            .expect("open the pi-bot window");
            cx.activate(true);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn server_comes_from_flag_then_env_then_default() {
        assert_eq!(
            parse_options(args(&[]), None).unwrap().server,
            DEFAULT_SERVER_URL
        );
        assert_eq!(
            parse_options(args(&[]), Some("http://127.0.0.1:1".into()))
                .unwrap()
                .server,
            "http://127.0.0.1:1"
        );
        assert_eq!(
            parse_options(
                args(&["--server", "http://[::1]:9"]),
                Some("http://127.0.0.1:1".into())
            )
            .unwrap()
            .server,
            "http://[::1]:9"
        );
        assert_eq!(
            parse_options(args(&["--server=http://h:9"]), None)
                .unwrap()
                .server,
            "http://h:9"
        );
    }

    #[test]
    fn bad_arguments_explain_themselves() {
        assert!(
            parse_options(args(&["--server"]), None)
                .unwrap_err()
                .contains("needs a URL")
        );
        assert!(
            parse_options(args(&["--server", "h:9"]), None)
                .unwrap_err()
                .contains("http://")
        );
        assert!(
            parse_options(args(&["--bogus"]), None)
                .unwrap_err()
                .contains("--bogus")
        );
        assert_eq!(parse_options(args(&["--help"]), None).unwrap_err(), "");
    }
}
