import type { Role } from "./protocol.ts";
import { safeText } from "./text.ts";

export interface Transcript {
  role: Role;
  turn: number;
  text: string;
  final: boolean;
  interrupted?: boolean;
}
interface Slot { turn: number; text: string; final: boolean }
const MAX_TEXT = 64 * 1024;

/** Delta events are deltas (not tokens to trim); turn.done is authoritative. */
export class Transcripts {
  private slots: Record<Role, Slot> = {
    user: { turn: 0, text: "", final: true },
    assistant: { turn: 0, text: "", final: true },
  };
  private finals = new Set<string>();

  accept(role: Role, text: string, final: boolean, id?: string): Transcript | undefined {
    const key = id ? `${role}:${id}` : undefined;
    if (key && this.finals.has(key)) return;
    const slot = this.slots[role];
    const clean = safeText(text);
    if (!clean && !final) return;
    if (final && !key && slot.final && slot.text === clean) return;
    if (slot.final) { slot.turn++; slot.text = ""; }
    slot.text = (final ? clean || slot.text : slot.text + clean).slice(-MAX_TEXT);
    slot.final = final;
    if (final && key) {
      this.finals.add(key);
      if (this.finals.size > 512) this.finals.delete(this.finals.values().next().value!);
    }
    if (!slot.text.trim()) return;
    return { role, turn: slot.turn, text: slot.text, final };
  }

  flush(): Transcript[] {
    const result: Transcript[] = [];
    for (const role of ["user", "assistant"] as const) {
      const slot = this.slots[role];
      if (!slot.final && slot.text.trim()) {
        slot.final = true;
        result.push({ role, turn: slot.turn, text: slot.text, final: true, interrupted: true });
      }
    }
    return result;
  }
}
