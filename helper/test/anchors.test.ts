import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { runSwiftHarness } from "./_swift-harness.js";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");

function extractJSON(out: string, marker: string): unknown {
  const line = out.split("\n").find((l) => l.startsWith(marker));
  if (!line) throw new Error(`harness output did not contain a ${marker} line:\n${out}`);
  return JSON.parse(line.slice(marker.length));
}

describe("anchors document", () => {
  test("Swift anchors assertions all pass, and both documents validate against anchors-2", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        // StillDecisions.swift for StillRect/StillWindowInfo — CaptureScopeDoc
        // (STC-370) mirrors shot-1's kind/crop/window shapes on purpose and
        // reuses their types rather than a second copy.
        "helper/src/StillDecisions.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    // The member-by-member checks in anchors/main.swift can drift from the
    // schema silently — they assert the fields they know to look for, not
    // that the document is otherwise valid. Before this, the only thing that
    // ever ran anchorsDocument(...) output through the anchors-2 schema was
    // camera-capture.grant.test.ts, which needs a Camera grant and is
    // excluded from `npm test` — so drift here was caught by nothing that
    // actually runs in CI (the exact gap STC-262 already named). This
    // recompiles the harness anyway to get "ALL PASS" above, so emitting the
    // built documents as JSON and validating them here is nearly free.
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")),
    );

    const noCamera = extractJSON(out, "JSON-NO-CAMERA:");
    expect(validate(noCamera), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect((noCamera as { camera?: unknown }).camera, "a display-only take must not carry a camera block at all").toBeUndefined();

    const requestedNoFrames = extractJSON(out, "JSON-CAMERA-REQUESTED-NO-FRAMES:");
    expect(validate(requestedNoFrames), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const withCamera = extractJSON(out, "JSON-WITH-CAMERA:");
    expect(validate(withCamera), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // STC-311: the documents a SHUTDOWN produces. Every case above stops for
    // reason "user", so the schema was only ever exercised on reasons it
    // already allowed — and the helper writes four families it did not.
    // `stop-reasons.test.ts` holds the schema to what the Swift can emit;
    // this validates whole documents actually built with those reasons.
    for (const marker of ["JSON-STOP-QUIT:", "JSON-STOP-STDIN-CLOSED:", "JSON-STOP-SIGNAL-15:",
                          "JSON-STOP-STOPPED-DURING-START:", "JSON-STOP-SIGNAL-TIMEOUT:"]) {
      const d = extractJSON(out, marker);
      expect(validate(d), `${marker} ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  // STC-370: a region/window-scope take writes version 3 with a `scope`
  // block — a document shape anchors-2 cannot express at all (it has no
  // `scope` property), so these validate against anchors-3 instead. A
  // whole-display take is unaffected by this ticket and keeps validating
  // against anchors-2 above.
  test("region and window scope documents validate against anchors-3, whole-display stays v2", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        "helper/src/StillDecisions.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    const ajv3 = new Ajv({ allErrors: true, strict: true });
    const validate3 = ajv3.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-3.schema.json"), "utf8")),
    );

    const region = extractJSON(out, "JSON-SCOPE-REGION:");
    expect(validate3(region), JSON.stringify(validate3.errors, null, 2)).toBe(true);
    expect((region as { version: number }).version).toBe(3);

    const window = extractJSON(out, "JSON-SCOPE-WINDOW:");
    expect(validate3(window), JSON.stringify(validate3.errors, null, 2)).toBe(true);
    expect((window as { version: number }).version).toBe(3);

    // A v3-shaped document (this schema's own `const: 3`) must still refuse
    // a v2 document — the version bump is not a widening that now accepts
    // everything the old schema did too.
    const ajv2 = new Ajv({ allErrors: true, strict: true });
    const validate2 = ajv2.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")),
    );
    expect(validate2(region), "anchors-2 must refuse a v3, region-scope document").toBe(false);
  });

  // STC-233: a mic-requested take writes version 4 with a `mic` block — a
  // shape anchors-3 cannot express at all. Mirrors the anchors-3/scope test
  // above one version up, plus the "everything at once" case that proves
  // the version is a MAX over scope's own floor and mic's, not whichever was
  // computed last.
  test("mic documents validate against anchors-4, scope and camera included", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        "helper/src/StillDecisions.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    const ajv4 = new Ajv({ allErrors: true, strict: true });
    const validate4 = ajv4.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-4.schema.json"), "utf8")),
    );

    const requestedNoFrames = extractJSON(out, "JSON-MIC-REQUESTED-NO-FRAMES:");
    expect(validate4(requestedNoFrames), JSON.stringify(validate4.errors, null, 2)).toBe(true);

    const withMic = extractJSON(out, "JSON-WITH-MIC:");
    expect(validate4(withMic), JSON.stringify(validate4.errors, null, 2)).toBe(true);

    const everything = extractJSON(out, "JSON-VERSION-4-EVERYTHING:");
    expect(validate4(everything), JSON.stringify(validate4.errors, null, 2)).toBe(true);
    expect((everything as { version: number }).version).toBe(4);
    expect((everything as { camera?: unknown }).camera).toBeDefined();
    expect((everything as { mic?: unknown }).mic).toBeDefined();
    expect((everything as { scope?: unknown }).scope).toBeDefined();

    // A v4-shaped document must still refuse anchors-3 — the version bump is
    // not a widening that now accepts everything the old schema did too.
    const ajv3 = new Ajv({ allErrors: true, strict: true });
    const validate3 = ajv3.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-3.schema.json"), "utf8")),
    );
    expect(validate3(withMic), "anchors-3 must refuse a v4, mic-bearing document").toBe(false);
  });
}, 60_000);
