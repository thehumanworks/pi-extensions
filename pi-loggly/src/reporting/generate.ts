import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HealthRules } from "../analysis/health.ts";
import type { LogglyClient } from "../sdk/client.ts";
import { analyzePeriod, type ReportModel } from "./analyze.ts";
import { collectPeriod, planReport, type ReportClient, type ReportPlan } from "./collect.ts";
import { browserPrinter, type PdfPrinter } from "./pdf.ts";
import { renderHtml, renderMarkdown, summarize } from "./render.ts";
import { parseTimeframe, type Timeframe } from "./timeframe.ts";

export function defaultReportsDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-loggly", "reports");
}

export type GenerateClient = ReportClient & Pick<LogglyClient, "subdomain" | "searchUrl" | "account">;

export interface GenerateOptions {
  client: GenerateClient;
  rules: HealthRules;
  /** The timeframe in words; empty means the default. Or one already parsed. */
  timeframe: string | Timeframe;
  /** Reports are written to a new directory inside this one. */
  dir: string;
  now?: number;
  /** Days Loggly keeps; asked from Loggly when not given. */
  retentionDays?: number;
  /** Prints the PDF; null skips it. Default: a headless Chromium-family browser. */
  printPdf?: PdfPrinter | null;
  signal?: AbortSignal;
  /** Called once the timeframe is planned, before any search. */
  onPlan?: (plan: ReportPlan, requests: number) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface GeneratedReport {
  model: ReportModel;
  dir: string;
  html: string;
  markdown: string;
  pdf?: string;
  /** Why there is no PDF. */
  pdfError?: string;
}

/** Plan, fetch, analyse and write a report: report.html, report.md and report.pdf in a new private directory. */
export async function generateReport(options: GenerateOptions): Promise<GeneratedReport> {
  const now = options.now ?? Date.now();
  const { client, rules, signal } = options;
  const timeframe = typeof options.timeframe === "string" ? parseTimeframe(options.timeframe, new Date(now)) : options.timeframe;
  const retentionDays = options.retentionDays ?? (await client.account({ signal })).retentionDays;
  const plan = planReport(timeframe, rules, now, retentionDays);
  options.onPlan?.(plan, plannedRequests(plan, rules));
  const data = await collectPeriod(client, rules, plan, { signal, onProgress: options.onProgress });
  const model = analyzePeriod(data, rules, { subdomain: client.subdomain, generatedAt: now, searchUrl: (params) => client.searchUrl(params) });
  return writeReport(model, options.dir, { printPdf: options.printPdf === undefined ? browserPrinter() : options.printPdf, signal });
}

/** Facets for every period and the comparison, plus one sample per period. */
export function plannedRequests(plan: ReportPlan, rules: HealthRules): number {
  const messages = rules.messageFields[0] ? 1 : 0;
  return plan.buckets.length * 3 + messages + (plan.previous ? 2 + messages : 0);
}

export async function writeReport(model: ReportModel, root: string, options: { printPdf?: PdfPrinter | null; signal?: AbortSignal } = {}): Promise<GeneratedReport> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`Refusing to write reports to ${root}: it must be a directory owned by you with mode 700`);
  }
  const dir = await newDirectory(root, `${stamp(model.generatedAt)}-${slug(model.label)}`);
  const html = join(dir, "report.html");
  const markdown = join(dir, "report.md");
  const pdf = join(dir, "report.pdf");
  await writeFile(markdown, renderMarkdown(model), { mode: 0o600, flag: "wx" });
  let pdfError: string | undefined;
  if (options.printPdf) {
    await writeFile(html, renderHtml(model, { exports: { markdown: "report.md", pdf: "report.pdf" } }), { mode: 0o600, flag: "wx" });
    try {
      await options.printPdf(html, pdf, options.signal);
      return { model, dir, html, markdown, pdf };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      pdfError = error instanceof Error ? error.message : String(error);
      await rm(pdf, { force: true });
      await rm(html, { force: true });
    }
  }
  // Without a PDF, the HTML links only to the Markdown.
  await writeFile(html, renderHtml(model, { exports: { markdown: "report.md" } }), { mode: 0o600, flag: "wx" });
  return { model, dir, html, markdown, pdfError: pdfError ?? "PDF export is off" };
}

/** One notification line: the verdict and how many findings need attention. */
export function describeReport(report: GeneratedReport): string {
  const { verdict, title } = summarize(report.model);
  const urgent = report.model.findings.filter((f) => f.severity === "critical" || f.severity === "warning").length;
  const findings = verdict === "calm" ? "" : `: ${urgent} finding${urgent === 1 ? "" : "s"}`;
  const files = [`HTML: ${report.html}`, report.pdf ? `PDF: ${report.pdf}` : `PDF not created: ${report.pdfError}. Open the HTML and print it instead.`, `Markdown: ${report.markdown}`];
  return `Loggly report ready (${report.model.label}). ${title}${findings}.\n${files.join("\n")}`;
}

async function newDirectory(root: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = join(root, n === 1 ? name : `${name}-${n}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw error;
    }
  }
}

/** Local "2026-10-30-1125". */
function stamp(at: number): string {
  const d = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report"
  );
}
