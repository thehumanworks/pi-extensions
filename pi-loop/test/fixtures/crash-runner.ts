import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openScheduler, type Schedule } from "../../src/scheduler.ts";

const [mode, dir] = process.argv.slice(2);
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(mode === "init" ? [
  fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'once\\n' >> effect.txt; sleep 30" })], { stopReason: "toolUse" }),
] : [fauxAssistantMessage("Recovered after crash")]);
const scheduler = await openScheduler(await openNodeSqliteStorage(join(dir, "state.sqlite")), models);
if (mode === "init") {
  await scheduler.request({ action: "create", frequency: "1s", requestId: "crash-run", cwd: dir,
    prompt: "Perform the task.", model: { provider: faux.models[0].provider, modelId: faux.models[0].id },
    thinkingLevel: "off" });
} else {
  const end = Date.now() + 8000;
  while (true) {
    const [schedule] = await scheduler.request({ action: "list" }) as Schedule[];
    if (schedule.runs.length) {
      await scheduler.request({ action: "pause", id: schedule.id });
      await appendFile(join(dir, "recovered.txt"), schedule.runs[0].output);
      await scheduler.close();
      break;
    }
    if (Date.now() > end) throw new Error("Recovery timed out");
    await delay(20);
  }
}
