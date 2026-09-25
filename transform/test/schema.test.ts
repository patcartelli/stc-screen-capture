import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

function compile(schemaPath: string) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(load(schemaPath));
}

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

describe("session schemas validate the fixture", () => {
  test("anchors.json conforms to anchors-1 schema", () => {
    const validate = compile("schema/anchors-1.schema.json");
    const ok = validate(load("fixtures/basic/anchors.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("events.json conforms to events-2 schema (it carries cursor-shape events)", () => {
    const validate = compile("schema/events-2.schema.json");
    const ok = validate(load("fixtures/basic/events.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("the real session's events.json (helper output from before STC-309) conforms to events-1", () => {
    const validate = compile("schema/events-1.schema.json");
    const ok = validate(load("fixtures/real-session/events.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("project.json conforms to project-1 schema", () => {
    const validate = compile("schema/project-1.schema.json");
    const ok = validate(load("fixtures/basic/project.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe("schemas reject malformed documents", () => {
  test("events: float timestamps are rejected (integer ns only)", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events[0].t = 0.5;
    expect(validate(doc)).toBe(false);
  });

  test("events: negative timestamps are rejected (session-relative)", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events[0].t = -1;
    expect(validate(doc)).toBe(false);
  });

  test("events: unknown kind is rejected", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events[0].kind = "hover";
    expect(validate(doc)).toBe(false);
  });

  test("events: down without button is rejected", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events.push({ t: 4_900_000_000, kind: "down", x: 1, y: 1 });
    expect(validate(doc)).toBe(false);
  });

  test("anchors: missing timebase is rejected", () => {
    const validate = compile("schema/anchors-1.schema.json");
    const doc = clone(load("fixtures/basic/anchors.json"));
    delete doc.timebase;
    expect(validate(doc)).toBe(false);
  });

  test("anchors: numeric t0Ns is rejected (must be a string — boot ns can exceed 2^53)", () => {
    const validate = compile("schema/anchors-1.schema.json");
    const doc = clone(load("fixtures/basic/anchors.json"));
    doc.t0Ns = 348419582729083;
    expect(validate(doc)).toBe(false);
  });

  test("project: version other than 1 is rejected", () => {
    const validate = compile("schema/project-1.schema.json");
    const doc = clone(load("fixtures/basic/project.json"));
    doc.version = 2;
    expect(validate(doc)).toBe(false);
  });

  // These target project-2: trim lives there, beside pip. Against project-1 the
  // two rejection cases below passed for the wrong reason — additionalProperties
  // is false there, so ANY trim is rejected whatever its shape.
  test("project: optional trim is accepted", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.trim = { startNs: 1_000_000_000, endNs: 3_000_000_000 };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  test("project: trim without endNs is rejected", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.trim = { startNs: 0 };
    expect(validate(doc)).toBe(false);
  });

  test("project: float trim times are rejected (integer ns only)", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.trim = { startNs: 0.5, endNs: 1 };
    expect(validate(doc)).toBe(false);
  });
});

describe("fixture frame grid", () => {
  test("frames.json is a strictly increasing list of non-negative integer ns", () => {
    const frames: number[] = load("fixtures/basic/frames.json");
    expect(frames.length).toBeGreaterThan(10);
    for (let i = 0; i < frames.length; i++) {
      expect(Number.isInteger(frames[i]), `frames[${i}] not an integer`).toBe(true);
      expect(frames[i]! >= 0).toBe(true);
      if (i > 0) expect(frames[i]! > frames[i - 1]!, `frames[${i}] not increasing`).toBe(true);
    }
  });

  test("frames grid is VFR: contains at least one gap ≥ 2 nominal frame periods", () => {
    const frames: number[] = load("fixtures/basic/frames.json");
    const gaps = frames.slice(1).map((t, i) => t - frames[i]!);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(33_333_334);
  });
});

describe("v2 schemas carry the camera track and PiP geometry", () => {
  test("the pip fixture's anchors conform to anchors-2", () => {
    const validate = compile("schema/anchors-2.schema.json");
    const ok = validate(load("fixtures/pip/anchors.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("the pip fixture's project conforms to project-2", () => {
    const validate = compile("schema/project-2.schema.json");
    const ok = validate(load("fixtures/pip/project.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("project-2 rejects a corner it does not implement", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.pip.corner = "top-left";
    expect(validate(doc)).toBe(false);
  });

  test("anchors-2 rejects a camera block missing frameIntervalNs", () => {
    // The transform bounds the PiP's track end with this value. Without it the
    // bound would have to be assumed, and the measured camera rate varies.
    const validate = compile("schema/anchors-2.schema.json");
    const doc = clone(load("fixtures/pip/anchors.json"));
    delete doc.camera.frameIntervalNs;
    expect(validate(doc)).toBe(false);
  });

  test("a v1 document is not a v2 document", () => {
    const validate = compile("schema/anchors-2.schema.json");
    expect(validate(load("fixtures/basic/anchors.json"))).toBe(false);
  });

  test("camera: present:false alone is valid — no measurements required when absent", () => {
    // Increment 3's "no camera requested / none available" path must not have
    // to fabricate a device string or width/height/frameIntervalNs to satisfy
    // the schema, or present:false is dead.
    const validate = compile("schema/anchors-2.schema.json");
    const doc = clone(load("fixtures/pip/anchors.json"));
    doc.camera = { present: false };
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("camera: present:true missing frameIntervalNs is invalid", () => {
    const validate = compile("schema/anchors-2.schema.json");
    const doc = clone(load("fixtures/pip/anchors.json"));
    delete doc.camera.frameIntervalNs;
    expect(validate(doc)).toBe(false);
  });

  test("a v1 events document is not a v2 document", () => {
    const validate = compile("schema/events-2.schema.json");
    expect(validate(load("fixtures/real-session/events.json"))).toBe(false);
  });

  test("a v2 events document is not a v1 document", () => {
    const validate = compile("schema/events-1.schema.json");
    expect(validate(load("fixtures/basic/events.json"))).toBe(false);
  });

  test("events-2: a shape the compositor has no artwork for is rejected", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events.push({ t: 4_900_000_000, kind: "cursor", shape: "resizeLeftRight" });
    expect(validate(doc)).toBe(false);
  });

  test("events-2: a cursor event carries no position — one with x/y is rejected", () => {
    // The shape is a step function between cursor events; a position on it
    // would be a second source of cursor motion the sim does not read.
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events.push({ t: 4_900_000_000, kind: "cursor", shape: "ibeam", x: 1, y: 1 });
    expect(validate(doc)).toBe(false);
  });

  test("events-2: a cursor event without a shape is rejected", () => {
    const validate = compile("schema/events-2.schema.json");
    const doc = clone(load("fixtures/basic/events.json"));
    doc.events.push({ t: 4_900_000_000, kind: "cursor" });
    expect(validate(doc)).toBe(false);
  });

  test("project-2: cursor.style accepts the circle placeholder and refuses anything else", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.cursor.style = "circle";
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    doc.cursor.style = "dot";
    expect(validate(doc)).toBe(false);
  });

  test("the pip fixture (present:true, full measurements) still validates", () => {
    const validate = compile("schema/anchors-2.schema.json");
    const ok = validate(load("fixtures/pip/anchors.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe("v4 schema carries the mic track (STC-233)", () => {
  // No committed mic.m4a fixture exists (needs a Mac to record one), so these
  // build a v4 document by hand from the v2 pip fixture rather than loading a
  // real take — the same shape anchors-2's "camera: present:false is valid
  // and does not fabricate measurements" test already takes.
  const v4 = (over: Record<string, unknown> = {}) => ({
    ...clone(load("fixtures/pip/anchors.json")),
    version: 4,
    mic: { present: false },
    ...over,
  });

  test("a mic-requested take with no track validates as present:false, no measurements fabricated", () => {
    const validate = compile("schema/anchors-4.schema.json");
    const ok = validate(v4());
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("mic: present:true requires every measurement field", () => {
    const validate = compile("schema/anchors-4.schema.json");
    const doc = v4({
      mic: {
        present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
        firstFramePtsNs: 0, lastFramePtsNs: 1_000_000_000,
      },
      files: { display: "display.mp4", camera: "camera.mp4", mic: "mic.m4a" },
    });
    expect(compile("schema/anchors-4.schema.json")(doc), JSON.stringify(validate.errors)).toBe(true);
    const missingSampleRate = clone(doc);
    delete missingSampleRate.mic.sampleRate;
    expect(validate(missingSampleRate)).toBe(false);
  });

  test("a v2 document is not a v4 document", () => {
    const validate = compile("schema/anchors-4.schema.json");
    expect(validate(load("fixtures/pip/anchors.json"))).toBe(false);
  });
});

describe("v6 schema carries the system-audio track (STC-418)", () => {
  // Same approach as the v4 mic block above: no committed system.m4a exists
  // (needs a Mac), so a v6 document is built by hand from the v2 pip fixture.
  const v6 = (over: Record<string, unknown> = {}) => ({
    ...clone(load("fixtures/pip/anchors.json")),
    version: 6,
    system: { present: false },
    ...over,
  });
  const presentSystem = {
    present: true, sampleRate: 48000, channels: 2,
    firstFramePtsNs: 0, lastFramePtsNs: 1_000_000_000,
  };

  test("requested with no track validates as present:false, no measurements fabricated", () => {
    const validate = compile("schema/anchors-6.schema.json");
    expect(validate(v6()), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("present:true requires every measurement field", () => {
    const validate = compile("schema/anchors-6.schema.json");
    const doc = v6({
      system: presentSystem,
      files: { display: "display.mp4", camera: "camera.mp4", system: "system.m4a" },
    });
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    for (const field of ["sampleRate", "channels", "firstFramePtsNs", "lastFramePtsNs"]) {
      const missing = clone(doc);
      delete missing.system[field];
      expect(validate(missing), field).toBe(false);
    }
  });

  test("system has no device — there is one system output, not a picker", () => {
    const validate = compile("schema/anchors-6.schema.json");
    expect(validate(v6({ system: { ...presentSystem, device: "Speakers" } }))).toBe(false);
  });

  test("system and mic coexist as two independent tracks", () => {
    const validate = compile("schema/anchors-6.schema.json");
    const doc = v6({
      mic: {
        present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
        firstFramePtsNs: 0, lastFramePtsNs: 1_000_000_000,
      },
      system: presentSystem,
      files: { display: "display.mp4", camera: "camera.mp4", mic: "mic.m4a", system: "system.m4a" },
    });
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("a system block needs v6: anchors-5 refuses it", () => {
    const doc = v6({ version: 5 });
    expect(compile("schema/anchors-5.schema.json")(doc)).toBe(false);
  });

  test("a v5 document is not a v6 document", () => {
    const doc = { ...clone(load("fixtures/pip/anchors.json")), version: 5 };
    expect(compile("schema/anchors-5.schema.json")(doc)).toBe(true);
    expect(compile("schema/anchors-6.schema.json")(doc)).toBe(false);
  });
});
