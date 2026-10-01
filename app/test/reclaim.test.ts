import { describe, test, expect } from "vitest";
import { reclaimPrompt, reclaimResult, RECLAIM_LIST_MAX } from "../src/reclaim.js";
import type { BlockedBundle, OrphanedBundle } from "../src/temp-takes.js";

const orphan = (name: string, bytes: number, kind: OrphanedBundle["kind"] = "recording"): OrphanedBundle =>
  ({ dir: `/f/raw/${name}`, name, kind, bytes });
const blocked = (name: string, blockers: string[], kind: OrphanedBundle["kind"] = "still"): BlockedBundle =>
  ({ ...orphan(name, 2e6, kind), blockers });

describe("reclaimPrompt — what the user is shown before anything moves", () => {
  test("nothing orphaned, nothing blocked: a toast, never a dialog", () => {
    const p = reclaimPrompt({ orphans: [], blocked: [] });
    expect(p.kind).toBe("toast");
    if (p.kind !== "toast") return;
    expect(p.message.title).toBe("Nothing to reclaim");
    expect(p.message.body).toMatch(/every/i);
  });

  test("nothing offerable but some blocked: the toast NAMES the files in the way", () => {
    const p = reclaimPrompt({ orphans: [], blocked: [blocked("b1", ["holiday.jpg", "Screenshot 1.png"])] });
    expect(p.kind).toBe("toast");
    if (p.kind !== "toast") return;
    expect(p.message.body).toContain("holiday.jpg");
    expect(p.message.body).toContain("Screenshot 1.png");
    expect(p.message.body).toMatch(/no capture id/);
  });

  test("orphans: a dialog listing each with kind and size, and the total on the button", () => {
    const p = reclaimPrompt({ orphans: [orphan("2026-09-01_10-00-00", 1.2e9), orphan("2026-09-02_10-00-00", 3e6, "still")],
                              blocked: [] });
    expect(p.kind).toBe("dialog");
    if (p.kind !== "dialog") return;
    expect(p.message).toBe("Move 2 unused takes to the Trash?");
    expect(p.detail).toContain("2026-09-01_10-00-00 — recording, 1.2 GB");
    expect(p.detail).toContain("2026-09-02_10-00-00 — still, 3.0 MB");
    expect(p.detail).toMatch(/no file in the folder/);
    expect(p.buttons).toEqual(["Move to Trash (1.2 GB)", "Cancel"]);
    expect(p.cancelId).toBe(1);
    expect(p.dirs).toEqual(["/f/raw/2026-09-01_10-00-00", "/f/raw/2026-09-02_10-00-00"]);
  });

  test("one orphan reads in the singular", () => {
    const p = reclaimPrompt({ orphans: [orphan("a", 10)], blocked: [] });
    if (p.kind !== "dialog") throw new Error("expected a dialog");
    expect(p.message).toBe("Move 1 unused take to the Trash?");
  });

  test("a bundle of unknown kind is named honestly", () => {
    const p = reclaimPrompt({ orphans: [orphan("a", 10, "unknown")], blocked: [] });
    if (p.kind !== "dialog") throw new Error("expected a dialog");
    expect(p.detail).toContain("a — unfinished take, 10 B");
  });

  test("a long list is capped in the TEXT, never in what gets trashed", () => {
    const many = Array.from({ length: RECLAIM_LIST_MAX + 3 }, (_, i) => orphan(`t${String(i).padStart(2, "0")}`, 1));
    const p = reclaimPrompt({ orphans: many, blocked: [] });
    if (p.kind !== "dialog") throw new Error("expected a dialog");
    expect(p.detail).toContain("…and 3 more");
    expect(p.detail).not.toContain(`t${String(RECLAIM_LIST_MAX).padStart(2, "0")} —`);
    expect(p.dirs).toHaveLength(RECLAIM_LIST_MAX + 3);
  });

  test("orphans AND blocked: the dialog also says what was held back, and by which files", () => {
    const p = reclaimPrompt({ orphans: [orphan("a", 10)],
                              blocked: [blocked("b1", ["holiday.jpg"]), blocked("b2", ["holiday.jpg"])] });
    if (p.kind !== "dialog") throw new Error("expected a dialog");
    expect(p.detail).toMatch(/Another 2 takes \(4\.0 MB\) can't be checked/);
    // A file blocking two bundles is named once.
    expect(p.detail.match(/holiday\.jpg/g)).toHaveLength(1);
    // Held-back bundles are never on the list to be trashed.
    expect(p.dirs).toEqual(["/f/raw/a"]);
  });
});

describe("reclaimResult — the toast after the Trash", () => {
  test("all moved", () => {
    expect(reclaimResult([orphan("a", 1e9), orphan("b", 2e8)], 0).body).toBe("Moved 2 takes (1.2 GB) to the Trash.");
  });
  test("some failed to move: says so, never claims the full total", () => {
    const m = reclaimResult([orphan("a", 1e6)], 2);
    expect(m.body).toContain("Moved 1 take (1.0 MB)");
    expect(m.body).toMatch(/2 could not be moved/);
  });
  test("a file came back during the dialog: nothing moved is not a failure", () => {
    expect(reclaimResult([], 0).body).toMatch(/nothing was moved/i);
  });
});
