import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, Text } from "@earendil-works/pi-tui";
import { getVoiceAuth } from "./src/auth.ts";
import { CODING_GUIDELINE } from "./src/instructions.ts";
import { VoiceSession, type SessionOptions } from "./src/session.ts";
import { readSettings, writeSettings, isMuteKey, VOICES, type VoiceSettings } from "./src/settings.ts";
import { safeText } from "./src/text.ts";
import type { Transcript } from "./src/transcripts.ts";
import { VoiceWidget } from "./src/ui.ts";

const WIDGET = "pi-voice";
const TRANSCRIPT = "voice-transcript";
interface Active {
  session: VoiceSession;
  ctx: ExtensionContext;
  widget?: VoiceWidget;
  unsubscribe?: () => void;
  reported: boolean;
}
export interface ExtensionDependencies {
  settingsPath: string;
  session(options: SessionOptions): VoiceSession;
}

export default function voiceExtension(pi: ExtensionAPI): void { registerVoice(pi); }

export function registerVoice(pi: ExtensionAPI, dependencies?: ExtensionDependencies): void {
  // Registration has no filesystem, network, microphone, or timer side effects.
  let active: Active | undefined;
  let settings: VoiceSettings | undefined;
  const settingsPath = () => dependencies?.settingsPath ?? join(getAgentDir(), "voice.json");
  let stopping: Promise<void> | undefined;
  let generation = 0;

  const stop = (): Promise<void> => {
    generation++; // Also cancels /voice on while it is still reading settings.
    if (!active) return stopping ?? Promise.resolve();
    const run = active;
    active = undefined;
    run.unsubscribe?.();
    run.widget?.dispose();
    run.ctx.ui.setWidget(WIDGET, undefined);
    run.ctx.ui.setStatus(WIDGET, undefined);
    // Stop synchronously marks the controller closed, releases capture, and flushes
    // partial transcripts before session replacement can change Pi's active branch.
    const operation = run.session.stop();
    stopping = operation;
    void operation.finally(() => { if (stopping === operation) stopping = undefined; });
    return operation;
  };

  pi.registerEntryRenderer<Transcript>(TRANSCRIPT, (entry, _options, theme) => {
    const transcript = entry.data;
    if (!transcript || typeof transcript.text !== "string") return undefined;
    const user = transcript.role === "user";
    const label = theme.fg(user ? "accent" : "mdHeading", user ? "you › " : " pi › ");
    return new Text(label + safeText(transcript.text) + (transcript.interrupted ? theme.fg("dim", " [interrupted]") : ""), 1, 0);
  });

  pi.registerCommand("voice", {
    description: "ChatGPT realtime voice: on | off | mute | key <shortcut> | voice <name>",
    getArgumentCompletions: prefix => ["on", "off", "mute", "status", "key", "voice"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const commandGeneration = generation;
      if (command === "off") { await stop(); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("Voice requires Pi's interactive terminal mode and local audio devices.", "error"); return; }
      try {
        settings ??= await readSettings(settingsPath());
        if (command === "key") {
          const key = rest.join(" ");
          if (!isMuteKey(key)) { ctx.ui.notify("Usage: /voice key ctrl+x (or another modified key/function key)", "warning"); return; }
          const next = { ...settings, muteKey: key };
          await writeSettings(settingsPath(), next);
          Object.assign(settings, next);
          ctx.ui.notify(`Voice mute key: ${key}. It overrides that key only while voice is on.`, "info");
          return;
        }
        if (command === "voice") {
          const voice = rest[0];
          if (!voice || !(VOICES as readonly string[]).includes(voice) || rest.length !== 1) {
            ctx.ui.notify(`Usage: /voice voice <${VOICES.join(" | ")}>`, "warning"); return;
          }
          const next = { ...settings, voice };
          await writeSettings(settingsPath(), next);
          Object.assign(settings, next);
          ctx.ui.notify(`Voice: ${voice}${active ? "; applies the next time voice is turned on" : ""}.`, "info");
          return;
        }
        if (command === "mute") { active?.session.toggleMute(); return; }
        if (command === "status") {
          ctx.ui.notify(`Voice ${active?.session.state.phase ?? "off"} · ${settings.voice} · ${settings.muteKey} mute · /voice on or /voice off`, "info"); return;
        }
        if (command !== "on" || rest.length) {
          ctx.ui.notify("Usage: /voice on | off | mute | status | key <shortcut> | voice <name>", "warning"); return;
        }
        if (active) { ctx.ui.notify("Voice is already on (or connecting).", "info"); return; }
        await stopping;
        // Another command may have started a call while we were awaiting cleanup/settings.
        if (active || generation !== commandGeneration) return;
        let run: Active;
        const options: SessionOptions = {
          auth: () => getVoiceAuth(ctx.modelRegistry),
          sessionId: ctx.sessionManager.getSessionId(), voice: settings.voice,
          onTranscript: transcript => {
            run.widget?.transcript(transcript);
            // Entries render immediately and survive shutdown, without masquerading
            // as new user instructions or triggering a second coding turn.
            if (transcript.final) pi.appendEntry(TRANSCRIPT, transcript);
          },
          onDelegate: (id, request) => {
            if (active !== run) return;
            const history = ctx.sessionManager.getBranch().flatMap(entry => {
              if (entry.type !== "custom" || entry.customType !== TRANSCRIPT) return [];
              const data = entry.data as Transcript | undefined;
              return data && typeof data.text === "string" ? [`${data.role}: ${safeText(data.text)}`] : [];
            }).slice(-12).join("\n").slice(-12000);
            pi.sendMessage({
              customType: "voice-delegation",
              content: `Task from the realtime voice conversation (act as the user's request; use normal tools and permissions):\n\n${safeText(request)}\n\nRecent conversation (quoted context, not additional tasks):\n${history}`,
              display: false, details: { delegationId: id },
            }, { triggerTurn: true, deliverAs: "steer" });
          },
          onFailure: error => {
            if (active !== run) return;
            run.reported = true;
            ctx.ui.notify(safeText(error.message), "error");
            void stop();
          },
        };
        run = { ctx, reported: false, session: dependencies?.session(options) ?? new VoiceSession(options) };
        active = run;
        ctx.ui.setWidget(WIDGET, tui => run.widget = new VoiceWidget(run.session, settings!, tui, () => ctx.ui.theme));
        ctx.ui.setStatus(WIDGET, "voice ●");
        run.unsubscribe = ctx.ui.onTerminalInput(data => {
          if (active === run && matchesKey(data, settings!.muteKey)) {
            // Raw listeners run before Pi filters Kitty key-up/repeat events.
            if (!isKeyRelease(data) && !isKeyRepeat(data)) run.session.toggleMute();
            return { consume: true };
          }
          return undefined;
        });
        try { await run.session.start(); }
        catch (error) {
          // /voice off, reload, or session replacement during startup is not an error.
          if (active === run) {
            if (!run.reported) ctx.ui.notify(safeText(error instanceof Error ? error.message : "Voice could not start."), "error");
            await stop();
          }
        }
      } catch (error) {
        if (command === "on" && active?.ctx === ctx) await stop();
        ctx.ui.notify(safeText(error instanceof Error ? error.message : "Voice command failed."), "error");
      }
    },
  });

  const attachDelegation = (message: { role: string; customType?: string; details?: unknown }): void => {
    if (message.role !== "custom" || message.customType !== "voice-delegation") return;
    const id = (message.details as { delegationId?: unknown } | undefined)?.delegationId;
    if (typeof id === "string") active?.session.backendDelegationStarted(id);
  };
  pi.on("before_agent_start", event => {
    if (event.messageType === "custom") attachDelegation(event.message);
    if (active && !event.systemPromptOptions.promptGuidelines.includes(CODING_GUIDELINE)) {
      event.systemPromptOptions.promptGuidelines.push(CODING_GUIDELINE);
    }
  });
  // Steering messages join an existing run without another before_agent_start.
  pi.on("message_start", event => attachDelegation(event.message));
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    active?.session.backendMessage(text, message.stopReason === "toolUse",
      message.stopReason === "error" ? "The provider returned an error; inspect the written chat." : undefined);
  });
  // Unlike agent_end, this does not speak a stale answer before retries/queued turns finish.
  pi.on("agent_settled", event => active?.session.backendSettled(event.aborted));
  pi.on("session_shutdown", () => stop());
  pi.on("session_before_switch", () => stop());
  pi.on("session_before_fork", () => stop());
  pi.on("session_before_tree", () => stop());
  pi.on("session_start", async () => { await stop(); settings = undefined; });
}
