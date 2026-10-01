/**
 * STC-419 — the helper records keyboard COMMANDS when a take asks for them
 * (`keys: true`), and never typing.
 *
 * The key events are INJECTED (`STC_KEY_INJECT`, Capture.swift's
 * `startKeyInjection`): real CGEvents, built in the helper and fed through
 * the same `handleTapEvent` a tap delivery reaches, on the take's own clock.
 * Building a CGEvent needs no permission; POSTING one would, and would type
 * into whatever the machine has focused. So this proves everything except the
 * tap actually delivering keyDown — that is docs/STC-419-RUNBOOK.md's job.
 *
 * It is a grant test because a take only starts with Screen Recording (and,
 * since STC-315, Input Monitoring for the tap). `npm run test:capture`, never
 * CI.
 *
 * The CONTROL is load-bearing: the same injection with `keys` absent must
 * leave an events-2 with no key in it, or "Keys off records nothing" is
 * untested.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import Ajv from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

interface Line { ev: string; seq?: number; [k: string]: unknown }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

function spawnHelper(env: Record<string, string> = {}) {
  const proc = spawn(BIN, ["--stats-interval-ms", "200"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return { proc, out, fd3, send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);

function unmadeTakeDir(): string {
  return join(mkdtempSync(join(tmpdir(), "stc-keys-take-")), "take");
}

// CGEventFlags bits.
const CMD = 1 << 20, SHIFT = 1 << 17, OPT = 1 << 19;
const validate3 = new ((Ajv as any).default ?? Ajv)({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/events-3.schema.json"), "utf8")));

function injectFile(events: object[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "stc-keys-")), "inject.json");
  writeFileSync(p, JSON.stringify(events));
  return p;
}

async function take(env: Record<string, string>, start: object,
                    during?: (h: ReturnType<typeof spawnHelper>) => Promise<void>) {
  const dir = unmadeTakeDir();
  const h = spawnHelper(env);
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, ...start });
  const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (r.ev === "error") throw explainFailedStart(r as StartOutcome, "STC-419 key capture");
  if (during) await during(h); else await sleep(1500);
  h.send({ cmd: "stop", seq: 9 });
  await waitFor(() => h.fd3.find((l) => l.seq === 9), 30_000, "stop");
  return JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
}
const keysOf = (doc: any) => doc.events.filter((e: any) => e.kind === "key").map((e: any) => [e.key, e.mods]);

describe("key capture (STC-419)", () => {
  const SCRIPT = [
    { afterMs: 300, keyCode: 125, flags: 0 },                       // ↓
    { afterMs: 350, keyCode: 125, flags: 0 },                       // ↓
    { afterMs: 400, keyCode: 125, flags: 0, autorepeat: true },     // held ↓ — dropped
    { afterMs: 450, keyCode: 125, flags: 0 },                       // ↓
    { afterMs: 600, keyCode: 40, flags: CMD },                      // ⌘K
    { afterMs: 700, keyCode: 0, flags: 0 },                         // a — typing
    { afterMs: 750, keyCode: 0, flags: SHIFT },                     // A — typing
    { afterMs: 800, keyCode: 14, flags: OPT },                      // ⌥e — typing
    { afterMs: 850, keyCode: 49, flags: 0 },                        // space — typing
    { afterMs: 900, keyCode: 48, flags: SHIFT },                    // ⇧Tab
  ];

  test("keys: true records commands only, as a valid events-3", async () => {
    const doc = await take({ STC_KEY_INJECT: injectFile(SCRIPT) }, { keys: true });
    expect(validate3(doc), JSON.stringify(validate3.errors, null, 2)).toBe(true);
    expect(doc.version).toBe(3);
    // "K" assumes a US/ABC layout on the test machine (the keycap of kVK_ANSI_K).
    expect(keysOf(doc)).toEqual([
      ["ArrowDown", []], ["ArrowDown", []], ["ArrowDown", []], ["K", ["cmd"]], ["Tab", ["shift"]],
    ]);
  }, 60_000);

  test("CONTROL: keys absent writes events-2 with no key events, injection or not", async () => {
    const doc = await take({ STC_KEY_INJECT: injectFile(SCRIPT) }, {});
    expect(doc.version).toBe(2);
    expect(keysOf(doc)).toEqual([]);
  }, 60_000);

  test("a key pressed while paused is not recorded", async () => {
    const doc = await take(
      { STC_KEY_INJECT: injectFile([
        { afterMs: 300, keyCode: 125, flags: 0 },   // ↓ — recorded
        { afterMs: 900, keyCode: 126, flags: 0 },   // ↑ — paused, dropped
        { afterMs: 1500, keyCode: 123, flags: 0 },  // ← — recorded
      ]) },
      { keys: true },
      async (h) => {
        await sleep(600); h.send({ cmd: "pause", seq: 2 });
        await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "pause");
        await sleep(600); h.send({ cmd: "resume", seq: 3 });
        await waitFor(() => h.fd3.find((l) => l.seq === 3), 10_000, "resume");
        await sleep(900);
      },
    );
    expect(keysOf(doc)).toEqual([["ArrowDown", []], ["ArrowLeft", []]]);
  }, 60_000);
});
