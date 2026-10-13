import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { panelReason, libraryNote } from "../src/stop-copy.js";
import { recordingItem, type TakeInfo } from "../src/library-items.js";

const root = join(__dirname, "..", "..");
/** Every reason anchors-11 can carry, read from the schema so a new one is covered without an edit. */
const reasons: string[] = JSON.parse(readFileSync(join(root, "schema/anchors-11.schema.json"), "utf8"))
  .properties.stop.properties.reason.anyOf.flatMap((b: { enum?: string[] }) => b.enum ?? []);

describe("stop copy (STC-530)", () => {
  test("recorder-quit has the spec's panel reason and library note", () => {
    const stop = { t: 1, reason: "recorder-quit" };
    expect(panelReason(stop)).toBe("Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.");
    expect(libraryNote(stop)).toBe("Recovered after the recorder quit. No cursor data.");
  });

  test("every other reason says nothing yet (STC-529 and STC-531 add theirs here)", () => {
    expect(reasons).toContain("recorder-quit");
    for (const reason of reasons.filter((r) => r !== "recorder-quit")) {
      expect(panelReason({ t: 1, reason }), reason).toBeUndefined();
      expect(libraryNote({ t: 1, reason }), reason).toBeUndefined();
    }
    expect(panelReason(undefined)).toBeUndefined();
    expect(libraryNote({})).toBeUndefined();
  });

  const aTake = (): TakeInfo => ({
    dir: "/x/take", name: "take", recordedAt: 0, durationMs: 1000,
    width: 10, height: 10, events: 0, bytes: 1,
  });

  test("a recovered recording carries the library note", () => {
    const item = recordingItem({ ...aTake(), stop: { t: 4_000_000_000, reason: "recorder-quit" } });
    expect(item.notes).toContain("Recovered after the recorder quit. No cursor data.");
    expect(recordingItem(aTake()).notes ?? []).not.toContain("Recovered after the recorder quit. No cursor data.");
  });
});
