import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptureId } from "../src/capture-identity.js";
import { CAPTURE_DOC_FILE } from "@transform/capture-doc.js";
import { isCaptureId } from "@transform/capture-id.js";

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

  test("concurrent calls on one bundle agree", async () => {
    // Two exports racing is reachable: STC-296's stacking is the first thing
    // in this app that can export twice at once.
    const ids = await Promise.all([ensureCaptureId(dir), ensureCaptureId(dir)]);
    expect(ids[0]).toBe(ids[1]);
  });
});
