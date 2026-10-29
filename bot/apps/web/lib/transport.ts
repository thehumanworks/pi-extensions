import { DefaultChatTransport } from "ai";
import type { BotUIMessage } from "@nothumanwork/bot-ai-sdk";
import type { RunState } from "./chat";

/** All browser requests stay same-origin. Session/run refs are read at request time. */
export function createChatTransport(options: {
  session: () => string | undefined;
  run: () => RunState | undefined;
  fetch?: typeof fetch;
}) {
  // Freeze admission scope per user turn. Learning the newly created session ID
  // must not change an idempotent retry's durable backend fingerprint.
  const admissions = new Map<string, string | undefined>();
  return new DefaultChatTransport<BotUIMessage>({
    api: "/api/chat",
    fetch: options.fetch,
    credentials: "same-origin",
    resumeStreamIsReplay: true,
    prepareSendMessagesRequest: ({ id, messages, trigger }) => {
      const newest = messages.findLast(message => message.role === "user");
      if (!newest) throw new Error("Write a message before sending.");
      const requestId = `${id}:${newest.id}`;
      if (!admissions.has(requestId)) {
        if (admissions.size >= 1024) admissions.delete(admissions.keys().next().value!);
        admissions.set(requestId, options.session());
      }
      return {
        // The daemon already owns the transcript. Sending just the last user message
        // also prevents large persisted transcripts exceeding the adapter body limit.
        body: { id, messages: [newest], trigger, messageId: newest.id, sessionId: admissions.get(requestId), requestId }
      };
    },
    prepareReconnectToStreamRequest: () => {
      const sessionId = options.session();
      if (!sessionId) throw new Error("No accepted session to reconnect to.");
      const params = new URLSearchParams({ sessionId });
      const run = options.run();
      if (run) params.set("runId", run.runId);
      return { api: `/api/chat?${params}` };
    }
  });
}
