// Offline runtime factory override in the CHILD only. This exercises the real compiled dispatcher.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 60 });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("Offline deterministic worker answer with enough text to observe cancellation while streaming.")));
ModelRuntime.create = async () => models;
await import("../../dist/worker.js");
