// Offline-only model: submit a noncooperative tool call through the real durable run loop.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100000 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("block", { marker: "unused", mode: "cpu" }), { stopReason: "toolUse" })]);
ModelRuntime.create = async () => models;
await import("../../dist/worker.js");
