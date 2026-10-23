import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { VoiceSession } from "./session.ts";
import type { VoiceSettings } from "./settings.ts";
import type { Transcript } from "./transcripts.ts";
import { level, safeText } from "./text.ts";

const BARS = "▁▂▃▄▅▆▇█";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
interface Tile { text: string; since: number }

export class AnimatedText {
  private tiles: Tile[] = [];
  update(text: string, now: number): void {
    const chars = Array.from(segmenter.segment(safeText(text)), part => part.segment);
    let same = 0;
    while (same < chars.length && this.tiles[same]?.text === chars[same]) same++;
    this.tiles = this.tiles.slice(0, same).concat(chars.slice(same).map(text => ({ text, since: now })));
  }
  render(now: number, dim: (text: string) => string): string {
    return this.tiles.map(tile => {
      const age = now - tile.since;
      if (age < 70 && tile.text.trim()) return dim("░".repeat(Math.max(1, visibleWidth(tile.text))));
      if (age < 180) return dim(tile.text);
      return tile.text;
    }).join("");
  }
}

export function meter(history: readonly number[]): string {
  return history.map(sample => BARS[Math.round(Math.sqrt(level(sample)) * 7)]).join("");
}

/** Compact, non-modal strip: the user's editor and normal Pi controls remain intact. */
export class VoiceWidget implements Component {
  private readonly input = Array<number>(10).fill(0);
  private readonly output = Array<number>(10).fill(0);
  private readonly text: Partial<Record<Transcript["role"], { animation: AnimatedText; turn: number; finalAt?: number }>> = {};
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly getTheme: () => Theme;

  constructor(
    private readonly session: VoiceSession, private readonly settings: VoiceSettings,
    private readonly tui: Pick<TUI, "requestRender">, theme: Theme | (() => Theme),
  ) {
    this.getTheme = typeof theme === "function" ? theme : () => theme;
    this.timer = setInterval(() => {
      this.session.tick();
      this.input.push(this.session.state.muted ? 0 : this.session.state.inputLevel); this.input.shift();
      this.output.push(this.session.state.outputLevel); this.output.shift();
      this.tui.requestRender();
    }, 45);
    this.timer.unref();
  }

  transcript(value: Transcript, now = Date.now()): void {
    if (this.disposed) return;
    let current = this.text[value.role];
    if (!current || current.turn !== value.turn) {
      current = { animation: new AnimatedText(), turn: value.turn };
      this.text[value.role] = current;
    }
    current.animation.update(value.text, now);
    if (value.final) current.finalAt = now;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.getTheme(), state = this.session.state;
    const inner = Math.max(1, width - 2);
    const heading = theme.fg("muted", "voice ") +
      theme.fg(state.muted ? "dim" : "error", "●") + " " + theme.fg("text", state.phase);
    const help = theme.fg("dim", `${this.settings.muteKey} ${state.muted ? "unmute" : "mute"}   /voice off`);
    const gap = inner - visibleWidth(heading) - visibleWidth(help);
    const lines = [gap >= 2 ? heading + " ".repeat(gap) + help : heading];
    lines.push(
      theme.fg("muted", "  mic ") + theme.fg(state.muted ? "dim" : "accent", meter(this.input)) +
      theme.fg("muted", "   pi ") + theme.fg("mdHeading", meter(this.output)),
    );
    const now = Date.now();
    for (const role of ["user", "assistant"] as const) {
      const current = this.text[role];
      if (!current || (current.finalAt !== undefined && now - current.finalAt > 1000)) continue;
      const label = role === "user" ? "you › " : " pi › ";
      const content = current.animation.render(now, text => theme.fg("dim", text));
      const textWidth = Math.max(1, inner - visibleWidth(label));
      const wrapped = wrapTextWithAnsi(content.replaceAll("\n", " "), textWidth).slice(-2);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(theme.fg(role === "user" ? "accent" : "mdHeading", i === 0 ? label : " ".repeat(label.length)) + wrapped[i]);
      }
    }
    return lines.map(line => {
      const content = truncateToWidth(" " + line, width, "");
      return theme.bg("customMessageBg", content + " ".repeat(Math.max(0, width - visibleWidth(content))));
    });
  }

  invalidate(): void { /* Colors and layout are recomputed from the current theme each render. */ }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
