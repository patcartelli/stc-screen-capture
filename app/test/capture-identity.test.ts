import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCaptureId, readBundleId, captureIdRepairNotice, type CaptureIdRepair,
} from "../src/capture-identity.js";
import { CAPTURE_DOC_FILE } from "@transform/capture-doc.js";
import { isCaptureId, mintCaptureId } from "@transform/capture-id.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "stc-id-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ensureCaptureId", () => {
  test("mints an id and writes it into the bundle", async () => {
    const id = await ensureCaptureId(dir);
    expect(isCaptureId(id)).toBe(true);
    const doc = JSON.parse(await readFile(join(dir, CAPTURE_DOC_FILE), "utf8"));
    expect(doc.id).toBe(id);
  });

  test("IS IDEMPOTENT — a second export reuses the first id", async () => {
    // If this fails, re-exporting a take orphans the file exported before it.
    expect(await ensureCaptureId(dir)).toBe(await ensureCaptureId(dir));
  });

  test("a corrupt document is replaced rather than thrown on", async () => {
    await writeFile(join(dir, CAPTURE_DOC_FILE), "{ not json");
    const id = await ensureCaptureId(dir);
    expect(isCaptureId(id)).toBe(true);
    expect(await ensureCaptureId(dir)).toBe(id);   // and is stable afterwards
  });

  test("a first export reports no repair", async () => {
    const seen: CaptureIdRepair[] = [];
    await ensureCaptureId(dir, (r) => seen.push(r));
    expect(seen).toEqual([]);
  });

  test("concurrent calls on one bundle agree", async () => {
    // Two exports racing is reachable: STC-296's stacking is the first thing
    // in this app that can export twice at once.
    const ids = await Promise.all([ensureCaptureId(dir), ensureCaptureId(dir)]);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("ensureCaptureId salvages a corrupt document's id (STC-436)", () => {
  // The id a finished file already carries. If it is not the one that comes
  // back, that file lists as a second tile in the library.
  const old = mintCaptureId();

  const corruptions: [string, string][] = [
    ["truncated mid-write", `{\n  "version": 1,\n  "id": "${old}"`],
    ["a stray trailing byte", `{ "version": 1, "id": "${old}" }x`],
    ["a hand edit with an unknown field", `{ "version": 1, "id": "${old}", "note": "mine" }`],
    ["a version this build cannot read", `{ "version": 2, "id": "${old}" }`],
    ["the same id twice", `{ "id": "${old}" }{ "id": "${old}" }`],
  ];
  for (const [what, text] of corruptions) {
    test(`keeps the old id: ${what}`, async () => {
      await writeFile(join(dir, CAPTURE_DOC_FILE), text);
      const seen: CaptureIdRepair[] = [];
      expect(await ensureCaptureId(dir, (r) => seen.push(r))).toBe(old);
      expect(seen.map((r) => r.kind)).toEqual(["salvaged"]);
      // Rewritten CLEAN, so the reader agrees from now on without salvaging.
      expect(await readBundleId(dir)).toBe(old);
    });
  }

  test("two DIFFERENT ids are not guessed between — a fresh one is minted", async () => {
    // Picking either could hand this bundle an id another bundle owns.
    const other = mintCaptureId();
    await writeFile(join(dir, CAPTURE_DOC_FILE), `{ "id": "${old}" }{ "id": "${other}" }`);
    const seen: CaptureIdRepair[] = [];
    const id = await ensureCaptureId(dir, (r) => seen.push(r));
    expect([old, other]).not.toContain(id);
    expect(seen.map((r) => r.kind)).toEqual(["reminted"]);
  });

  test("nothing recoverable is reminted, and reported", async () => {
    await writeFile(join(dir, CAPTURE_DOC_FILE), "{ not json");
    const seen: CaptureIdRepair[] = [];
    const id = await ensureCaptureId(dir, (r) => seen.push(r));
    expect(seen).toEqual([{ kind: "reminted", path: join(dir, CAPTURE_DOC_FILE), id }]);
  });

  test("an id that is one character LONG is not an id", async () => {
    // The scanner's boundary rule, through the writer: a longer Crockford run
    // must not have its first 30 characters read as the old id.
    await writeFile(join(dir, CAPTURE_DOC_FILE), `{ "id": "${old}Z"`);
    expect(await ensureCaptureId(dir)).not.toBe(old);
  });

  test("only a REMINT reaches the user", () => {
    // A salvage lost nothing; telling the user about it would be noise.
    const path = join(dir, CAPTURE_DOC_FILE);
    expect(captureIdRepairNotice({ kind: "salvaged", path, id: old })).toBeUndefined();
    const n = captureIdRepairNotice({ kind: "reminted", path, id: old });
    expect(n?.body).toMatch(/separate item/);
  });

  test("two exports racing a corrupt document salvage once, and agree", async () => {
    await writeFile(join(dir, CAPTURE_DOC_FILE), `{ "id": "${old}"`);
    const seen: CaptureIdRepair[] = [];
    const ids = await Promise.all([
      ensureCaptureId(dir, (r) => seen.push(r)), ensureCaptureId(dir, (r) => seen.push(r)),
    ]);
    expect(ids).toEqual([old, old]);
    expect(seen).toHaveLength(1);
  });
});
