import "server-only";
import { connectBotBackend, createBotChatAdapter } from "@nothumanwork/bot-ai-sdk";

let cached: { url: string; token: string | undefined; adapter: ReturnType<typeof createBotChatAdapter> } | undefined;

export function getAdapter() {
  const url = process.env.BOT_SERVER_URL || "http://[::1]:8787";
  const token = process.env.BOT_SERVER_TOKEN || undefined;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid bot server configuration");
  }
  if (!cached || cached.url !== url || cached.token !== token) {
    cached = { url, token, adapter: createBotChatAdapter({ backend: connectBotBackend(url, { token }) }) };
  }
  return cached.adapter;
}
