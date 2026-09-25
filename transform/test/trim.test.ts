import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import AjvImport from "ajv";
import { DEFAULT_TEXT_PT } from "../src/legibility.js";
import type { Project } from "../src/types.js";
import {
  availableFrames, clampTrim, defaultProject, estimateExportMs, exportWindow,
  isFullTake, minTrimNs, parseProject, projectForWrite, EXPORT_MS_PER_FRAME,
  DEFAULT_SYSTEM_AUDIO_LEVEL, DEFAULT_NARRATION_CLEANUP,
} from "../src/trim.js";

const root = join(__dirname, "..", "..");
const FPS = 60;
const NS = 1_000_000_000;
const duration = 5 * NS;

describe("clampTrim", () => {
  test("keeps a valid in/out as-is", () => {
    expect(clampTrim(1 * NS, 3 * NS, duration)).toEqual({ startNs: 1 * NS, endNs: 3 * NS });
  });

  test("will not let the handles cross or sit closer than one output frame", () => {
    const min = minTrimNs(FPS);
    const t = clampTrim(2 * NS, 2 * NS, duration);
    expect(t.endNs - t.startNs).toBe(min);
  });

  test("clamps to the take", () => {
    expect(clampTrim(-1, duration + NS, duration)).toEqual({ startNs: 0, endNs: duration });
  });
});

describe("exportWindow", () => {
  test("no trim is the full take, matching export's available-frame count", () => {
    const project = defaultProject(640, 360);
    const w = exportWindow(project, duration);
    expect(w.fromFrame).toBe(0);
    expect(w.maxFrames).toBe(availableFrames(duration, FPS));
    expect(isFullTake(project, duration)).toBe(true);
  });

  test("a 1-second in/out at t=2s is 60 frames starting at frame 120", () => {
    const project = defaultProject(640, 360, { startNs: 2 * NS, endNs: 3 * NS });
    const w = exportWindow(project, duration);
    expect(w.fromFrame).toBe(120);
    expect(w.maxFrames).toBe(61); // inclusive of the frame at 3.000s
  });

  test("endNs on the last frame includes it", () => {
    const last = 4_983_333_349;
    const project = defaultProject(640, 360);
    const full = exportWindow(project, last);
    const trimmed = exportWindow(
      defaultProject(640, 360, { startNs: 0, endNs: last }), last,
    );
    expect(trimmed.maxFrames).toBe(full.maxFrames);
    expect(trimmed.fromFrame).toBe(0);
  });
});

describe("parseProject", () => {
  test("absent or malformed documents become a default, not an error", () => {
    expect(parseProject(null, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
    expect(parseProject("{nope}", 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
    expect(parseProject({ version: 2 }, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
  });

  test("carries cursor.style: circle, and coerces anything else to the default pointer", () => {
    const raw = (style: unknown) => ({
      version: 2, output: { fps: 60, width: 640, height: 360 }, cursor: { style, scale: 2 },
    });
    expect(parseProject(raw("circle"), 640, 360, duration).cursor).toEqual({ style: "circle", scale: 2 });
    expect(parseProject(raw("default"), 640, 360, duration).cursor.style).toBe("default");
    expect(parseProject(raw("dot"), 640, 360, duration).cursor.style).toBe("default");
    expect(parseProject(raw(undefined), 640, 360, duration).cursor.style).toBe("default");
  });

  test("round-trips a valid trim", () => {
    const raw = defaultProject(640, 360, { startNs: NS, endNs: 2 * NS });
    const p = parseProject(raw, 3840, 2160, duration);
    expect(p.trim).toEqual({ startNs: NS, endNs: 2 * NS });
    expect(p.output.width).toBe(640);
  });
});

describe("projectForWrite", () => {
  test("omits trim when the range is the whole take, so a reset is a no-op sidecar", () => {
    const p = defaultProject(640, 360, { startNs: 0, endNs: duration });
    expect(projectForWrite(p, duration).trim).toBeUndefined();
  });

  test("keeps a real trim", () => {
    const p = defaultProject(640, 360, { startNs: NS, endNs: 2 * NS });
    expect(projectForWrite(p, duration).trim).toEqual(p.trim);
  });
});

describe("project-5: the recorded app's text size (STC-318)", () => {
  const Ajv = (AjvImport as any).default ?? AjvImport;
  const schema = (n: number) => new Ajv({ allErrors: true, strict: true })
    .compile(JSON.parse(readFileSync(join(root, `schema/project-${n}.schema.json`), "utf8")));
  const validate4 = schema(4);
  const validate5 = schema(5);
  const raw = (textPt: unknown) => ({
    version: 5, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
    cursor: { style: "default", scale: 1 }, textPt,
  });

  test("always present after a parse, at every document version", () => {
    for (const doc of [null, { version: 1 }, { version: 3 }, { version: 4 }, raw(undefined)]) {
      expect(parseProject(doc, 640, 360, duration).textPt).toBe(DEFAULT_TEXT_PT);
    }
    expect(defaultProject(640, 360).textPt).toBe(DEFAULT_TEXT_PT);
  });

  test("carries a real value and falls back on nonsense, never throwing", () => {
    expect(parseProject(raw(16), 640, 360, duration).textPt).toBe(16);
    expect(parseProject(raw(9.5), 640, 360, duration).textPt).toBe(9.5);
    for (const bad of [0, -1, 200, "13", null, NaN]) {
      expect(parseProject(raw(bad), 640, 360, duration).textPt,
        `textPt: ${JSON.stringify(bad)}`).toBe(DEFAULT_TEXT_PT);
    }
  });

  test("the default text size writes v3 with no textPt key", () => {
    const out = projectForWrite(defaultProject(640, 360), duration);
    expect(out.version).toBe(3);
    expect(out.textPt).toBeUndefined();
  });

  test("a changed text size writes v5, and round-trips", () => {
    const p: Project = { ...defaultProject(640, 360), textPt: 16 };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(5);
    expect(out.textPt).toBe(16);
    expect(validate5(out), JSON.stringify(validate5.errors, null, 2)).toBe(true);
    expect(parseProject(out, 640, 360, duration).textPt).toBe(16);
  });

  test("V5 IS A SUPERSET OF V4 — promoting the version must not drop the zoom", () => {
    // The bug this guards: `if (version === 4 && zoom) out.zoom = ...` reads
    // correctly and silently discards a non-default zoom the moment textPt
    // pushes the document to 5. The setting would vanish on the very write
    // that promoted it, and every test about zoom alone would still pass.
    const p: Project = {
      ...defaultProject(640, 360),
      textPt: 16,
      zoom: { enabled: false, intensity: 0.25, preset: "calm" },
    };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(5);
    expect(out.textPt).toBe(16);
    expect(out.zoom).toEqual({ enabled: false, intensity: 0.25, preset: "calm" });
    expect(validate5(out), JSON.stringify(validate5.errors, null, 2)).toBe(true);
    const back = parseProject(out, 640, 360, duration);
    expect(back.textPt).toBe(16);
    expect(back.zoom).toEqual({ enabled: false, intensity: 0.25, preset: "calm" });
  });

  test("a v5 document with a DEFAULT zoom does not carry the zoom key", () => {
    // The minimum-version rule still applies per field: v5 is needed for the
    // text size and says nothing about zoom, so a default zoom stays absent.
    const out = projectForWrite({ ...defaultProject(640, 360), textPt: 16 }, duration);
    expect(out.version).toBe(5);
    expect(out.zoom).toBeUndefined();
    expect(validate5(out), JSON.stringify(validate5.errors, null, 2)).toBe(true);
  });

  test("changing the text size BACK returns the document to its old version", () => {
    const p: Project = { ...defaultProject(640, 360), textPt: 16 };
    expect(projectForWrite(p, duration).version).toBe(5);
    p.textPt = DEFAULT_TEXT_PT;
    expect(projectForWrite(p, duration).version).toBe(3);
    p.zoom = { enabled: false, intensity: 1, preset: "standard" };
    expect(projectForWrite(p, duration).version).toBe(4);
    expect(validate4(projectForWrite(p, duration))).toBe(true);
  });

  test("project-5 refuses what the parser refuses", () => {
    const doc = (textPt: unknown) => ({
      version: 5, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, textPt,
    });
    expect(validate5(doc(0))).toBe(false);
    expect(validate5(doc(200))).toBe(false);
    expect(validate5(doc("13"))).toBe(false);
    expect(validate5(doc(13))).toBe(true);
  });
});

describe("project-8: bookmarks (STC-444 slice 4)", () => {
  const Ajv = (AjvImport as any).default ?? AjvImport;
  const schema = (n: number) => new Ajv({ allErrors: true, strict: true })
    .compile(JSON.parse(readFileSync(join(root, `schema/project-${n}.schema.json`), "utf8")));
  const validate7 = schema(7);
  const validate8 = schema(8);
  const raw = (bookmarks: unknown) => ({
    version: 8, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
    cursor: { style: "default", scale: 1 }, bookmarks,
  });

  test("always an array after a parse, at every document version", () => {
    for (const doc of [null, { version: 1 }, { version: 3 }, { version: 7 }, raw(undefined)]) {
      expect(parseProject(doc, 640, 360, duration).bookmarks).toEqual([]);
    }
    expect(defaultProject(640, 360).bookmarks).toEqual([]);
  });

  test("sorts, de-duplicates, and drops nonsense entries rather than throwing", () => {
    expect(parseProject(raw([2 * NS, NS, NS, 3 * NS]), 640, 360, duration).bookmarks)
      .toEqual([NS, 2 * NS, 3 * NS]);
    for (const bad of [-1, 1.5, "1", null, NaN, duration + 1]) {
      expect(parseProject(raw([NS, bad]), 640, 360, duration).bookmarks,
        `bookmark entry: ${JSON.stringify(bad)}`).toEqual([NS]);
    }
    expect(parseProject(raw("not an array"), 640, 360, duration).bookmarks).toEqual([]);
  });

  test("clamped to the take — a re-take that shrank the duration does not carry a bookmark past its end", () => {
    expect(parseProject(raw([duration]), 640, 360, duration).bookmarks).toEqual([duration]);
    expect(parseProject(raw([duration + 1]), 640, 360, duration).bookmarks).toEqual([]);
  });

  test("no bookmarks writes v7 with no bookmarks key, even once the take has a slug", () => {
    const p: Project = { ...defaultProject(640, 360), slug: "network" };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(7);
    expect(out.bookmarks).toBeUndefined();
    expect(validate7(out), JSON.stringify(validate7.errors, null, 2)).toBe(true);
  });

  test("a bookmark writes v8, and round-trips", () => {
    const p: Project = { ...defaultProject(640, 360), bookmarks: [NS, 2 * NS] };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(8);
    expect(out.bookmarks).toEqual([NS, 2 * NS]);
    expect(validate8(out), JSON.stringify(validate8.errors, null, 2)).toBe(true);
    expect(parseProject(out, 640, 360, duration).bookmarks).toEqual([NS, 2 * NS]);
  });

  test("V8 IS A SUPERSET OF V7 — promoting the version must not drop the slug", () => {
    // The same bug class `zoom` was found with when textPt minted v5, and
    // `overrides` again when slug minted v7 (both `=== N` rather than `>= N`):
    // a bookmark on a take that ALSO has a slug must not silently lose it the
    // moment the bookmark pushes the document to v8.
    const p: Project = { ...defaultProject(640, 360), slug: "network", bookmarks: [NS] };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(8);
    expect(out.slug).toBe("network");
    expect(out.bookmarks).toEqual([NS]);
    expect(validate8(out), JSON.stringify(validate8.errors, null, 2)).toBe(true);
    const back = parseProject(out, 640, 360, duration);
    expect(back.slug).toBe("network");
    expect(back.bookmarks).toEqual([NS]);
  });

  test("removing every bookmark returns the document to its old version", () => {
    const p: Project = { ...defaultProject(640, 360), slug: "network", bookmarks: [NS] };
    expect(projectForWrite(p, duration).version).toBe(8);
    p.bookmarks = [];
    expect(projectForWrite(p, duration).version).toBe(7);
  });

  test("project-8 refuses what the parser refuses", () => {
    expect(validate8(raw([-1]))).toBe(false);
    expect(validate8(raw([1.5]))).toBe(false);
    expect(validate8(raw(["1"]))).toBe(false);
    expect(validate8(raw([NS]))).toBe(true);
    expect(validate8(raw([]))).toBe(true);
  });
});

describe("project-9: system audio level (STC-418)", () => {
  const Ajv = (AjvImport as any).default ?? AjvImport;
  const schema = (n: number) => new Ajv({ allErrors: true, strict: true })
    .compile(JSON.parse(readFileSync(join(root, `schema/project-${n}.schema.json`), "utf8")));
  const validate8 = schema(8);
  const validate9 = schema(9);
  const raw = (systemAudioLevel: unknown) => ({
    version: 9, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
    cursor: { style: "default", scale: 1 }, systemAudioLevel,
  });

  test("full level after a parse at every older version, and by default", () => {
    expect(DEFAULT_SYSTEM_AUDIO_LEVEL).toBe(1);
    for (const doc of [null, { version: 1 }, { version: 3 }, { version: 8 }, raw(undefined)]) {
      expect(parseProject(doc, 640, 360, duration).systemAudioLevel).toBe(1);
    }
    expect(defaultProject(640, 360).systemAudioLevel).toBe(1);
  });

  test("0..1 is carried; anything else is no opinion, not a clamp", () => {
    for (const ok of [0, 0.25, 1]) {
      expect(parseProject(raw(ok), 640, 360, duration).systemAudioLevel).toBe(ok);
    }
    for (const bad of [-0.1, 1.4, "0.5", null, NaN]) {
      expect(parseProject(raw(bad), 640, 360, duration).systemAudioLevel,
        `level: ${JSON.stringify(bad)}`).toBe(1);
    }
  });

  test("full level writes no systemAudioLevel key and stays at the version its other edits earned", () => {
    const p: Project = { ...defaultProject(640, 360), bookmarks: [NS] };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(8);
    expect(out.systemAudioLevel).toBeUndefined();
    expect(validate8(out), JSON.stringify(validate8.errors, null, 2)).toBe(true);
  });

  test("a lowered level writes v9, and round-trips — 0 (muted) included", () => {
    for (const level of [0, 0.5]) {
      const p: Project = { ...defaultProject(640, 360), systemAudioLevel: level };
      const out = projectForWrite(p, duration);
      expect(out.version).toBe(9);
      expect(out.systemAudioLevel).toBe(level);
      expect(validate9(out), JSON.stringify(validate9.errors, null, 2)).toBe(true);
      expect(parseProject(out, 640, 360, duration).systemAudioLevel).toBe(level);
    }
  });

  test("V9 IS A SUPERSET OF V8 — promoting the version must not drop bookmarks or the slug", () => {
    const p: Project = {
      ...defaultProject(640, 360), slug: "network", bookmarks: [NS], systemAudioLevel: 0.5,
    };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(9);
    expect(out.slug).toBe("network");
    expect(out.bookmarks).toEqual([NS]);
    expect(validate9(out), JSON.stringify(validate9.errors, null, 2)).toBe(true);
    const back = parseProject(out, 640, 360, duration);
    expect(back.slug).toBe("network");
    expect(back.bookmarks).toEqual([NS]);
    expect(back.systemAudioLevel).toBe(0.5);
  });

  test("returning to full level returns the document to its old version", () => {
    const p: Project = { ...defaultProject(640, 360), slug: "network", systemAudioLevel: 0.5 };
    expect(projectForWrite(p, duration).version).toBe(9);
    p.systemAudioLevel = 1;
    expect(projectForWrite(p, duration).version).toBe(7);
  });

  test("project-9 refuses what the parser refuses; project-8 refuses the field", () => {
    expect(validate9(raw(-0.1))).toBe(false);
    expect(validate9(raw(1.4))).toBe(false);
    expect(validate9(raw("0.5"))).toBe(false);
    expect(validate9(raw(0))).toBe(true);
    expect(validate9(raw(1))).toBe(true);
    expect(validate8({ ...raw(0.5), version: 8 })).toBe(false);
  });
});

describe("project-10: narration cleanup (STC-455)", () => {
  const Ajv = (AjvImport as any).default ?? AjvImport;
  const schema = (n: number) => new Ajv({ allErrors: true, strict: true })
    .compile(JSON.parse(readFileSync(join(root, `schema/project-${n}.schema.json`), "utf8")));
  const validate9 = schema(9);
  const validate10 = schema(10);
  const raw = (narrationCleanup: unknown) => ({
    version: 10, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
    cursor: { style: "default", scale: 1 }, narrationCleanup,
  });

  test("off at 0.5 after a parse at every older version, and by default", () => {
    expect(DEFAULT_NARRATION_CLEANUP).toEqual({ enabled: false, strength: 0.5 });
    for (const doc of [null, { version: 1 }, { version: 3 }, { version: 9 }, raw(undefined)]) {
      expect(parseProject(doc, 640, 360, duration).narrationCleanup).toEqual({ enabled: false, strength: 0.5 });
    }
    expect(defaultProject(640, 360).narrationCleanup).toEqual({ enabled: false, strength: 0.5 });
  });

  test("the default is a copy: editing one take's setting cannot move another's", () => {
    const a = defaultProject(640, 360), b = defaultProject(640, 360);
    a.narrationCleanup!.enabled = true;
    expect(b.narrationCleanup!.enabled).toBe(false);
    expect(DEFAULT_NARRATION_CLEANUP.enabled).toBe(false);
  });

  test("each field is read on its own terms: a bad strength does not undo a deliberate 'on'", () => {
    expect(parseProject(raw({ enabled: true, strength: 0.3 }), 640, 360, duration).narrationCleanup)
      .toEqual({ enabled: true, strength: 0.3 });
    expect(parseProject(raw({ enabled: true, strength: 1.4 }), 640, 360, duration).narrationCleanup)
      .toEqual({ enabled: true, strength: 0.5 });
    expect(parseProject(raw({ enabled: "yes", strength: 0.2 }), 640, 360, duration).narrationCleanup)
      .toEqual({ enabled: false, strength: 0.2 });
    for (const bad of [null, "on", 1, []]) {
      expect(parseProject(raw(bad), 640, 360, duration).narrationCleanup, JSON.stringify(bad))
        .toEqual({ enabled: false, strength: 0.5 });
    }
  });

  test("the default writes no key and stays at the version its other edits earned", () => {
    const p: Project = { ...defaultProject(640, 360), systemAudioLevel: 0.5 };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(9);
    expect(out.narrationCleanup).toBeUndefined();
    expect(validate9(out), JSON.stringify(validate9.errors, null, 2)).toBe(true);
  });

  test("on — or off with a moved strength — writes v10 and round-trips", () => {
    for (const n of [{ enabled: true, strength: 0.5 }, { enabled: false, strength: 0.8 }, { enabled: true, strength: 0 }]) {
      const p: Project = { ...defaultProject(640, 360), narrationCleanup: n };
      const out = projectForWrite(p, duration);
      expect(out.version, JSON.stringify(n)).toBe(10);
      expect(out.narrationCleanup).toEqual(n);
      expect(validate10(out), JSON.stringify(validate10.errors, null, 2)).toBe(true);
      expect(parseProject(out, 640, 360, duration).narrationCleanup).toEqual(n);
    }
  });

  test("V10 IS A SUPERSET OF V9 — promoting the version must not drop the level, bookmarks or slug", () => {
    const p: Project = {
      ...defaultProject(640, 360), slug: "network", bookmarks: [NS], systemAudioLevel: 0.25,
      narrationCleanup: { enabled: true, strength: 0.5 },
    };
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(10);
    expect(out.slug).toBe("network");
    expect(out.bookmarks).toEqual([NS]);
    expect(out.systemAudioLevel).toBe(0.25);
    expect(validate10(out), JSON.stringify(validate10.errors, null, 2)).toBe(true);
    const back = parseProject(out, 640, 360, duration);
    expect(back.systemAudioLevel).toBe(0.25);
    expect(back.narrationCleanup).toEqual({ enabled: true, strength: 0.5 });
  });

  test("returning to the default returns the document to its old version", () => {
    const p: Project = { ...defaultProject(640, 360), slug: "network", narrationCleanup: { enabled: true, strength: 0.5 } };
    expect(projectForWrite(p, duration).version).toBe(10);
    p.narrationCleanup = { enabled: false, strength: 0.5 };
    expect(projectForWrite(p, duration).version).toBe(7);
  });

  test("project-10 refuses what the parser refuses; project-9 refuses the field", () => {
    expect(validate10(raw({ enabled: true, strength: 1.4 }))).toBe(false);
    expect(validate10(raw({ enabled: true, strength: -0.1 }))).toBe(false);
    expect(validate10(raw({ enabled: "yes", strength: 0.5 }))).toBe(false);
    expect(validate10(raw({ enabled: true }))).toBe(false);
    expect(validate10(raw({ enabled: true, strength: 0.5, extra: 1 }))).toBe(false);
    expect(validate10(raw({ enabled: true, strength: 0.5 }))).toBe(true);
    expect(validate9({ ...raw({ enabled: true, strength: 0.5 }), version: 9 })).toBe(false);
  });
});

describe("estimateExportMs", () => {
  test("is the measured 11 ms/frame", () => {
    expect(estimateExportMs(60)).toBe(60 * EXPORT_MS_PER_FRAME);
  });

  // A camera take recorded by the app has NO project.json — nothing writes one
  // at record time — so without a default it previews with pip: null and an
  // invisible PiP, despite a perfectly good camera.mp4 next to it. That is what
  // made the first real hardware take need a hand-written project.
  test("a take with a camera gets a PiP even with no project.json", () => {
    const p = parseProject(null, 3840, 2160, duration, true);
    expect(p.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 });
  });

  test("a take with no camera still gets no PiP", () => {
    expect(parseProject(null, 3840, 2160, duration, false).pip).toBeUndefined();
    // Unchanged for every take that already exists.
    expect(parseProject(null, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
  });

  // The default is a DEFAULT, not an override. Someone who turned the PiP off
  // must stay off, or disabling it on a camera take would be impossible.
  test("an explicit pip in the document beats the default", () => {
    const raw = {
      version: 2, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 },
      pip: { enabled: false, corner: "bottom-right", widthPct: 0.125, marginPx: 32 },
    };
    expect(parseProject(raw, 640, 360, duration, true).pip!.enabled).toBe(false);
  });
});

/**
 * CLAUDE.md's standing rule, made enforceable: "callers pass the take's
 * project.json THROUGH parseProject (or null). Assembling a project outside the
 * one parser is how two answers happen. If you add a fourth caller, pass the
 * raw document."
 *
 * A fourth caller was added anyway. harness/sink-identity.ts fetched the take's
 * project and used it VERBATIM, falling back to a literal it assembled itself —
 * a literal with no `pip`, because a hand-rolled object cannot know that
 * parseProject turns the PiP on for a camera take. Every camera take without a
 * project.json therefore rendered with no PiP, and `npm run gate:identity`
 * failed on a real 5.6 MB camera track while CI stayed green, because CI ran
 * that gate on a camera-LESS fixture.
 *
 * Four times is enough. This is the fifth caller's tripwire.
 */
describe("one parser decides a project (STC-232)", () => {
  const SCOPE = ["harness", join("app", "src")];

  const sources = () => SCOPE.flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => ({
        path: join(dir, e.name),
        // Comments stripped: a guard that greps raw source is asserting
        // something about the documentation. The first draft of the
        // parseProject check below passed against a file with the call REMOVED,
        // because the comment explaining the rule still said the word.
        src: withoutComments(readFileSync(join(root, dir, e.name), "utf8")),
      })));

  test("every file that produces a Project routes it through parseProject", () => {
    const offenders = sources()
      .filter((f) => /:\s*Project\b/.test(f.src) && !f.src.includes("parseProject"))
      .map((f) => f.path);
    expect(offenders,
      "a Project built outside parseProject misses the defaults it applies — " +
      `above all pip.enabled for a camera take:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("no file assembles a project literal of its own", () => {
    // `cursor: { style:` is the tell: only a hand-assembled Project has it.
    const offenders = sources()
      .filter((f) => /cursor:\s*\{\s*style:/.test(f.src))
      .map((f) => f.path);
    expect(offenders,
      `these assemble a project instead of parsing one:\n${offenders.join("\n")}`).toEqual([]);
  });
});
