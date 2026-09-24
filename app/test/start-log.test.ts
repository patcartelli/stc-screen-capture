import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStarts, waitForStart, waitForStarts } from "./_start-log.js";

/**
 * Reading the stand-in helper's start log has to wait for CONTENT (STC-434).
 *
 * The bug: four e2e files polled `existsSync(startLog)` and then immediately
 * `JSON.parse`d the first line. The helper appends with
 * `writeFileSync(path, line, { flag: "a" })` — open, write, close — so there
 * is a real window in which the file exists and is empty, and a read there
 * throws `Unexpected end of JSON input` rather than failing an assertion.
 *
 * The window is reproduced here with `openSync(path, "a")`: that is exactly
 * the syscall the helper's first step makes, and it leaves a zero-byte file
 * behind, which is the state CI caught.
 */
let dir: string;
let log: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stc-startlog-")); log = join(dir, "start.jsonl"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const append = (cmd: object) =>
  writeFileSync(log, JSON.stringify(cmd) + "\n", { flag: "a" });

describe("the start log is read once it has landed (STC-434)", () => {
  test("a file that EXISTS but is empty is not a start", () => {
    // THE regression, at its source. `existsSync` is already true here.
    closeSync(openSync(log, "a"));
    expect(readStarts(log)).toEqual([]);
  });

  test("a missing file is not a start either", () => {
    expect(readStarts(log)).toEqual([]);
  });

  test("waitForStart waits out the empty window rather than throwing", async () => {
    closeSync(openSync(log, "a"));                       // the zero-byte state
    setTimeout(() => append({ cmd: "start", camera: true }), 120);
    // The old code did `JSON.parse("")` here and died.
    expect(await waitForStart(log, 5_000)).toMatchObject({ cmd: "start", camera: true });
  });

  test("a half-written trailing line is not mistaken for a start", () => {
    append({ cmd: "start", camera: true });
    writeFileSync(log, '{"cmd":"sta', { flag: "a" });     // mid-write
    const starts = readStarts(log);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ camera: true });
  });

  test("waitForStarts waits for the Nth, not just the first", async () => {
    append({ cmd: "start", displayId: 1 });
    setTimeout(() => append({ cmd: "start", displayId: 2 }), 100);
    const starts = await waitForStarts(log, 2, 5_000);
    expect(starts).toHaveLength(2);
    // `.at(-1)` is what the scope-picker callers take.
    expect(starts.at(-1)).toMatchObject({ displayId: 2 });
  });

  test("a start that never lands fails with what was actually in the file", async () => {
    // "never appeared" and "appeared malformed" want different fixes, so the
    // message carries the bytes rather than only a duration.
    writeFileSync(log, "not json at all\n");
    await expect(waitForStart(log, 120)).rejects.toThrow(/not json at all/);
  });

  test("a missing file says so rather than quoting nothing", async () => {
    await expect(waitForStart(log, 120)).rejects.toThrow(/no such file/);
  });
});
