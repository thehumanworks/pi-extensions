import { createWriteStream } from "node:fs";

/** Pi redirects incidental extension stdout to stderr. Emit intentional print-mode results
 * directly to the descriptor, with stream backpressure; never use this for JSON/RPC output. */
export async function printResult(text: string, error = false): Promise<void> {
  const stream = createWriteStream("", { fd: error ? 2 : 1, autoClose: false });
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(text + "\n", resolve);
  });
}
