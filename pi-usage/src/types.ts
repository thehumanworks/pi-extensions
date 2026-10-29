import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AuthRegistry = Pick<ExtensionContext["modelRegistry"], "getProviderAuth" | "getProvider">;

/** Provider adapters own auth and wire formats; the view only knows these types. */
export interface UsageWindow {
  label: string;
  remainingPercent?: number;
  resetsAt?: number; // Unix milliseconds, not credential expiry.
}

export interface UsageGroup {
  label: string;
  windows: UsageWindow[];
  limitReached?: boolean;
}

export interface UsageSnapshot {
  account: string;
  plan?: string;
  source: string;
  fetchedAt: number;
  groups: UsageGroup[];
  credits?: { unlimited?: boolean; hasCredits?: boolean; balance?: string };
  notes: string[];
}

export interface UsageProvider {
  id: string;
  label: string;
  dashboardUrl: string;
  fetch(context: { registry: AuthRegistry; signal: AbortSignal }): Promise<UsageSnapshot>;
}

export type UsageResult = {
  provider: Pick<UsageProvider, "id" | "label" | "dashboardUrl">;
} & (
  | { status: "ok"; snapshot: UsageSnapshot }
  | { status: "unavailable" | "error"; message: string }
);

/** Only static, user-safe messages belong here. Never wrap raw SDK/auth errors. */
export class UsageError extends Error {
  constructor(message: string, public readonly status: "unavailable" | "error" = "error") {
    super(message);
    this.name = "UsageError";
  }
}
