import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, Text, truncateToWidth, type Component, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatUsage } from "./format.ts";
import type { UsageResult } from "./types.ts";

/** Built from Pi's layout, wrapping, scroll and input components, not another TUI. */
export class UsageView implements Component {
  private readonly heading: Text;
  private readonly body: Text;
  private readonly scroll: ScrollView;
  private request?: AbortController;
  private disposed = false;
  private results?: UsageResult[];
  private loading = true;
  private failed = false;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } },
    private readonly theme: Pick<Theme, "fg" | "bold">,
    private readonly keys: Pick<KeybindingsManager, "matches">,
    private readonly done: () => void,
    private readonly load: (signal: AbortSignal) => Promise<UsageResult[]>,
  ) {
    const heading = new Text("", 0, 0);
    const body = new Text("", 0, 0);
    const scroll = new ScrollView(body, { scrollbar: "hidden", overscroll: "contain" });
    this.heading = heading;
    this.body = body;
    this.scroll = scroll;
    this.refresh();
  }

  refresh(): void {
    if (this.disposed || this.request) return;
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.failed = false;
    this.results = undefined; // Never leave an old account snapshot looking current.
    this.scroll.scrollToStart();
    this.update();
    void Promise.resolve().then(() => this.load(request.signal)).then(
      (results) => { if (!this.disposed && !request.signal.aborted) this.results = results; },
      () => { if (!this.disposed && !request.signal.aborted) this.failed = true; },
    ).finally(() => {
      if (this.request === request) this.request = undefined;
      if (!this.disposed) {
        this.loading = false;
        this.update();
      }
    });
  }

  private update(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    // Rebuild themed strings on invalidation, including palette changes.
    this.heading?.setText(this.theme.bold(this.theme.fg("accent", "Account usage")));
    this.body?.setText(this.loading ? this.theme.fg("muted", "Loading account usage…")
      : this.failed ? this.theme.fg("error", "Could not load usage. Press r to retry.")
      : formatUsage(this.results ?? []));
    this.heading?.invalidate();
    this.body?.invalidate();
  }

  render(width: number): string[] {
    // Pi 1.4 overlays call render() directly in BOTH screen modes, bypassing the
    // layout engine. Supply the viewport to ScrollView and clip here so neither
    // the footer nor later providers disappear below the overlay's maxHeight.
    const height = Math.max(1, Math.floor((this.tui.terminal?.rows ?? 24) * 0.85));
    const heading = height >= 4 ? this.heading.render(width).slice(0, 1) : [];
    const footer = height >= 2 ? [truncateToWidth("r refresh · ↑/↓ scroll · PgUp/PgDn · Enter/Esc close", width)] : [];
    const gap = height >= 8 ? [""] : [];
    const viewport = Math.max(1, height - heading.length - footer.length - 2 * gap.length);
    const content = this.scroll.render(width);
    this.scroll.updateLayout(content.length, viewport, () => this.tui.requestRender());
    const visible = content.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport);
    if (footer.length) {
      const position = content.length > viewport ? `${this.scroll.scrollTop + 1}–${Math.min(content.length, this.scroll.scrollTop + viewport)}/${content.length} · ` : "";
      footer[0] = truncateToWidth(this.theme.fg("dim", position + "r refresh · ↑/↓ scroll · PgUp/PgDn · Enter/Esc close"), width);
    }
    return [...heading, ...gap, ...visible, ...gap, ...footer];
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type !== "wheel") return;
    this.scroll.scrollBy(event.wheelDelta ?? 0);
    this.tui.requestRender();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "r")) this.refresh();
    else if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else return;
    this.tui.requestRender();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request?.abort();
  }
}
