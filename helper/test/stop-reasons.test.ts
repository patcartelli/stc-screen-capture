/**
 * STC-311 — every `stop.reason` the helper can write must validate against
 * anchors-2.
 *
 * The enum listed five reasons and their `-timeout` variants. The helper's
 * shutdown path (STC-304) writes `quit`, `stdin-closed` and `signal-N`, and
 * STC-305 added `stopped-during-start`: four families of value a real take
 * can carry that the schema refused. Nothing caught it because nothing
 * compared the two. `shutdown-during-recording.grant.test.ts` asserted
 * `quit` and `signal-15` without validating the document, and
 * `anchors/main.swift` validated documents but only ever built them with
 * `stopReason: "user"` — each half of the check existed, on different
 * reasons, so the gap sat exactly between them.
 *
 * This is the missing comparison, and it is deliberately NOT a second copy of
 * the reason list in TypeScript: a hand-kept list here would be a third place
 * to drift (this repo has fixed "one value, two copies" four times). The
 * SOURCE is the Swift call sites, read from the Swift; the schema is held to
 * them. A new `stop(reason: "…")` anywhere in the helper is covered the
 * moment it is written.
 *
 * Same shape as cursor-shape-names.test.ts, which holds the Swift shape list
 * to the events-2 enum.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");

/**
 * The files that can name a stop reason. DisplayChangeDecisions.swift since
 * STC-235: the classifier DECIDES `display-reconfigured`/`region-out-of-bounds`
 * as `.stop("…")`, and Capture.swift relays them (and its own refit
 * failures) through `failRefit("…")` -> `onRefitFailed` -> App.stop(reason:).
 */
const SOURCES = ["helper/src/main.swift", "helper/src/Protocol.swift", "helper/src/Capture.swift",
                 "helper/src/DisplayChangeDecisions.swift"];

/**
 * Signals the helper installs a graceful handler for (main.swift's
 * `installSignalHandlers`), which is what `signal-\(sig)` interpolates.
 * Read from the Swift rather than assumed, so a signal added there is
 * covered here without an edit.
 */
function handledSignals(src: string): number[] {
  // main.swift has TWO `for sig in [...]` loops and only one of them writes a
  // reason: installCrashHandlers covers SIGSEGV/BUS/ILL/FPE/ABRT/TRAP and dies
  // with a stderr line, never reaching `stop`. Select the loop by what its
  // body does — the one that calls `shutdown(reason:)` — rather than by
  // position, which would silently pick the crash list.
  const loops = [...src.matchAll(/for sig in \[([^\]]+)\]/g)];
  const graceful = loops.filter((m) => {
    const body = src.slice(m.index!, m.index! + 1200);
    return /shutdown\(reason:/.test(body);
  });
  if (graceful.length !== 1) {
    throw new Error(
      `expected exactly one signal loop that calls shutdown(reason:), found ${graceful.length}. ` +
      "The signal reasons are no longer where this test looks for them.",
    );
  }
  const known: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3, SIGUSR1: 30, SIGUSR2: 31 };
  return [...graceful[0]![1]!.matchAll(/SIG[A-Z0-9]+|\d+/g)].map((x) => {
    const n = x[0]!;
    const v = known[n] ?? Number(n);
    if (!Number.isFinite(v)) throw new Error(`unknown signal name in main.swift: ${n}`);
    return v;
  });
}

/**
 * Every reason literal the helper can pass to `stop`/`shutdown`, including
 * `App.stop`'s own default.
 *
 * An interpolated reason is expanded where this test knows how; one it does
 * NOT know how to expand throws rather than being skipped, because a reason
 * built at runtime that nobody checked is precisely the hole this file
 * exists to close.
 */
/**
 * STC-235's two relayed-reason patterns, named so the guard below can hold
 * EACH of them to finding something on its own. The aggregate guard cannot:
 * `display-reconfigured` is also reachable through `.stop("…")`, so a
 * `failRefit` pattern that silently stopped matching would leave the
 * aggregate list unchanged and the refit's own failure reasons unchecked.
 */
const CLASSIFIER_STOP = /\.stop\(\s*"([^"]*)"\s*\)/g;
const FAIL_REFIT = /failRefit\(\s*"([^"]*)"\s*\)/g;

function reasonsInSwift(): string[] {
  const out = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(join(root, file), "utf8");
    const lits = [
      ...src.matchAll(/(?:stop|shutdown)\(reason:\s*"([^"]*)"/g),
      ...src.matchAll(/reason:\s*String\s*=\s*"([^"]*)"/g),
      // STC-370: onWindowChanged carries a reason to App.stop(reason:) through
      // a callback rather than a literal stop(reason: "…") call — the same
      // shape onStreamDied already has, except onStreamDied's reason
      // ("stream-stopped") is a literal at ITS call site (App.stop(reason:
      // "stream-stopped")) while a window watch has two DIFFERENT reasons
      // depending on what happened, so the literals live where they are
      // DECIDED (onWindowChanged?("window-resized") in Capture.swift) rather
      // than at the generic App.stop(reason: reason) call site that relays
      // whichever one arrives.
      ...src.matchAll(/onWindowChanged\?\(\s*"([^"]*)"\s*\)/g),
      // STC-235: a display change that cannot be refitted reaches
      // App.stop(reason:) the same relayed way, through `onRefitFailed`. The
      // literals live where they are decided: the classifier's
      // `.stop("…")` (DisplayChangeDecisions.swift) and CaptureSession's own
      // `failRefit("…")` for a refit that failed or never produced a frame.
      ...src.matchAll(CLASSIFIER_STOP),
      ...src.matchAll(FAIL_REFIT),
    ].map((m) => m[1]!);
    for (const lit of lits) {
      if (!lit.includes("\\(")) { out.add(lit); continue; }
      if (/^signal-\\\(sig\)$/.test(lit)) {
        for (const s of handledSignals(src)) out.add(`signal-${s}`);
        continue;
      }
      throw new Error(
        `${file} builds a stop reason by interpolation this test cannot expand: "${lit}". ` +
        "Teach it how, or the reason goes unchecked against the schema.",
      );
    }
  }
  return [...out].sort();
}

// anchors-7, the newest superset. Every `stop.reason` enum from anchors-3 on
// is its predecessor's PLUS new families, never a narrower rewrite, so
// validating the full set the Swift can produce against the newest schema is
// the same claim this file always made, extended rather than duplicated:
// - anchors-3 (STC-370) added "window-resized"/"window-closed", reachable
//   only from a window-scope take, which always writes version 3 or later
//   (anchorsDocument emits the MINIMUM version that can express the
//   document — AnchorsDoc.swift).
// - "region-out-of-bounds" (STC-235, and its -timeout) is reachable from ANY
//   region take, so it is in EVERY region-capable version, anchors-3 through
//   anchors-7 — not only in anchors-7. A region take the classifier stops
//   BEFORE any refit has landed has a one-entry geometry timeline, writes no
//   `geometry` key, and so stays at v3-v6. anchors-3..6 were widened to carry
//   it for exactly that take; the per-version test below holds them to it.
const validateReason = (() => {
  const schema = JSON.parse(readFileSync(join(root, "schema/anchors-7.schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema.properties.stop.properties.reason);
})();

describe("stop.reason — the helper and anchors-7 agree (STC-311, extended by STC-370 and STC-235)", () => {
  test("every reason the Swift can write is accepted by the schema", () => {
    const reasons = reasonsInSwift();
    // A guard on the guard: if the regexes stopped matching, this test would
    // pass by checking nothing — the "success by finding nothing to do" trap.
    // These four are the ones the ticket is about; the count catches a
    // narrowing of the search without pinning it to an exact number.
    expect(reasons).toEqual(expect.arrayContaining([
      "user", "quit", "stdin-closed", "stopped-during-start", "signal-15",
      "window-resized", "window-closed",
      "display-reconfigured", "region-out-of-bounds",
    ]));
    expect(reasons.length).toBeGreaterThanOrEqual(9);
    // And a guard on each STC-235 pattern ALONE (see CLASSIFIER_STOP /
    // FAIL_REFIT): the aggregate above still passes if either one stops
    // matching, since the other supplies `display-reconfigured` too.
    const capture = readFileSync(join(root, "helper/src/Capture.swift"), "utf8");
    const decisions = readFileSync(join(root, "helper/src/DisplayChangeDecisions.swift"), "utf8");
    expect([...capture.matchAll(FAIL_REFIT)].length,
      "the failRefit(\"…\") pattern matches nothing in Capture.swift").toBeGreaterThanOrEqual(1);
    expect([...decisions.matchAll(CLASSIFIER_STOP)].length,
      "the .stop(\"…\") pattern matches nothing in DisplayChangeDecisions.swift").toBeGreaterThanOrEqual(1);

    for (const r of reasons) {
      expect(validateReason(r), `the helper can write stop.reason "${r}", which anchors-7 refuses`).toBe(true);
    }
  });

  test("and by the schema with the -timeout suffix, which any reason can gain", () => {
    // CaptureSession.stop's backstop answers `\(reason)-timeout` whatever it
    // was given, so the suffix is not a fixed list of five: a shutdown whose
    // writer wedges writes `quit-timeout` or `signal-15-timeout`.
    for (const r of reasonsInSwift()) {
      expect(validateReason(`${r}-timeout`), `"${r}-timeout" is reachable but anchors-7 refuses it`).toBe(true);
    }
  });

  test("a region take stopped before any refit lands (v3-v6) validates at its OWN version", () => {
    // Every version a region take can be written at: 3 (scope) through 6
    // (system audio), plus 7 once a refit has landed. The helper does not
    // force v7 for a stop reason — it writes the minimum version that can
    // express the document — so the reason must validate at each.
    for (const v of [3, 4, 5, 6, 7]) {
      const schema = JSON.parse(readFileSync(join(root, `schema/anchors-${v}.schema.json`), "utf8"));
      const validate = new Ajv({ allErrors: true, strict: true }).compile(schema.properties.stop.properties.reason);
      for (const r of ["region-out-of-bounds", "region-out-of-bounds-timeout"]) {
        expect(validate(r), `anchors-${v} refuses "${r}", which a v${v} region take can carry`).toBe(true);
      }
    }
  });

  test("the rule still discriminates — it did not become 'any string'", () => {
    // Widening a schema until nothing fails is not a fix. A reason the helper
    // cannot produce must still be refused, or this file proves nothing.
    for (const bad of ["banana", "", "signal", "signal-", "signal-abc", "signal-15-timeou",
                       "user-timeout-timeout", "USER", " user"]) {
      expect(validateReason(bad), `anchors-7 accepts "${bad}", which the helper never writes`).toBe(false);
    }
  });
});
