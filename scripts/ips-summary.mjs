#!/usr/bin/env node
/**
 * The crashing frame of a macOS crash report, printed where an agent can read
 * it (STC-568).
 *
 * CI's "Collect crash reports" step copies every `Electron-*.ips` and
 * `stc-helper-*.ips` into the `failure-logs` artifact. That artifact downloads
 * from a blob-storage host the agent sessions' network policy refuses, so the
 * frame that would say which crash this was went unread on two tickets in a
 * row. The job log IS readable, so the step also runs this:
 *
 *   node scripts/ips-summary.mjs crash-reports/*.ips
 *
 * For each report: the process, its time, the exception (type, signal,
 * subtype), any application-specific message, and the faulting thread's top
 * frames as `image symbol+offset` (or `image +imageOffset` when the report is
 * unsymbolicated, which Electron Framework's frames usually are). The full
 * report stays in the artifact for anyone who can download it.
 *
 * Never exits non-zero for a report it cannot parse: the step runs on a run
 * that has already failed, and a summariser that throws would hide the very
 * lines it exists to print. An unparseable file gets its first lines instead.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Enough to get past AppKit/Chromium dispatch frames to the caller. */
export const DEFAULT_FRAMES = 25;
/** What an unparseable report gets, so it still says something. */
const FALLBACK_LINES = 40;

/**
 * Split an `.ips` file into its one-line JSON header and its JSON body. A
 * report with only one JSON object (some `bug_type`s) has no body.
 */
function parseIps(text) {
  const nl = text.indexOf("\n");
  const header = JSON.parse(nl < 0 ? text : text.slice(0, nl));
  const rest = nl < 0 ? "" : text.slice(nl + 1).trim();
  return { header, body: rest ? JSON.parse(rest) : undefined };
}

function frameLine(frame, images) {
  const image = images[frame.imageIndex]?.name ?? `image#${frame.imageIndex ?? "?"}`;
  if (frame.symbol) return `${image} ${frame.symbol}+${frame.symbolLocation ?? 0}`;
  return `${image} +${frame.imageOffset ?? "?"}`;
}

/**
 * The summary for one report, as lines. Pure, so it is tested on a synthetic
 * report rather than on a real crash.
 */
export function summarizeIps(text, name = "report", frames = DEFAULT_FRAMES) {
  let parsed;
  try {
    parsed = parseIps(text);
  } catch {
    const head = text.split("\n").slice(0, FALLBACK_LINES);
    return [`== ${name}: not an .ips JSON report; its first ${head.length} lines:`, ...head.map((l) => `  ${l}`)];
  }
  const { header, body } = parsed;
  const out = [`== ${name}: ${body?.procName ?? header.app_name ?? "?"} pid ${body?.pid ?? "?"} at ${body?.captureTime ?? header.timestamp ?? "?"}`];
  if (!body) return [...out, "  (header only, no crash body)"];

  const ex = body.exception ?? {};
  out.push(`  exception: ${[ex.type, ex.signal, ex.subtype].filter(Boolean).join(" ") || "(none recorded)"}`);
  if (body.termination?.indicator) out.push(`  termination: ${body.termination.indicator}`);
  for (const message of asiMessages(body.asi)) out.push(`  asi: ${message}`);

  const images = body.usedImages ?? [];
  const threads = body.threads ?? [];
  const index = typeof body.faultingThread === "number" ? body.faultingThread : threads.findIndex((t) => t.triggered);
  const thread = threads[index];
  if (!thread) return [...out, "  (no faulting thread in the report)"];
  const label = [thread.name, thread.queue].filter(Boolean).join(" / ");
  out.push(`  faulting thread ${index}${label ? ` (${label})` : ""}, top ${Math.min(frames, thread.frames?.length ?? 0)} of ${thread.frames?.length ?? 0} frames:`);
  (thread.frames ?? []).slice(0, frames).forEach((f, i) => out.push(`    ${String(i).padStart(2)} ${frameLine(f, images)}`));

  // An uncaught NSException's own backtrace — where it was thrown, which the
  // faulting thread (inside abort()) does not show.
  const last = body.lastExceptionBacktrace;
  if (Array.isArray(last) && last.length) {
    out.push(`  last exception backtrace, top ${Math.min(frames, last.length)} of ${last.length}:`);
    last.slice(0, frames).forEach((f, i) => out.push(`    ${String(i).padStart(2)} ${frameLine(f, images)}`));
  }
  return out;
}

/** `asi` is `{ "<image>": ["message", …] }`. */
function asiMessages(asi) {
  if (!asi || typeof asi !== "object") return [];
  return Object.entries(asi).flatMap(([image, messages]) =>
    (Array.isArray(messages) ? messages : [messages]).map((m) => `${image}: ${m}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  if (!files.length) console.log("ips-summary: no crash reports to summarise");
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch (e) {
      console.log(`== ${basename(file)}: could not read (${e.message})`);
      continue;
    }
    console.log(summarizeIps(text, basename(file)).join("\n"));
  }
}
