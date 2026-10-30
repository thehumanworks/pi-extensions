import { formatClock, formatCount, formatPercent, sparkline } from "../analysis/format.ts";
import { formatDay, formatSpan, formatTime, per, previousPeriod, spansDays, type Finding, type FindingSeverity, type ReportModel, type SystemRow } from "./analyze.ts";

const SYSTEM_ROWS = 25;
const COLORS = ["#4269d0", "#efb118", "#ff725c", "#6cc5b0", "#a463f2"];
const OTHER_COLOR = "#b4b8bf";
const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: "Critical", warning: "Warning", notice: "Notice", info: "Change" };

export type Verdict = "attention" | "look" | "calm";

export interface Summary {
  verdict: Verdict;
  title: string;
  sentences: string[];
}

/** The report's opening: a verdict and a few sentences on what happened. */
export function summarize(model: ReportModel): Summary {
  const { totals } = model;
  const count = (severity: FindingSeverity) => model.findings.filter((f) => f.severity === severity).length;
  const critical = count("critical");
  const warnings = count("warning");
  const verdict: Verdict = critical ? "attention" : warnings ? "look" : "calm";
  const sentences = [
    `${formatCount(totals.events)} events and ${formatCount(totals.errors)} errors (${formatPercent(totals.errorRate)} of events) from ${systemsText(model)}.`,
  ];
  if (totals.previous) {
    sentences.push(`Compared with ${comparedWith(model)}, errors are ${change(totals.errors, totals.previous.errors)} and events ${change(totals.events, totals.previous.events)}.`);
  }
  if (model.peak && model.peak.errors >= 2 * Math.max(model.peak.usual, 1) && model.timeline.length > 2) {
    sentences.push(`Errors peaked at ${time(model, model.peak.from)} with ${formatCount(model.peak.errors)} in ${formatSpan(model.bucketMs)}, against a usual ${formatCount(model.peak.usual)}.`);
  }
  const top = model.systems[0];
  if (top && totals.errors && top.errors / totals.errors >= 0.3) sentences.push(`${top.name} logged ${formatPercent(top.errors / totals.errors)} of all errors.`);
  const notable = [critical && `${critical} critical`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean);
  sentences.push(notable.length ? `Findings below: ${notable.join(" and ")}, most pressing first.` : "Nothing needs attention; changes and ongoing issues are listed below.");
  return { verdict, title: verdict === "attention" ? "Needs attention" : verdict === "look" ? "Worth a look" : "Nothing unusual", sentences };
}

export interface RenderOptions {
  /** Names of sibling exports to link from the HTML, such as report.md and report.pdf. */
  exports?: { markdown?: string; pdf?: string };
}

export function renderMarkdown(model: ReportModel): string {
  const summary = summarize(model);
  const lines: string[] = [];
  const push = (...items: string[]) => lines.push(...items);
  push(`# Loggly report: ${md(capitalize(model.label))}`, "");
  push(`**${md(model.subdomain)}** · ${md(formatRange(model.from, model.until))} (${md(model.timeZone)})${model.previous ? ` · compared with ${comparedWith(model)}` : ""}  `);
  push(`Generated ${md(formatStamp(model.generatedAt))}.`, "");
  push(`## ${summary.title}`, "", summary.sentences.map(md).join(" "), "");
  const prev = model.totals.previous;
  push("| Events | Errors | Error rate | Systems |", "|---|---|---|---|");
  push(
    `| ${formatCount(model.totals.events)}${prev ? ` (${change(model.totals.events, prev.events)})` : ""} | ${formatCount(model.totals.errors)}${prev ? ` (${change(model.totals.errors, prev.errors)})` : ""} | ${formatPercent(model.totals.errorRate)}${prev ? ` (was ${formatPercent(prev.errorRate)})` : ""} | ${systemsText(model)} |`,
    "",
  );

  push("## Findings", "");
  if (!model.findings.length) push("No unusual changes found.", "");
  for (const finding of model.findings) push(`- **${SEVERITY_LABEL[finding.severity]}** · ${link(md(finding.title), finding.url)}: ${md(finding.detail)}`);
  if (model.findings.length) push("");

  push("## Over time", "");
  const errors = model.timeline.map((p) => p.errors);
  const events = model.timeline.map((p) => p.events);
  const first = model.timeline[0];
  push(`${formatSpan(model.bucketMs)} per mark, from ${md(time(model, model.from))} to ${md(time(model, model.until))}.`, "");
  push("```text", `errors  ${sparkline(errors)}  max ${formatCount(Math.max(0, ...errors))}`, `events  ${sparkline(events)}  max ${formatCount(Math.max(0, ...events))}`, "```", "");
  if (first && model.topSystems.length) {
    push(`| ${model.timeline.length > 1 ? "Systems with most errors" : "System"} | Errors | Trend |`, "|---|---:|---|");
    model.topSystems.forEach((name, i) => push(`| ${md(name)} | ${formatCount(sum(model.timeline.map((p) => p.bySystem[i]!)))} | \`${sparkline(model.timeline.map((p) => p.bySystem[i]!))}\` |`));
    push("");
  }

  push("## Systems", "");
  const listed = systemsToShow(model);
  if (!listed.length) push("No system logged errors.", "");
  else {
    push(`| System | Errors | ${model.previous ? "vs previous | " : ""}Events | Error rate | Trend | Notes |`, `|---|---:|${model.previous ? "---:|" : ""}---:|---:|---|---|`);
    for (const s of listed) {
      push(`| ${link(md(s.name), s.url)} | ${formatCount(s.errors)} | ${model.previous ? `${systemChange(s)} | ` : ""}${s.events === undefined ? "–" : formatCount(s.events)} | ${s.errorRate === undefined ? "–" : formatPercent(s.errorRate)} | \`${sparkline(s.errorSeries)}\` | ${md(s.flags.join(", "))} |`);
    }
    push("");
    const more = model.systems.filter((s) => s.errors > 0).length - listed.length;
    if (more > 0) push(`${more} more system${more === 1 ? "" : "s"} logged errors.`, "");
  }

  if (model.messages) {
    push("## Error messages", "");
    push(md(messagesIntro(model)), "");
    if (model.messages.rows.length) {
      push(`| Message | Errors | Share | Main systems |${model.previous ? " New |" : ""}`, `|---|---:|---:|---|${model.previous ? "---|" : ""}`);
      for (const row of model.messages.rows) {
        push(`| ${code(row.template)} | ${formatCount(row.count)} | ${formatPercent(row.share)} | ${md(shares(row.systems))} |${model.previous ? ` ${row.isNew ? "new" : ""} |` : ""}`);
      }
      push("");
    }
  }

  push("## Error patterns (estimated)", "");
  push(md(patternsIntro(model)), "");
  if (model.patterns.rows.length) {
    push("| Pattern | ≈ Errors | Share | Main systems | Seen |", "|---|---:|---:|---|---|");
    for (const row of model.patterns.rows) {
      push(`| ${code(row.template)} | ${formatCount(row.estimate)} | ${formatPercent(row.share)} | ${md(shares(row.systems))} | ${md(seen(model, row.firstSeen, row.lastSeen))} |`);
    }
    push("");
  }

  push("## How this report was made", "");
  for (const note of method(model)) push(`- ${md(note)}`);
  push("", `[Errors in Loggly](${url(model.urls.errors)}) · [All events in Loggly](${url(model.urls.events)})`, "");
  return lines.join("\n");
}

export function renderHtml(model: ReportModel, options: RenderOptions = {}): string {
  const summary = summarize(model);
  const prev = model.totals.previous;
  const exports = [options.exports?.markdown && `<a href="${esc(options.exports.markdown)}">Markdown</a>`, options.exports?.pdf && `<a href="${esc(options.exports.pdf)}">PDF</a>`].filter(Boolean);
  const card = (label: string, value: string, note?: string) => `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
  const listed = systemsToShow(model);
  const more = model.systems.filter((s) => s.errors > 0).length - listed.length;
  const body = [
    `<header>`,
    `<p class="eyebrow">Loggly report · ${esc(model.subdomain)}</p>`,
    `<h1>${esc(capitalize(model.label))}</h1>`,
    `<p class="period">${esc(formatRange(model.from, model.until))} <span class="muted">(${esc(model.timeZone)})</span>${model.previous ? ` · compared with ${esc(comparedWith(model))}` : ""}</p>`,
    `<p class="muted small">Generated ${esc(formatStamp(model.generatedAt))}${exports.length ? `<span class="screen"> · Also saved as ${exports.join(" and ")}</span>` : ""}</p>`,
    `</header>`,
    `<section class="verdict ${summary.verdict}"><h2>${esc(summary.title)}</h2><p>${esc(summary.sentences.join(" "))}</p></section>`,
    `<section class="cards">`,
    card("Events", formatCount(model.totals.events), prev ? `${change(model.totals.events, prev.events)} vs previous` : undefined),
    card("Errors", formatCount(model.totals.errors), prev ? `${change(model.totals.errors, prev.errors)} vs previous` : undefined),
    card("Error rate", formatPercent(model.totals.errorRate), prev ? `was ${formatPercent(prev.errorRate)}` : undefined),
    card("Systems", `${model.totals.systems}${model.truncated ? "+" : ""}`, `${model.totals.erroringSystems}${model.truncated ? "+" : ""} with errors`),
    `</section>`,
    `<section><h2>Findings</h2>${findingsHtml(model.findings)}</section>`,
    `<section class="keep"><h2>Errors over time</h2>${errorsChart(model)}${legend(model)}</section>`,
    `<section class="keep"><h2>Events over time</h2>${eventsChart(model)}</section>`,
    `<section><h2>Systems</h2>${listed.length ? systemsTable(model, listed) : `<p class="muted">No system logged errors.</p>`}${more > 0 ? `<p class="muted small">${more} more system${more === 1 ? "" : "s"} logged errors.</p>` : ""}</section>`,
    model.messages ? `<section><h2>Error messages</h2><p class="muted">${esc(messagesIntro(model))}</p>${model.messages.rows.length ? messagesTable(model) : ""}</section>` : "",
    `<section><h2>Error patterns <span class="muted">(estimated)</span></h2><p class="muted">${esc(patternsIntro(model))}</p>${model.patterns.rows.length ? patternsTable(model) : ""}</section>`,
    `<section><h2>How this report was made</h2><ul class="method">${method(model)
      .map((note) => `<li>${esc(note)}</li>`)
      .join("")}</ul><p><a href="${esc(model.urls.errors)}">Errors in Loggly</a> · <a href="${esc(model.urls.events)}">All events in Loggly</a></p></section>`,
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Loggly report: ${capitalize(model.label)} · ${model.subdomain}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body.filter(Boolean).join("\n")}
</main>
</body>
</html>
`;
}

function findingsHtml(findings: readonly Finding[]): string {
  if (!findings.length) return `<p class="muted">No unusual changes found.</p>`;
  return `<ul class="findings">${findings
    .map(
      (f) =>
        `<li class="finding ${f.severity}"><span class="badge">${SEVERITY_LABEL[f.severity]}</span><div><div class="title">${f.url ? `<a href="${esc(f.url)}">${breakable(f.title)}</a>` : breakable(f.title)}</div><div class="detail">${esc(f.detail)}</div></div></li>`,
    )
    .join("")}</ul>`;
}

function systemsTable(model: ReportModel, rows: readonly SystemRow[]): string {
  const head = `<tr><th>System</th><th class="num">Errors</th>${model.previous ? `<th class="num">vs previous</th>` : ""}<th class="num">Events</th><th class="num">Error rate</th><th>Trend</th><th>Notes</th></tr>`;
  const body = rows
    .map(
      (s) =>
        `<tr><td class="name"><a href="${esc(s.url)}">${breakable(s.name)}</a></td><td class="num" title="${s.errors.toLocaleString("en-GB")}">${formatCount(s.errors)}</td>${model.previous ? `<td class="num">${esc(systemChange(s))}</td>` : ""}<td class="num">${s.events === undefined ? "–" : formatCount(s.events)}</td><td class="num">${s.errorRate === undefined ? "–" : formatPercent(s.errorRate)}</td><td>${spark(s.errorSeries)}</td><td>${s.flags.map((flag) => `<span class="tag">${esc(flag)}</span>`).join(" ")}</td></tr>`,
    )
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function messagesTable(model: ReportModel): string {
  const rows = model.messages!.rows.map(
    (row) =>
      `<tr><td>${messageCell(row.template, row.example)}</td><td class="num">${formatCount(row.count)}</td><td class="num">${shareBar(row.share)}</td><td class="small">${esc(shares(row.systems))}</td>${model.previous ? `<td>${row.isNew ? `<span class="tag new">new</span>` : ""}</td>` : ""}</tr>`,
  );
  return `<table><thead><tr><th>Message</th><th class="num">Errors</th><th class="num">Share</th><th>Main systems</th>${model.previous ? "<th></th>" : ""}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function patternsTable(model: ReportModel): string {
  const rows = model.patterns.rows.map(
    (row) =>
      `<tr><td>${messageCell(row.template, row.example)}</td><td class="num">≈${formatCount(row.estimate)}</td><td class="num">${shareBar(row.share)}</td><td class="small">${esc(shares(row.systems))}</td><td class="small nowrap">${esc(seen(model, row.firstSeen, row.lastSeen))}</td></tr>`,
  );
  return `<table><thead><tr><th>Pattern</th><th class="num">Errors</th><th class="num">Share</th><th>Main systems</th><th>Seen</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function messageCell(template: string, example: string): string {
  const sameAsTemplate = example === template || example.length < 2;
  return `<code>${esc(template)}</code>${sameAsTemplate ? "" : `<div class="example">e.g. ${esc(example)}</div>`}`;
}

function shareBar(share: number): string {
  return `<span class="share"><span style="width:${Math.min(100, Math.max(1, Math.round(share * 100)))}%"></span></span>${esc(formatPercent(share))}`;
}

/** Stacked error bars per period, by the systems with most errors, with the previous period's average. */
function errorsChart(model: ReportModel): string {
  const { timeline } = model;
  if (!timeline.length) return `<p class="muted">No data.</p>`;
  const frame = chartFrame(model, 260);
  const previousAverage = model.totals.previous ? model.totals.previous.errors / timeline.length : undefined;
  const max = niceMax(Math.max(...timeline.map((p) => p.errors), previousAverage ?? 0));
  const y = (value: number) => frame.top + frame.height - (value / max) * frame.height;
  const parts: string[] = [axis(frame, max, y), timeAxis(model, frame)];
  timeline.forEach((point, i) => {
    let base = 0;
    const x = frame.x(i) + frame.band * 0.11;
    const width = frame.band * 0.78;
    const segments = [...point.bySystem.map((count, s) => ({ count, color: COLORS[s]!, name: model.topSystems[s]! })), { count: point.other, color: OTHER_COLOR, name: "other systems" }];
    const tip = `${formatTime(point.from, model.bucketMs, spansDays(model))}: ${point.errors.toLocaleString("en-GB")} errors${segments
      .filter((s) => s.count)
      .map((s) => `\n${s.name}: ${s.count.toLocaleString("en-GB")}`)
      .join("")}`;
    parts.push(`<g><title>${esc(tip)}</title>`);
    for (const segment of segments) {
      if (!segment.count) continue;
      const top = y(base + segment.count);
      parts.push(`<rect x="${n(x)}" y="${n(top)}" width="${n(width)}" height="${n(y(base) - top)}" fill="${segment.color}"/>`);
      base += segment.count;
    }
    parts.push(`</g>`);
  });
  if (previousAverage !== undefined) {
    const py = y(previousAverage);
    parts.push(`<line x1="${frame.left}" x2="${frame.left + frame.width}" y1="${n(py)}" y2="${n(py)}" class="previous"/><text x="${frame.left + frame.width}" y="${n(py - 4)}" class="axis" text-anchor="end">previous average</text>`);
  }
  if (model.peak && timeline.length > 2) {
    const i = timeline.findIndex((p) => p.from === model.peak!.from);
    parts.push(`<text x="${n(frame.x(i) + frame.band / 2)}" y="${n(y(model.peak.errors) - 5)}" class="peak" text-anchor="middle">peak</text>`);
  }
  return svg(frame, parts, `Errors ${per(model.bucketMs)}`);
}

function eventsChart(model: ReportModel): string {
  const { timeline } = model;
  if (!timeline.length) return `<p class="muted">No data.</p>`;
  const frame = chartFrame(model, 150);
  const max = niceMax(Math.max(...timeline.map((p) => p.events)));
  const y = (value: number) => frame.top + frame.height - (value / max) * frame.height;
  const points = timeline.map((p, i) => `${n(frame.x(i) + frame.band / 2)},${n(y(p.events))}`);
  const first = frame.x(0) + frame.band / 2;
  const last = frame.x(timeline.length - 1) + frame.band / 2;
  const base = frame.top + frame.height;
  const tips = timeline
    .map((p, i) => `<rect x="${n(frame.x(i))}" y="${frame.top}" width="${n(frame.band)}" height="${frame.height}" fill="transparent"><title>${esc(`${formatTime(p.from, model.bucketMs, spansDays(model))}: ${p.events.toLocaleString("en-GB")} events`)}</title></rect>`)
    .join("");
  const parts = [axis(frame, max, y), timeAxis(model, frame), `<path d="M${n(first)},${base} L${points.join(" L")} L${n(last)},${base} Z" class="area"/>`, `<polyline points="${points.join(" ")}" class="line"/>`, tips];
  return svg(frame, parts, `Events ${per(model.bucketMs)}`);
}

interface Frame {
  width: number;
  height: number;
  left: number;
  top: number;
  outerWidth: number;
  outerHeight: number;
  band: number;
  x: (i: number) => number;
}

function chartFrame(model: ReportModel, outerHeight: number): Frame {
  const outerWidth = 960;
  const left = 56;
  const top = 18;
  const width = outerWidth - left - 12;
  const height = outerHeight - top - (spansDays(model) && model.bucketMs < 86_400_000 ? 40 : 26);
  const band = width / Math.max(1, model.timeline.length);
  return { width, height, left, top, outerWidth, outerHeight, band, x: (i) => left + i * band };
}

function axis(frame: Frame, max: number, y: (value: number) => number): string {
  return [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const value = max * f;
      return `<line x1="${frame.left}" x2="${frame.left + frame.width}" y1="${n(y(value))}" y2="${n(y(value))}" class="grid"/><text x="${frame.left - 6}" y="${n(y(value) + 4)}" class="axis" text-anchor="end">${formatCount(value)}</text>`;
    })
    .join("");
}

/** About eight time labels, with the date under the first label of each day when the report spans days. */
function timeAxis(model: ReportModel, frame: Frame): string {
  const step = Math.max(1, Math.ceil(model.timeline.length / 8));
  const multiDay = spansDays(model) && model.bucketMs < 86_400_000;
  const labels: string[] = [];
  let lastDay = "";
  model.timeline.forEach((point, i) => {
    if (i % step) return;
    const x = n(frame.x(i) + frame.band / 2);
    const base = frame.top + frame.height + 15;
    const day = formatDay(point.from);
    const main = model.bucketMs >= 86_400_000 ? day.replace(/ \w+$/, "") : formatClock(point.from);
    labels.push(`<text x="${x}" y="${base}" class="axis" text-anchor="middle">${esc(main)}</text>`);
    if (multiDay && day !== lastDay) labels.push(`<text x="${x}" y="${base + 14}" class="axis day" text-anchor="middle">${esc(day)}</text>`);
    lastDay = day;
  });
  return labels.join("");
}

function legend(model: ReportModel): string {
  if (!model.topSystems.length) return "";
  const items = [...model.topSystems.map((name, i) => ({ name, color: COLORS[i]! })), { name: "other systems", color: OTHER_COLOR }];
  return `<div class="legend">${items.map((item) => `<span><i style="background:${item.color}"></i>${esc(item.name)}</span>`).join("")}</div>`;
}

function svg(frame: Frame, parts: string[], label: string): string {
  return `<svg viewBox="0 0 ${frame.outerWidth} ${frame.outerHeight}" role="img" aria-label="${esc(label)}" class="chart"><text x="${frame.left}" y="11" class="axis">${esc(label)}</text>${parts.join("")}</svg>`;
}

function spark(values: readonly number[]): string {
  const width = 110;
  const height = 22;
  const max = Math.max(1, ...values);
  if (values.length < 2) return "";
  const points = values.map((v, i) => `${n((i / (values.length - 1)) * width)},${n(height - 1 - (v / max) * (height - 2))}`);
  return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true"><polyline points="${points.join(" ")}"/></svg>`;
}

/** A chart maximum whose quarters are round numbers: 4, 8, 12, 20, 60k. */
function niceMax(value: number): number {
  if (value <= 0) return 4;
  const step = value / 4;
  const exponent = 10 ** Math.floor(Math.log10(step));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * exponent >= step && Number.isInteger(m * exponent * 4) && (m !== 2.5 || exponent >= 10)) ?? 10) * exponent * 4;
}

function method(model: ReportModel): string[] {
  const r = model.rules;
  return [
    `Systems are values of ${r.groupBy}${r.scope === "*" ? "" : ` within ${r.scope}`}. Errors are events matching ${r.errorQuery}.`,
    `Counts of events and errors are totals from Loggly, per ${formatSpan(model.bucketMs).replace(/^1 /, "")}, not estimates.`,
    model.previous
      ? `Changes compare with ${comparedWith(model)} (${formatRange(model.previous.from, model.previous.until)}). Growth needs ×${model.rules.spikeRatio} or more and at least ${model.rules.minErrors.toLocaleString("en-GB")} extra errors over the timeframe; a system counts as new only when it was absent from a complete list.`
      : "There is no comparison period, so changes over time are judged within the timeframe only.",
    "Error messages are Loggly's 300 most frequent exact values of the message field; patterns group them after counting. Error patterns are estimated from a sample of errors from every period, weighted by each period's errors.",
    ...model.notes,
  ];
}

function messagesIntro(model: ReportModel): string {
  const messages = model.messages!;
  const covered = model.totals.errors ? formatPercent(messages.covered / model.totals.errors) : "0%";
  return `Exact counts for the most frequent values of ${messages.field}, grouped by pattern. They cover ${covered} of errors; errors without ${messages.field}, and rarer messages, appear in the estimated patterns below.`;
}

function patternsIntro(model: ReportModel): string {
  const { sampled, rows } = model.patterns;
  if (!sampled) return "No errors to sample.";
  return `All errors, grouped by pattern, estimated from ${sampled.toLocaleString("en-GB")} errors sampled across the timeframe. Counts are approximate: a pattern seen once in the sample stands for about ${formatCount(model.totals.errors / sampled)} errors.${rows.length >= 25 ? " The 25 largest are shown." : ""}`;
}

function comparedWith(model: ReportModel): string {
  return model.previousLabel ?? previousPeriod(model.until - model.from);
}

function systemsToShow(model: ReportModel): SystemRow[] {
  return model.systems.filter((s) => s.errors > 0 || s.flags.length).slice(0, SYSTEM_ROWS);
}

function systemsText(model: ReportModel): string {
  const plus = model.truncated ? "+" : "";
  return `${model.totals.systems}${plus} systems, ${model.totals.erroringSystems}${plus} with errors`;
}

function systemChange(system: SystemRow): string {
  if (system.previousErrors === undefined) return "–";
  if (system.previousErrors === 0) return system.errors ? "new" : "–";
  const ratio = system.errors / system.previousErrors - 1;
  if (Math.abs(ratio) < 0.05) return "same";
  return `${ratio > 0 ? "+" : "−"}${formatPercent(Math.abs(ratio))}`;
}

/** "up 35%", "down 12%", "about the same". */
export function change(now: number, before: number): string {
  if (!before) return now ? "up from none" : "unchanged";
  const ratio = now / before - 1;
  if (Math.abs(ratio) < 0.1) return "about the same";
  return ratio > 0 ? `up ${formatPercent(ratio)}` : `down ${formatPercent(-ratio)}`;
}

function shares(systems: ReadonlyArray<{ name: string; share: number }>): string {
  return systems.map((s) => `${s.name} ${formatPercent(s.share)}`).join(", ");
}

function seen(model: ReportModel, first: number, last: number): string {
  const a = time(model, first);
  const b = time(model, last);
  return a === b ? a : `${a} – ${b}`;
}

function time(model: ReportModel, at: number): string {
  return formatTime(at, Math.min(model.bucketMs, 3_600_000), spansDays(model));
}

/** "Thu 30 Oct 2026, 09:25–11:25", "Wed 29 Oct 2026" for a whole day, or both ends in full. */
export function formatRange(from: number, until: number): string {
  const date = (t: number) => formatDay(t, true);
  const clock = formatClock;
  if (clock(from) === "00:00" && clock(until) === "00:00") {
    const last = date(until - 1);
    return date(from) === last ? last : `${date(from)} – ${last}`;
  }
  if (date(from) === date(until)) return `${date(from)}, ${clock(from)}–${clock(until)}`;
  return `${date(from)} ${clock(from)} – ${date(until)} ${clock(until)}`;
}

function formatStamp(at: number): string {
  return `${formatDay(at, true)} ${formatClock(at)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Escaped text that may wrap after path separators, so system names do not break mid-word. */
function breakable(text: string): string {
  return esc(text).replace(/([\\/])/g, "$1<wbr>");
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Markdown text with punctuation that would format escaped, safe in table cells. */
function md(text: string): string {
  return text.replace(/[\\`*_[\]<>|#~]/g, "\\$&").replace(/\r?\n/g, " ");
}

/** A code span that survives backticks and pipes in the text, for table cells. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const body = text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return longest ? `${fence} ${body} ${fence}` : `${fence}${body}${fence}`;
}

/** Parentheses in a link target end it early in some renderers. */
function url(target: string): string {
  return target.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
}

function link(text: string, target: string | undefined): string {
  return target ? `[${text}](${url(target)})` : text;
}

const CSS = `
:root { --fg: #1d2330; --muted: #5f6b7a; --line: #e3e6eb; --bg: #ffffff; --soft: #f5f7fa; --accent: #4269d0;
  --critical: #c62828; --warning: #b45f06; --notice: #1f5fae; --info: #2e7d32; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 28px 48px; }
h1 { font-size: 28px; margin: 2px 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 10px; }
section { margin-top: 28px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.eyebrow { margin: 0; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 12px; font-weight: 600; }
.period { margin: 0; }
.muted { color: var(--muted); font-weight: normal; }
.small { font-size: 12px; }
.nowrap { white-space: nowrap; }
.verdict { border-left: 4px solid var(--info); background: var(--soft); padding: 12px 16px; border-radius: 4px; }
.verdict.attention { border-color: var(--critical); }
.verdict.look { border-color: var(--warning); }
.verdict h2 { margin-bottom: 4px; }
.verdict p { margin: 0; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 24px; font-weight: 600; }
.card .note { color: var(--muted); font-size: 12px; }
.findings { list-style: none; margin: 0; padding: 0; }
.finding { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--line); break-inside: avoid; }
.finding .badge { flex: 0 0 64px; text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 3px; padding: 2px 0; color: #fff; margin-top: 2px; }
.finding.critical .badge { background: var(--critical); }
.finding.warning .badge { background: var(--warning); }
.finding.notice .badge { background: var(--notice); }
.finding.info .badge { background: var(--info); }
.finding .title { font-weight: 600; overflow-wrap: break-word; }
.finding .detail { color: var(--muted); }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .axis { fill: var(--muted); font-size: 11px; }
.chart .day { font-weight: 600; }
.chart .previous { stroke: var(--fg); stroke-dasharray: 5 4; stroke-width: 1.2; opacity: 0.6; }
.chart .peak { fill: var(--critical); font-size: 11px; font-weight: 600; }
.chart .area { fill: var(--accent); opacity: 0.15; }
.chart .line { fill: none; stroke: var(--accent); stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); padding: 6px 8px; }
td { border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
tr { break-inside: avoid; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.name { width: 34%; overflow-wrap: break-word; }
code { font: 12px/1.45 ui-monospace, "SF Mono", Consolas, "Liberation Mono", monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
.example { color: var(--muted); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
.tag { display: inline-block; font-size: 11px; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; color: var(--muted); }
.tag.new { border-color: var(--warning); color: var(--warning); }
.share { display: inline-block; width: 44px; height: 6px; background: var(--soft); border-radius: 3px; margin-right: 6px; vertical-align: 1px; overflow: hidden; }
.share span { display: block; height: 100%; background: var(--accent); }
.spark { width: 110px; height: 22px; }
.spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.method { padding-left: 18px; color: var(--muted); }
@media (max-width: 720px) { .cards { grid-template-columns: repeat(2, 1fr); } }
@page { size: A4; margin: 14mm 12mm; }
@media print {
  body { font-size: 12px; }
  main { max-width: none; padding: 0; }
  .screen { display: none; }
  section.keep { break-inside: avoid; }
  h2 { break-after: avoid; }
  a { color: var(--fg); }
}
`;
