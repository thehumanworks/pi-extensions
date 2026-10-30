import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Print an HTML file to a PDF file. */
export type PdfPrinter = (htmlPath: string, pdfPath: string, signal?: AbortSignal) => Promise<void>;

const BROWSERS = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "microsoft-edge-stable", "microsoft-edge", "brave-browser", "brave"];

/**
 * A Chromium-family browser for printing: PI_LOGGLY_BROWSER or CHROME_PATH
 * when set, otherwise the first one found on PATH.
 */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const configured of [env.PI_LOGGLY_BROWSER, env.CHROME_PATH]) {
    if (configured) return configured;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of BROWSERS) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return undefined;
}

export class PdfError extends Error {
  override name = "PdfError";
}

/** A printer that runs the browser headless with a throwaway profile. Throws PdfError when no browser is found. */
export function browserPrinter(options: { browser?: string; timeoutMs?: number } = {}): PdfPrinter {
  return async (htmlPath, pdfPath, signal) => {
    const browser = options.browser ?? findBrowser();
    if (!browser) throw new PdfError("no Chromium, Chrome, Edge or Brave found; set PI_LOGGLY_BROWSER to one");
    const profile = await mkdtemp(join(tmpdir(), "pi-loggly-browser-"));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          browser,
          [
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--no-pdf-header-footer",
            `--user-data-dir=${profile}`,
            `--print-to-pdf=${pdfPath}`,
            pathToFileURL(htmlPath).href,
          ],
          { timeout: options.timeoutMs ?? 60_000, signal, windowsHide: true },
          (error, _stdout, stderr) => {
            if (error) reject(new PdfError(`${browser} could not print the report: ${error.killed ? "timed out" : (String(stderr).trim().split("\n").at(-1) ?? error.message)}`));
            else resolve();
          },
        );
      });
      const handle = await open(pdfPath, "r").catch(() => undefined);
      if (!handle) throw new PdfError(`${browser} did not write a PDF`);
      const head = Buffer.alloc(5);
      await handle.read(head, 0, 5, 0);
      await handle.close();
      if (head.toString() !== "%PDF-") throw new PdfError(`${browser} wrote something that is not a PDF`);
      // Browsers create files with the default umask; reports hold log text.
      await chmod(pdfPath, 0o600);
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  };
}
