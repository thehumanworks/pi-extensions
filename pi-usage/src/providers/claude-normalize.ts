import { z } from "zod";
import { UsageError, type UsageSnapshot, type UsageWindow } from "../types.ts";

const percent = z.number().finite().nonnegative().nullish();
const windowSchema = z.object({ utilization: percent, resets_at: z.string().nullish() });
const modelSchema = z.object({ display_name: z.string().min(1) });
const payloadSchema = z.object({
  five_hour: windowSchema.nullish(),
  seven_day: windowSchema.nullish(),
  seven_day_opus: windowSchema.nullish(),
  seven_day_sonnet: windowSchema.nullish(),
  // Claude Agent SDK get_usage normalizes the model rows into this field.
  model_scoped: z.array(windowSchema.extend({ display_name: z.string().min(1) })).nullish(),
  // Native Pi OAuth uses the endpoint directly. Fable lives here, NOT in an
  // assumed seven_day_fable field. is_active is a headline pick, not a filter.
  limits: z.array(z.object({
    kind: z.string(),
    percent,
    resets_at: z.string().nullish(),
    scope: z.object({ model: modelSchema.nullish(), surface: modelSchema.nullish() }).nullish(),
  })).nullish(),
}).refine((data) => Object.values(data).some((value) => value !== undefined));

export interface ClaudeIdentity { account: string; plan?: string; source: string }

function toWindow(label: string, value?: z.infer<typeof windowSchema> | null): UsageWindow {
  // Invalid/absent reset times stay unknown. Never use OAuth expiry as a reset.
  const validTime = z.iso.datetime({ offset: true }).safeParse(value?.resets_at);
  const reset = validTime.success ? Date.parse(validTime.data) : NaN;
  return {
    label,
    display: "used",
    remainingPercent: value?.utilization == null ? undefined : Math.max(0, 100 - value.utilization),
    resetsAt: Number.isFinite(reset) ? reset : undefined,
  };
}

export function normalizeClaudeUsage(payload: unknown, identity: ClaudeIdentity, now = Date.now()): UsageSnapshot {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new UsageError("Claude returned an unrecognized usage response. Check Claude Code /usage or the usage dashboard.");
  const data = parsed.data;
  let session = data.five_hour;
  let weekly = data.seven_day;
  const models = new Map<string, { name: string; window: z.infer<typeof windowSchema> }>();
  const addModel = (name: string, window: z.infer<typeof windowSchema>) => {
    const key = name.trim().toLowerCase();
    if (key && !models.has(key)) models.set(key, { name: name.trim(), window });
  };
  if (data.seven_day_opus) addModel("Opus", data.seven_day_opus);
  if (data.seven_day_sonnet) addModel("Sonnet", data.seven_day_sonnet);
  for (const model of data.model_scoped ?? []) addModel(model.display_name, model);
  for (const limit of data.limits ?? []) {
    const value = { utilization: limit.percent, resets_at: limit.resets_at };
    if (limit.kind === "session" && !limit.scope?.model && !limit.scope?.surface) session ??= value;
    if (limit.kind === "weekly_all" && !limit.scope?.model && !limit.scope?.surface) weekly ??= value;
    if (limit.kind === "weekly_scoped" && limit.scope?.model && !limit.scope.surface) {
      addModel(limit.scope.model.display_name, value);
    }
  }
  const windows = [toWindow("Current session (5h)", session), toWindow("Current week (all models)", weekly)];
  // Always expose the three requested buckets. A missing Fable row is unknown,
  // not 0% used; extra plan-dependent model buckets follow it.
  const fable = models.get("fable");
  windows.push(toWindow("Current week (Fable)", fable?.window));
  for (const [key, model] of models) {
    if (key !== "fable") windows.push(toWindow(`Current week (${model.name})`, model.window));
  }
  return {
    ...identity,
    fetchedAt: now,
    groups: [{ label: "Subscription allowance", windows, limitReached: windows.some((window) => window.remainingPercent === 0) }],
    notes: ["Claude subscription usage, not this Pi session's token totals. App-specific caps are not included."],
  };
}
