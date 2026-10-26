import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise startup and subsequent persistence through the real CLI, without a model call. */
export default function checkStorage(pi: ExtensionAPI) {
  pi.registerCommand("check-storage", {
    description: "Record the active storage location for the integration test",
    handler: async (_args, ctx) => {
      const sessions = ctx.sessionManager;
      const result = { cwd: ctx.cwd, file: sessions.getSessionFile(), dir: sessions.getSessionDir(), id: sessions.getSessionId() };
      pi.appendEntry("storage-check", result);
      await writeFile(process.env.PI_BOT_TEST_REPORT!, JSON.stringify(result));
    },
  });
}
