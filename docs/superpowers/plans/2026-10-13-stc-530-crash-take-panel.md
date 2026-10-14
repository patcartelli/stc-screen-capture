# STC-530 — Crash-Take Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A take the helper dies in (or whose `anchors.json` failed to write) reaches the corner panel as a full, editable take with no cursor data, instead of a "not saved" toast.

**Architecture:** The helper keeps `anchors.partial.json` — the stop-time anchors document minus `stop` — current while recording. After a crash or a failed sidecar write, the app turns it into an `anchors.json` (pure `recoverAnchors` in `transform/`, I/O `recoverTake` in `app/src`), corrects the end times from the media themselves, checks the result with `loadSession`, and presents the ordinary recording panel. A small pure `stop-copy.ts` maps `anchors.stop` to the panel reason and the library note, populated for `recorder-quit` only.

**Tech Stack:** Swift 6.4 (`helper/build.sh`, no SwiftPM), TypeScript, Electron, vitest, mp4box (via `transform/src/demux*.ts`), Ajv.

**Spec:** `docs/superpowers/specs/2026-10-13-stc-530-crash-take-panel-design.md`

## Global Constraints

- Partial file name: `anchors.partial.json`, in the take directory. Never written on a timer; rewritten only when something it describes changes; written atomically (temp + rename).
- New stop reason: `recorder-quit`, written ONLY by the app's recovery. Schema `anchors-11` = anchors-10 + that reason; minimum-version rule — only `recorder-quit` forces 11.
- Panel reason, verbatim: `Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.`
- Library note, verbatim: `Recovered after the recorder quit. No cursor data.`
- Toast when a lost take cannot be recovered, verbatim: `The recorder quit while recording, and the take couldn't be recovered.` (see Deviations).
- A failure never discards a take: nothing this ticket adds deletes a take directory or a media file.
- Recovery never overwrites an existing `anchors.json`.
- Loaders refuse, never default (repo rule). `recoverAnchors` returns `{ ok: false, why }` rather than inventing a field.
- `stop-copy.ts` returns `undefined` for every reason except `recorder-quit` (STC-529/STC-531 extend it).
- Never run the e2e suite locally (`npx vitest run --project unit …` for unit files; e2e goes to CI through a draft PR). Grant tests run from Patrick's terminal.
- Branch: `accounts/stc-530-crash-take-panel` (worktree). Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec (found while planning; tell Patrick)

1. **The `anchors-write-failed` check cannot ride on `helper/test/disk-full.test.ts`.** That test drives a bare `WriterGate` harness, not `CaptureSession`, which needs a Screen Recording grant. Instead: the partial file's write/retire rule lives in a file-only `PartialAnchors.swift` with a CI harness test (Task 3), and the fault itself is exercised in the grant test (Task 4).
2. **A track whose file is missing or has no readable samples is DROPPED (`present: false`, file key removed), not a refusal.** The spec listed it as a refusal; refusing would cost the whole take for a missing camera fragment, which breaks the parent spec's "a failure never discards a take". Only a display with no frames refuses.
3. **An unrecoverable lost take is never deleted.** The spec said "the folder is removed and a toast stays, 'The recorder quit before anything was recorded.'" Recovery can also fail on a folder that HAS bytes (a partial that never got written, a corrupt one), and deleting that breaks the same rule. So the folder is left in temp storage — launch recovery already removes `empty` folders and reveals `unknown` ones in Finder — and the toast says what is true in every case (Global Constraints).
4. **An open pause at the crash is simply not recorded.** No sample is written while paused, so the recovered take's last frame is already before the pause began; closing the span would describe time the take does not contain.

## Review Focus

1. **Crash inside the first movie fragment:** `anchors.partial.json` exists but `display.mp4` demuxes to zero frames. Expect: not recoverable, nothing deleted, toast. → Task 2 (`recoverAnchors` refusal) and Task 5 (`recoverTake` leaves the folder).
2. **A camera/mic/system track the partial calls present whose file is missing or unreadable.** Expect: that track dropped, the take still recovers and `loadSession` accepts it. → Task 2 and Task 5.
3. **A partial left beside a finished `anchors.json`** (a queued partial write raced the stop). Expect: classified `recording`, recovery never runs, `anchors.json` byte-for-byte untouched. → Task 5 (refuses to overwrite) and Task 7 (`listTempTakes`).
4. **Disk full after `events.json` was written but `anchors.json` failed.** Expect: recovered with reason `disk-full` (v10), `events.json` untouched so the cursor survives, no reason line or note from this ticket. → Task 5 and Task 6.
5. **A window dragged continuously during a window-scope take** (STC-482 appends at 30 Hz). Expect: partial writes coalesce — at most one pending write — and never touch the capture callbacks. → Task 3 (coalescing value test).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `schema/anchors-11.schema.json` | create | anchors-10 + `recorder-quit` |
| `transform/src/types.ts` | modify | `Anchors.version` gains 11 |
| `transform/src/session.ts` | modify | accept v11 |
| `transform/src/capture-colour.ts` | modify | drop the one DOM type so main can import `loadSession` |
| `transform/src/recover-anchors.ts` | create | pure: partial + media facts + reason → anchors, or a refusal |
| `app/src/library-items.ts` | modify | `SUPPORTED_ANCHORS_VERSIONS` + 11; `TakeInfo.stop`; note in `recordingItem` |
| `helper/src/PartialAnchors.swift` | create | file-only: strip `stop`, atomic write, retire rule, write coalescing |
| `helper/src/CameraCapture.swift`, `MicCapture.swift`, `SystemAudioCapture.swift` | modify | `onFirstAppend`; `track()` no longer private |
| `helper/src/Capture.swift` | modify | build/write the partial at each trigger; retire at stop; `anchors-write-failed` fault |
| `app/src/recover-take.ts` | create | node I/O: read partial + media, `recoverAnchors`, `loadSession` check, write |
| `app/src/stop-copy.ts` | create | pure: `panelReason`, `libraryNote` |
| `app/src/thumbnail-window.ts`, `thumbnail-renderer.ts`, `app/renderer/thumbnail.html` | modify | optional reason line |
| `app/src/library.ts` | modify | read `stop` into `TakeInfo` |
| `app/src/temp-takes.ts` | modify | kind `partial` |
| `app/src/main.ts` | modify | `recording-lost` → recover → panel; `onTakeEnded` recovery; launch recovery |
| `app/src/renderer.ts` | modify | toast only when not recovered |
| `app/test/_fake-helper.mjs` | modify | `STC_FAKE_DIE_MS` |
| docs | create/modify | runbook, CLAUDE.md row, TICKET-LOG row |

---

### Task 1: anchors-11 and a loader main can import

**Files:**
- Create: `schema/anchors-11.schema.json`
- Modify: `transform/src/types.ts:8`, `transform/src/session.ts` (version gate ~line 199), `transform/src/capture-colour.ts:27`, `app/src/library-items.ts` (`SUPPORTED_ANCHORS_VERSIONS`)
- Test: `transform/test/schema.test.ts`, `transform/test/session.test.ts`

**Interfaces:**
- Produces: anchors v11 accepted everywhere a version is checked; `canvasColorSpace(...)` returns `"srgb" | "display-p3"`; `@transform/session.js` importable from `app/src` under `tsconfig.node.json`.

- [ ] **Step 1: Write the failing tests**

Append to `transform/test/schema.test.ts` (it already has a `compile(path)` helper and reads fixtures):

```ts
describe("anchors-11 (STC-530): the recorder-quit stop reason", () => {
  const base = () => {
    const a = JSON.parse(readFileSync(join(root, "fixtures/basic/anchors.json"), "utf8"));
    return { ...a, version: 11, stop: { t: 4_000_000_000, reason: "recorder-quit" } };
  };
  test("anchors-11 accepts recorder-quit", () => {
    const validate = compile("schema/anchors-11.schema.json");
    const doc = base();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });
  test("anchors-10 refuses recorder-quit (it is new at 11)", () => {
    const validate = compile("schema/anchors-10.schema.json");
    expect(validate({ ...base(), version: 10 })).toBe(false);
  });
});
```

If `root`/`readFileSync`/`join` are not already imported in that file, import them the way its existing tests do (check the top of the file first).

Append to `transform/test/session.test.ts`, next to the existing `version: 10` case near line 229 and in the same style (`offsetAnchors` is that file's helper):

```ts
  test("v11 (STC-530, recorder-quit) loads like any other take", async () => {
    const s = await loadSession({
      ...fixtureInput(),
      anchors: offsetAnchors({ version: 11 as any, stop: { t: 1_000_000_000, reason: "recorder-quit" } }),
    });
    expect(s.frames.length).toBeGreaterThan(0);
  });
```

(Match the exact call shape of the `version: 10` test above it — copy that test and change the version and reason.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit transform/test/schema.test.ts transform/test/session.test.ts`
Expected: FAIL — anchors-11 schema file not found; `anchors.json version 11 is not supported`.

- [ ] **Step 3: Create the schema and widen the gates**

```bash
cp schema/anchors-10.schema.json schema/anchors-11.schema.json
```

Edit `schema/anchors-11.schema.json`:
- `"$id": "stc:anchors-11"`, `"title": "stc session anchors, v11"`.
- `"description"`: `"anchors-10 plus the recorder-quit stop reason (STC-530): the helper died mid-take and the app rebuilt this document from the helper's anchors.partial.json and the media themselves. Written by the APP, never the helper, and at this version ONLY for that reason. Cursor and event data are absent for such a take. Nothing else changed."`
- `"version": { "const": 11 }`.
- In `stop.properties.reason`'s `enum`, add `"recorder-quit"` after `"disk-full"`.
- `stop.description`: `"Present after a clean stop, or written by the app when it recovers a take (recorder-quit). t is session-relative ns."`

`transform/src/types.ts:8`: `version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;`

`transform/src/session.ts` version gate: add `&& anchors?.version !== 11` and make the message `(expected 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 or 11)`. Add under the v10 comment: `// v11 (STC-530) adds only the recorder-quit stop reason, written by the app's recovery. A recovered take has no events.json; it loads with none.`

`app/src/library-items.ts`: `SUPPORTED_ANCHORS_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];`

`transform/src/capture-colour.ts:27` — replace the DOM type so the node pass accepts the file (it is structurally a `PredefinedColorSpace`, so every canvas caller still typechecks):

```ts
/**
 * The canvas colour space for this take: what to pass to `getContext("2d", { colorSpace })`.
 * Spelled out rather than `PredefinedColorSpace` so the Electron main process can import
 * `loadSession` (STC-530's recovery checks a rebuilt take with it): that is a DOM type, and
 * `tsconfig.node.json` has no DOM. The two values ARE that type's members.
 */
export function canvasColorSpace(anchors: Pick<Anchors, "capture">): "srgb" | "display-p3" {
```

- [ ] **Step 4: Run tests and all three typecheck passes**

Run: `npx vitest run --project unit transform/test/schema.test.ts transform/test/session.test.ts app/test/take-list.test.ts && npm run typecheck`
Expected: PASS (take-list.test.ts pins `SUPPORTED_ANCHORS_VERSIONS` to the schema files on disk, so it fails if either side was missed).

- [ ] **Step 5: Commit**

```bash
git add schema/anchors-11.schema.json transform/src/types.ts transform/src/session.ts transform/src/capture-colour.ts app/src/library-items.ts transform/test/schema.test.ts transform/test/session.test.ts
git commit -m "STC-530: anchors-11 adds the recorder-quit stop reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `recoverAnchors` — the pure half

**Files:**
- Create: `transform/src/recover-anchors.ts`
- Test: `transform/test/recover-anchors.test.ts`

**Interfaces:**
- Consumes: `Anchors` from `transform/src/types.ts` (v11 from Task 1).
- Produces:
  ```ts
  export const PARTIAL_ANCHORS_FILE = "anchors.partial.json";
  export const RECOVERY_STOP_REASON = "recorder-quit";
  export interface RecoveredMedia {
    displayFramesNs: readonly number[];
    cameraFramesNs?: readonly number[] | null;
    micLastNs?: number | null;
    systemLastNs?: number | null;
  }
  export type Recovery = { ok: true; anchors: Anchors } | { ok: false; why: string };
  export function recoverAnchors(partial: unknown, media: RecoveredMedia, reason: string): Recovery;
  ```

- [ ] **Step 1: Write the failing test**

`transform/test/recover-anchors.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { recoverAnchors, RECOVERY_STOP_REASON } from "../src/recover-anchors.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema = (v: number) => new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, `schema/anchors-${v}.schema.json`), "utf8")));

/** fixtures/basic's anchors as the helper's partial would hold them: no stop, a camera and a mic that had started. */
function partial(over: Record<string, unknown> = {}): Record<string, any> {
  const a = JSON.parse(readFileSync(join(root, "fixtures/basic/anchors.json"), "utf8"));
  delete a.stop;
  return {
    ...a, version: 4,
    files: { display: "display.mp4", camera: "camera.mp4", mic: "mic.m4a" },
    camera: { present: true, device: "Cam", width: 1280, height: 720,
              firstFramePtsNs: 1_000_000_000, lastFramePtsNs: 1_000_000_000, frameIntervalNs: 16_666_667 },
    mic: { present: true, device: "Mic", sampleRate: 48000, channels: 1,
           firstFramePtsNs: 900_000_000, lastFramePtsNs: 900_000_000 },
    ...over,
  };
}
const frames = [0, 16_666_667, 33_333_334, 3_000_000_000];
const media = { displayFramesNs: frames, cameraFramesNs: [1_000_000_000, 1_033_000_000, 1_066_000_000, 2_900_000_000], micLastNs: 2_950_000_000 };

describe("recoverAnchors (STC-530)", () => {
  test("stop.t is the display's last frame, the reason is recorded, and recorder-quit is v11", () => {
    const r = recoverAnchors(partial(), media, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.stop).toEqual({ t: 3_000_000_000, reason: "recorder-quit" });
    expect(r.anchors.version).toBe(11);
    expect(schema(11)(r.anchors), JSON.stringify(schema(11).errors)).toBe(true);
  });

  test("each present track's end comes from its own file; the camera's interval is the median delta", () => {
    const r = recoverAnchors(partial(), media, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.camera).toMatchObject({ present: true, lastFramePtsNs: 2_900_000_000, frameIntervalNs: 33_000_000 });
    expect((r.anchors as any).mic).toMatchObject({ present: true, lastFramePtsNs: 2_950_000_000 });
  });

  test("disk-full keeps its own version floor (10), not 11", () => {
    const r = recoverAnchors(partial(), media, "disk-full");
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.version).toBe(10);
    expect(r.anchors.stop?.reason).toBe("disk-full");
  });

  test("a display with no frames is not recoverable (Review Focus 1)", () => {
    const r = recoverAnchors(partial(), { ...media, displayFramesNs: [] }, RECOVERY_STOP_REASON);
    expect(r).toEqual({ ok: false, why: expect.stringMatching(/no frames/) });
  });

  test("a track whose file yielded nothing is dropped, not the take (Review Focus 2)", () => {
    const r = recoverAnchors(partial(), { ...media, cameraFramesNs: null, micLastNs: null }, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.camera).toEqual({ present: false });
    expect((r.anchors as any).mic).toEqual({ present: false });
    expect(r.anchors.files).toEqual({ display: "display.mp4" });
    expect(schema(11)(r.anchors), JSON.stringify(schema(11).errors)).toBe(true);
  });

  test("refuses what is not a partial", () => {
    expect(recoverAnchors(null, media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors([], media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors({ ...partial(), stop: { t: 1, reason: "user" } }, media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors({ ...partial(), version: 11 }, media, RECOVERY_STOP_REASON).ok).toBe(false);
    const { capture, ...noCapture } = partial();
    expect(recoverAnchors(noCapture, media, RECOVERY_STOP_REASON).ok).toBe(false);
  });

  test("does not mutate its input", () => {
    const p = partial();
    const before = JSON.stringify(p);
    recoverAnchors(p, media, RECOVERY_STOP_REASON);
    expect(JSON.stringify(p)).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit transform/test/recover-anchors.test.ts`
Expected: FAIL — cannot find module `../src/recover-anchors.js`.

- [ ] **Step 3: Implement**

`transform/src/recover-anchors.ts`:

```ts
/**
 * A take the recorder quit on, made whole again (STC-530).
 *
 * The helper writes anchors.json only at a clean stop, so a helper that dies mid-take
 * leaves a playable fragmented display.mp4 (STC-394) and nothing describing it. Since
 * STC-530 it also keeps `anchors.partial.json` current while recording: the stop-time
 * document minus `stop`, built by the same Swift function, rewritten whenever something
 * it describes changes. This turns that partial into an anchors document.
 *
 * What the partial cannot know is when things ENDED — every track's `lastFramePtsNs`, and
 * the stop time. Those come from the media themselves (`RecoveredMedia`, read by
 * `app/src/recover-take.ts`), never from the partial's stale values.
 *
 * Refuses rather than guesses, the repo's loader rule — with one deliberate exception: a
 * camera, mic or system track whose file yielded nothing is DROPPED (`present: false`,
 * file key removed) rather than refusing the take. Refusing would cost the whole take for
 * a missing first fragment of a side track, and the parent spec's first rule is that a
 * failure never discards a take. `present: false` is also exactly the schema's meaning:
 * asked for, yielded no track.
 *
 * Pure: no fs, no DOM. Tested in transform/test/recover-anchors.test.ts.
 */
import type { Anchors } from "./types.js";

export const PARTIAL_ANCHORS_FILE = "anchors.partial.json";

/** Written only by this recovery (anchors-11). */
export const RECOVERY_STOP_REASON = "recorder-quit";

/** What the media files say, read by the I/O half. `null` = the file was missing or yielded nothing. */
export interface RecoveredMedia {
  /** display.mp4's demuxed PTS grid, session-relative ns (demuxTrack's `framesNs`). */
  displayFramesNs: readonly number[];
  /** camera.mp4's demuxed grid. Only read when the partial claims a camera. */
  cameraFramesNs?: readonly number[] | null;
  /** The last mic sample, session-relative (after `rebaseMicAudio`). */
  micLastNs?: number | null;
  /** The last system-audio sample, session-relative. */
  systemLastNs?: number | null;
}

export type Recovery = { ok: true; anchors: Anchors } | { ok: false; why: string };

/** The newest version the HELPER writes. A partial claiming more is not one it wrote. */
const MAX_PARTIAL_VERSION = 10;
const REQUIRED = ["timebase", "t0Ns", "display", "capture", "files"] as const;

function medianDelta(xs: readonly number[]): number | undefined {
  if (xs.length < 2) return undefined;
  const d = xs.slice(1).map((x, i) => x - xs[i]!).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

export function recoverAnchors(partial: unknown, media: RecoveredMedia, reason: string): Recovery {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) {
    return { ok: false, why: "anchors.partial.json is not an object" };
  }
  const p = partial as Record<string, any>;
  if ("stop" in p) return { ok: false, why: "anchors.partial.json already has a stop block — it is not a partial" };
  if (!Number.isInteger(p.version) || p.version < 1 || p.version > MAX_PARTIAL_VERSION) {
    return { ok: false, why: `anchors.partial.json version ${String(p.version)} is not one the helper writes` };
  }
  for (const k of REQUIRED) {
    if (p[k] === undefined || p[k] === null) return { ok: false, why: `anchors.partial.json has no ${k}` };
  }
  const frames = media.displayFramesNs;
  if (frames.length === 0) return { ok: false, why: "display.mp4 has no frames" };

  const doc: Record<string, any> = JSON.parse(JSON.stringify(p));
  const files: Record<string, string> = { ...doc.files };

  if (doc.camera?.present === true) {
    const cf = media.cameraFramesNs;
    if (!cf || cf.length === 0) {
      doc.camera = { present: false };
      delete files.camera;
    } else {
      doc.camera = { ...doc.camera, lastFramePtsNs: cf[cf.length - 1],
                     frameIntervalNs: medianDelta(cf) ?? doc.camera.frameIntervalNs };
    }
  }
  if (doc.mic?.present === true) {
    if (media.micLastNs == null) { doc.mic = { present: false }; delete files.mic; }
    else doc.mic = { ...doc.mic, lastFramePtsNs: media.micLastNs };
  }
  if (doc.system?.present === true) {
    if (media.systemLastNs == null) { doc.system = { present: false }; delete files.system; }
    else doc.system = { ...doc.system, lastFramePtsNs: media.systemLastNs };
  }
  doc.files = files;
  doc.stop = { t: frames[frames.length - 1], reason };

  // The minimum version that can express the document, the rule anchorsDocument follows.
  let version: number = doc.version;
  if (reason === "disk-full" || reason === "disk-full-timeout") version = Math.max(version, 10);
  if (reason === RECOVERY_STOP_REASON) version = Math.max(version, 11);
  doc.version = version;
  return { ok: true, anchors: doc as unknown as Anchors };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit transform/test/recover-anchors.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add transform/src/recover-anchors.ts transform/test/recover-anchors.test.ts
git commit -m "STC-530: recoverAnchors turns a helper's partial anchors into a take

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `PartialAnchors.swift` — the file-only helper half

**Files:**
- Create: `helper/src/PartialAnchors.swift`, `helper/test/partial-anchors/main.swift`, `helper/test/partial-anchors.test.ts`

**Interfaces:**
- Produces (Swift):
  ```swift
  let PARTIAL_ANCHORS_FILE = "anchors.partial.json"
  func partialAnchors(_ stopTimeDoc: [String: Any]) -> [String: Any]   // the doc minus "stop"
  func writePartialAnchors(_ doc: [String: Any], in dir: URL) throws     // atomic
  func retirePartialAnchors(in dir: URL)                                 // deletes the partial ONLY if anchors.json exists
  struct PartialWriteCoalescer { mutating func request() -> Bool; mutating func began() }
  ```

- [ ] **Step 1: Write the failing test**

`helper/test/partial-anchors/main.swift`:

```swift
import Foundation

var failures: [String] = []
func check(_ c: Bool, _ what: String) { if !c { failures.append(what) } }

let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160, originX: 0, originY: 0)
let capture = CaptureGeometryDoc(width: 3840, height: 2160, firstFrameNs: 200_000_000)
let full = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display, capture: capture,
                           camera: nil, requested: false, pauses: [],
                           stopReason: "user", stopTNs: 20_000_000_000)

// 1. The partial is the stop-time document minus `stop`, and nothing else.
do {
    let p = partialAnchors(full)
    check(p["stop"] == nil, "partial must carry no stop block")
    var expected = full; expected.removeValue(forKey: "stop")
    let a = try! JSONSerialization.data(withJSONObject: p, options: [.sortedKeys])
    let b = try! JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys])
    check(a == b, "partial must equal the stop-time document minus stop, byte for byte")
}

let tmp = FileManager.default.temporaryDirectory
    .appendingPathComponent("stc-partial-\(ProcessInfo.processInfo.processIdentifier)")
try? FileManager.default.removeItem(at: tmp)
try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
let partialURL = tmp.appendingPathComponent(PARTIAL_ANCHORS_FILE)

// 2. Written whole, readable back, and a rewrite replaces it.
do {
    try writePartialAnchors(partialAnchors(full), in: tmp)
    let back = try JSONSerialization.jsonObject(with: Data(contentsOf: partialURL)) as? [String: Any]
    check(back?["version"] as? Int == 2, "partial must read back")
    var v2 = partialAnchors(full); v2["version"] = 5
    try writePartialAnchors(v2, in: tmp)
    let again = try JSONSerialization.jsonObject(with: Data(contentsOf: partialURL)) as? [String: Any]
    check(again?["version"] as? Int == 5, "a rewrite must replace the partial")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: tmp.path)
    check(leftovers == [PARTIAL_ANCHORS_FILE], "an atomic write must leave no temp file behind: \(leftovers)")
} catch { failures.append("write failed: \(error)") }

// 3. Retire keeps the partial while anchors.json is missing (STC-527's failed write)...
retirePartialAnchors(in: tmp)
check(FileManager.default.fileExists(atPath: partialURL.path),
      "retire must KEEP the partial when anchors.json was not written — it is all recovery has")
// ...and removes it once anchors.json exists.
FileManager.default.createFile(atPath: tmp.appendingPathComponent("anchors.json").path, contents: Data("{}".utf8))
retirePartialAnchors(in: tmp)
check(!FileManager.default.fileExists(atPath: partialURL.path), "retire must remove the partial once anchors.json exists")

// 4. Coalescing (Review Focus 5): a burst of requests schedules ONE write; a request
//    after that write began schedules exactly one more.
do {
    var c = PartialWriteCoalescer()
    check(c.request() == true, "the first request schedules a write")
    for _ in 0..<30 { check(c.request() == false, "a request while one is pending schedules nothing") }
    c.began()
    check(c.request() == true, "a change after the write began needs one more write")
    check(c.request() == false, "and only one")
}

try? FileManager.default.removeItem(at: tmp)
if failures.isEmpty { print("ALL PASS") } else { failures.forEach { print("FAIL: \($0)") }; exit(1) }
```

`helper/test/partial-anchors.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("anchors.partial.json (STC-530)", () => {
  test("partial = stop-time doc minus stop; atomic write; retire only after anchors.json; writes coalesce", async () => {
    const out = await runSwiftHarness({
      label: "partial-anchors",
      sources: [
        "helper/src/StillDecisions.swift",
        "helper/src/PauseDecisions.swift",
        "helper/src/CaptureGeometry.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/src/PartialAnchors.swift",
        "helper/test/partial-anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit helper/test/partial-anchors.test.ts`
Expected: FAIL — compile error, `partialAnchors` not found.

- [ ] **Step 3: Implement**

`helper/src/PartialAnchors.swift`:

```swift
import Foundation

/// STC-530. anchors.json is written only at a clean stop (`writeSidecars`), so a helper
/// that dies mid-take used to leave a playable fragmented display.mp4 (STC-394) and nothing
/// that described it. `anchors.partial.json` is that description, kept current while
/// recording: the stop-time document minus `stop`, built by the SAME `anchorsDocument`
/// so the two cannot drift. The app finishes it (`transform/src/recover-anchors.ts`).
///
/// File-only on purpose: no ScreenCaptureKit, no clock, so CI tests every rule here
/// (helper/test/partial-anchors.test.ts) without a grant.
let PARTIAL_ANCHORS_FILE = "anchors.partial.json"

/// The stop-time document with its `stop` block removed — the one difference.
func partialAnchors(_ stopTimeDoc: [String: Any]) -> [String: Any] {
    var d = stopTimeDoc
    d.removeValue(forKey: "stop")
    return d
}

/// Atomic: `.atomic` writes a temporary file and renames it over the target, so a crash
/// mid-write leaves the previous complete partial or none — never a torn one.
func writePartialAnchors(_ doc: [String: Any], in dir: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])
    try data.write(to: dir.appendingPathComponent(PARTIAL_ANCHORS_FILE), options: .atomic)
}

/// After the stop-time sidecars. Removes the partial ONLY when anchors.json exists: when
/// that write failed (STC-527's full disk), the partial is all the app has to recover from.
func retirePartialAnchors(in dir: URL) {
    let fm = FileManager.default
    guard fm.fileExists(atPath: dir.appendingPathComponent("anchors.json").path) else { return }
    try? fm.removeItem(at: dir.appendingPathComponent(PARTIAL_ANCHORS_FILE))
}

/// At most one partial write pending. A window dragged through a window-scope take
/// appends to the window track at 30 Hz (STC-482); without this every append would
/// queue its own write. A value, so "a burst is one write" is a test, not a hope about
/// queue scheduling — the `SettleDebounce` precedent (DisplayChangeDecisions.swift).
struct PartialWriteCoalescer {
    private var pending = false
    /// A change happened. True = schedule a write; false = one is already pending and will see it.
    mutating func request() -> Bool {
        if pending { return false }
        pending = true
        return true
    }
    /// The pending write has started building its document: a change from here on needs another.
    mutating func began() { pending = false }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit helper/test/partial-anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helper/src/PartialAnchors.swift helper/test/partial-anchors helper/test/partial-anchors.test.ts
git commit -m "STC-530: anchors.partial.json's file rules, tested without a grant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `CaptureSession` keeps the partial current

**Files:**
- Modify: `helper/src/CameraCapture.swift` (sample handler ~line 330, `track()` ~line 374), `helper/src/MicCapture.swift` (~344, ~387), `helper/src/SystemAudioCapture.swift` (~208, ~270), `helper/src/Capture.swift` (first frame ~1826, refit ~1837, window track ~732/752, `pause()` ~2224, `resume()` ~2272, `writeSidecars` ~2551, `write(_:to:)` ~2613, subsystem construction ~1045/1101/1249), `helper/build.sh` (only if it lists sources explicitly — check)
- Create: `helper/test/crash-partial.grant.test.ts`
- Modify: `vitest.screencapturekit-files.ts`

**Interfaces:**
- Consumes: Task 3's `partialAnchors`, `writePartialAnchors`, `retirePartialAnchors`, `PartialWriteCoalescer`.
- Produces: a real take directory holds `anchors.partial.json` from its first frame until `anchors.json` is written; `STC_CAPTURE_FAULT=anchors-write-failed`.

- [ ] **Step 1: Subsystems announce their first append and expose their track**

In each of `CameraCapture`, `MicCapture`, `SystemAudioCapture`:

1. Add a stored property next to `firstPtsNs`:
   ```swift
   /// STC-530: called once, off the lock, when the first sample lands in the file —
   /// the moment this track's start time exists for `anchors.partial.json`. Set before
   /// `start()`; never changed after.
   var onFirstAppend: (() -> Void)?
   ```
2. In the sample handler's success block, replace
   ```swift
   lock.lock()
   if firstPtsNs < 0 { firstPtsNs = rel }
   ```
   with
   ```swift
   lock.lock()
   let first = firstPtsNs < 0
   if first { firstPtsNs = rel }
   ```
   and after that block's `lock.unlock()` add `if first { onFirstAppend?() }`. (Camera has a `deltas.append` line in the same block — keep it.)
3. Change `private func track()` to `func track()` and add above it: `/// Also read live by CaptureSession for anchors.partial.json (STC-530); takes the lock.`

- [ ] **Step 2: `CaptureSession` builds the stop-time document in one place**

In `Capture.swift`, add next to `stoppingBegan`:

```swift
    /// STC-530: anchors.partial.json. Its own serial queue — the capture callbacks only
    /// REQUEST a write (`notePartialChange`), never perform one, the rule `IO.stat`
    /// follows: nothing here may back-pressure the capture graph.
    private let partialQueue = DispatchQueue(label: "stc.partial-anchors")
    private var partialCoalescer = PartialWriteCoalescer()   // guarded by `lock`
    private var partialRetired = false                       // touched only on partialQueue
```

Extract the document-building half of `writeSidecars` into a function both paths call. Replace the section of `writeSidecars` from `lock.lock()` through the `let doc = anchorsDocument(...)` call with a call to this new function, keeping the `releaseSidecarReserve()`, events write, and `pauseGate.close(atNs:)` exactly where they are:

```swift
    /// The anchors document as of now. `writeSidecars` calls it with the real stop; the
    /// partial calls it with a placeholder stop that `partialAnchors` removes. One builder,
    /// so the partial and anchors.json cannot disagree about anything but `stop`.
    /// A subsystem still running has no track yet (that is set at its stop); its LIVE
    /// track is read instead.
    private func currentAnchorsDocument(stopReason: String, stopTNs: Int) -> [String: Any] {
        lock.lock()
        let camTrack = cameraTrack ?? camera?.track()
        let micT = micTrack ?? mic?.track()
        let sysT = systemAudioTrack ?? systemAudio?.track()
        let geo = geometry
        let track = windowTrack
        let startDisplay = geo.first?.display ?? currentDisplayGeometry()
        let firstFrameNs = firstFramePtsNs
        lock.unlock()
        return anchorsDocument(
            timebase: (Int(Clock.timebase.numer), Int(Clock.timebase.denom)),
            t0Ns: t0Ns,
            display: startDisplay,
            capture: CaptureGeometryDoc(width: captureW, height: captureH, firstFrameNs: Int(firstFrameNs)),
            camera: camTrack, requested: wantCamera,
            mic: micT, micRequested: wantMicUid != nil,
            systemAudio: sysT, systemAudioRequested: wantSystemAudio,
            scope: captureScope, geometry: geo, windowTrack: track,
            pauses: pauseGate.intervals,
            colorSpace: anchorsColorSpace(captureColour),
            stopReason: stopReason, stopTNs: stopTNs)
    }
```

Keep the existing STC-235 comment (top-level `display` is entry 0's) above the `startDisplay` line. **Check before moving:** `camera?.track()` etc. take the subsystem's own lock while `CaptureSession.lock` is held. Grep each subsystem for any path that holds its own lock and then calls back into `CaptureSession` (e.g. `onStreamDied`, `onFirstAppend`); `onFirstAppend` is called after `unlock()` (Step 1), so it does not. If any such path exists, read the tracks after `lock.unlock()` instead.

`writeSidecars` then reads:

```swift
    private func writeSidecars(reason: String) {
        releaseSidecarReserve()
        lock.lock()
        let evs = events
        lock.unlock()
        let ordered = orderedEvents(evs)
        let hasKeys = ordered.contains { ($0["kind"] as? String) == "key" }
        write(["version": hasKeys ? 3 : 2, "events": ordered] as [String: Any], to: "events.json")
        let stopTNs = Int64(Clock.nowNs() - t0Ns)
        pauseGate.close(atNs: stopTNs)
        let doc = currentAnchorsDocument(stopReason: reason, stopTNs: Int(stopTNs))
        write(doc, to: "anchors.json")
        // STC-530: on the partial's own queue, so a write already queued cannot land
        // after this and leave a stale partial beside a finished take.
        partialQueue.sync {
            partialRetired = true
            retirePartialAnchors(in: dir)
        }
    }
```

(Keep every existing comment in `writeSidecars` — the events-2/events-3 one and the "Exact, from the helper's own clock" one — beside the lines they describe.)

- [ ] **Step 3: The write path and its triggers**

Add:

```swift
    /// Something `anchors.partial.json` describes changed (STC-530). Cheap and lock-safe
    /// from any thread EXCEPT while holding `lock` — callers release it first.
    private func notePartialChange() {
        lock.lock()
        let schedule = !stoppingBegan && firstFramePtsNs >= 0 && partialCoalescer.request()
        lock.unlock()
        guard schedule else { return }
        partialQueue.async { [weak self] in
            guard let self, !self.partialRetired else { return }
            self.lock.lock()
            self.partialCoalescer.began()
            let stopping = self.stoppingBegan
            self.lock.unlock()
            if stopping { return }
            let doc = partialAnchors(self.currentAnchorsDocument(stopReason: "user", stopTNs: 0))
            do { try writePartialAnchors(doc, in: self.dir) }
            catch { IO.log("anchors.partial.json could not be written (\(error)); a crash now loses this take's description") }
        }
    }
```

`firstFramePtsNs >= 0` makes the first display frame the first write (before it there is no geometry entry 0). Call `notePartialChange()` — always AFTER the surrounding `lock.unlock()`, never inside it:

1. **First display frame** (~line 1826 block): after the `lock.unlock()` that ends the block containing `if firstFramePtsNs < 0 { firstFramePtsNs = pts }`, add a local `let wasFirst = firstFramePtsNs < 0` captured BEFORE that assignment (inside the lock), then `if wasFirst || landed != nil { notePartialChange() }` after the unlock. `landed != nil` covers the refit append in the same block.
2. **Window track:** both `windowTrack.append` sites (~732 fault path, ~752 timer). The timer uses `defer { self.lock.unlock() }` — restructure so the append records `appended = true` and the call happens after the lock is released:
   ```swift
   self.lock.lock()
   var appended = false
   if let last = self.windowTrack.last,
      shouldRecordWindowOrigin(last: (last.x, last.y), current: current), let c = current {
       self.windowTrack.append(WindowTrackEntryDoc(tNs: Int(now - self.t0Ns), x: c.x, y: c.y))
       appended = true
   }
   self.lock.unlock()
   if appended { self.notePartialChange() }
   ```
   For the fault path, add `self.notePartialChange()` after its `self.lock.unlock()`.
3. **Pause / resume:** in `pause()` after `recordHeldButtonReleases(atNs: tNs)`, and in `resume()` inside `if changed { … }`, add `notePartialChange()`. (Resume matters: it closes an interval. Pause is harmless and keeps the rule "every change".)
4. **Subsystem first sample:** at each construction site, before `start()`:
   - camera (~1045): `cam.onFirstAppend = { [weak self] in self?.notePartialChange() }`
   - mic (~1101): `m.onFirstAppend = { [weak self] in self?.notePartialChange() }`
   - system audio (~1249, inside the lock, before `lock.unlock()` is fine since it is only an assignment): `a.onFirstAppend = { [weak self] in self?.notePartialChange() }`

- [ ] **Step 4: The `anchors-write-failed` fault**

In `write(_ o: Any, to name: String)`, before the `do { try d.write… }`:

```swift
        // STC-530: STC-527's worst case on demand — every sidecar written except anchors.json,
        // so the take must be recovered from anchors.partial.json. The real trigger is a disk
        // that fills in the 8 MiB gap the reserve leaves, which no test can schedule.
        if name == "anchors.json", ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "anchors-write-failed" {
            IO.send("warning", ["code": "sidecar-write-failed", "file": name, "detail": "injected by STC_CAPTURE_FAULT=anchors-write-failed"])
            return
        }
```

- [ ] **Step 5: Build, smoke, and run the pure + IPC suites**

```bash
grep -n "\.swift" helper/build.sh | head   # if build.sh lists sources, add helper/src/PartialAnchors.swift
helper/build.sh
echo '{"cmd":"status"}' | helper/build/stc-helper
npx vitest run --project unit helper/test
```

Expected: the build signs cleanly; `status` prints ready → status → bye; all helper unit tests pass (including `anchors.test.ts`, `stop-reasons.test.ts`, `partial-anchors.test.ts`). `anchors.test.ts` must still pass unchanged — it is the evidence that extracting `currentAnchorsDocument` changed no output.

- [ ] **Step 6: The kill -9 grant test**

`helper/test/crash-partial.grant.test.ts` — model it on an existing capture grant test that starts a real take through the real binary. Read `helper/test/stream-died.grant.test.ts` (or `capture.grant.test.ts`) first and reuse its spawn/start helpers verbatim (`_start-outcome.ts` and whatever it imports); do not write a second spawner. The test body:

```ts
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// + the same spawn/start helpers stream-died.grant.test.ts uses

describe("a take the helper dies in keeps its description (STC-530)", () => {
  test("SIGKILL mid-take leaves anchors.partial.json that recovers to a loadable take", async () => {
    // start a whole-display take into a fresh temp dir (existing helper), wait 3000 ms
    // const killedAtNs = <helper's own elapsed at kill, from the last stats line's elapsedMs * 1e6>
    // child.kill("SIGKILL"); await its exit
    const partialPath = join(dir, "anchors.partial.json");
    expect(existsSync(partialPath)).toBe(true);
    expect(existsSync(join(dir, "anchors.json"))).toBe(false);
    const r = await recoverTake(dir, "recorder-quit");   // from app/src/recover-take.ts (Task 5)
    expect(r, JSON.stringify(r)).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.version).toBe(11);
    expect(a.stop.reason).toBe("recorder-quit");
    // fragmented interval is ~1-2 s: the recovered end is within 2.5 s of the kill
    expect(killedAtNs - a.stop.t).toBeLessThan(2_500_000_000);
    expect(existsSync(partialPath)).toBe(false);
  }, 60_000);

  test("anchors-write-failed: a clean stop with no anchors.json keeps the partial", async () => {
    // same start with env STC_CAPTURE_FAULT=anchors-write-failed, wait 2000 ms, send stop, await reply
    expect(existsSync(join(dir, "anchors.json"))).toBe(false);
    expect(existsSync(join(dir, "events.json"))).toBe(true);
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(true);
  }, 60_000);

  test("CONTROL: a clean stop leaves anchors.json and no partial", async () => {
    // same start, no fault, stop
    expect(existsSync(join(dir, "anchors.json"))).toBe(true);
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(false);
  }, 60_000);
});
```

The commented lines are the parts to fill in from `stream-died.grant.test.ts`'s own helpers — that file is the pattern, and its helper names are what to use. The first test depends on Task 5; write this file now and run it after Task 5.

Add `"helper/test/crash-partial.grant.test.ts"` to the list in `vitest.screencapturekit-files.ts` (it sends `start`; `app/test/screencapturekit-serial.test.ts` fails until it is listed).

- [ ] **Step 7: Commit**

```bash
git add helper/src vitest.screencapturekit-files.ts helper/test/crash-partial.grant.test.ts
git commit -m "STC-530: the helper keeps anchors.partial.json current while recording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `recoverTake` — the I/O half

**Files:**
- Create: `app/src/recover-take.ts`, `app/test/recover-take.test.ts`

**Interfaces:**
- Consumes: `recoverAnchors`, `PARTIAL_ANCHORS_FILE` (Task 2); `loadSession`, `rebaseMicAudio` (`@transform/session.js`); `demuxTrack` (`@transform/demux.js`); `demuxAudioTrack` (`@transform/demux-audio.js`); `ByteSource` (`@transform/chunk-reader.js`).
- Produces:
  ```ts
  export type TakeRecovery = { ok: true } | { ok: false; why: string };
  export async function recoverTake(dir: string, reason: string): Promise<TakeRecovery>;
  export async function hasPartialAnchors(dir: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing test**

`app/test/recover-take.test.ts` — uses `fixtures/basic` (a real `display.mp4`, `firstFrameNs: 0`):

```ts
import { describe, test, expect } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTake, hasPartialAnchors } from "../src/recover-take.js";

const root = join(__dirname, "..", "..");
const fixture = join(root, "fixtures/basic");

/** A take as the helper leaves it after a kill: display.mp4, a partial, no anchors.json. */
function crashedTake(opts: { events?: boolean; partial?: unknown; noVideo?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "stc-recover-"));
  if (!opts.noVideo) cpSync(join(fixture, "display.mp4"), join(dir, "display.mp4"));
  if (opts.events) cpSync(join(fixture, "events.json"), join(dir, "events.json"));
  const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
  delete a.stop;
  writeFileSync(join(dir, "anchors.partial.json"), JSON.stringify(opts.partial ?? { ...a, version: 2 }));
  return dir;
}

describe("recoverTake (STC-530)", () => {
  test("a crashed take becomes a loadable v11 take, and the partial is gone", async () => {
    const dir = crashedTake();
    expect(await hasPartialAnchors(dir)).toBe(true);
    expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.version).toBe(11);
    expect(a.stop.reason).toBe("recorder-quit");
    expect(a.stop.t).toBeGreaterThan(4_000_000_000);   // fixtures/basic is a 5 s take
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(false);
    expect(await hasPartialAnchors(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("disk full with events.json written: reason kept, events untouched (Review Focus 4)", async () => {
    const dir = crashedTake({ events: true });
    const before = readFileSync(join(dir, "events.json"));
    expect(await recoverTake(dir, "disk-full")).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.stop.reason).toBe("disk-full");
    expect(a.version).toBe(10);
    expect(readFileSync(join(dir, "events.json")).equals(before)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("never overwrites an existing anchors.json (Review Focus 3)", async () => {
    const dir = crashedTake();
    writeFileSync(join(dir, "anchors.json"), "ORIGINAL");
    const r = await recoverTake(dir, "recorder-quit");
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, "anchors.json"), "utf8")).toBe("ORIGINAL");
    rmSync(dir, { recursive: true });
  });

  test("no partial, no video, or a video with no frames: not recoverable, and nothing is deleted (Review Focus 1)", async () => {
    const noPartial = mkdtempSync(join(tmpdir(), "stc-recover-"));
    cpSync(join(fixture, "display.mp4"), join(noPartial, "display.mp4"));
    expect((await recoverTake(noPartial, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(noPartial, "display.mp4"))).toBe(true);

    const noVideo = crashedTake({ noVideo: true });
    expect((await recoverTake(noVideo, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(noVideo, "anchors.partial.json"))).toBe(true);

    const garbage = crashedTake();
    writeFileSync(join(garbage, "display.mp4"), Buffer.alloc(4096, 7));
    expect((await recoverTake(garbage, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(garbage, "anchors.partial.json"))).toBe(true);
    expect(existsSync(join(garbage, "anchors.json"))).toBe(false);
    for (const d of [noPartial, noVideo, garbage]) rmSync(d, { recursive: true });
  });

  test("a camera the partial claims but whose file is missing is dropped, the take recovers (Review Focus 2)", async () => {
    const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
    delete a.stop;
    const dir = crashedTake({ partial: {
      ...a, version: 2, files: { display: "display.mp4", camera: "camera.mp4" },
      camera: { present: true, device: "Cam", width: 1280, height: 720,
                firstFramePtsNs: 100_000_000, lastFramePtsNs: 100_000_000, frameIntervalNs: 33_333_333 },
    } });
    expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
    const out = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(out.camera).toEqual({ present: false });
    expect(out.files.camera).toBeUndefined();
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit app/test/recover-take.test.ts`
Expected: FAIL — cannot find module `../src/recover-take.js`.

- [ ] **Step 3: Implement**

`app/src/recover-take.ts`:

```ts
/**
 * A take the recorder quit on, made openable (STC-530) — the I/O half of
 * `transform/src/recover-anchors.ts`.
 *
 * ONE path for both ways such a take reaches the app: the live `recording-lost` (the helper
 * died mid-take) and launch-time recovery (STC-393, a previous run left one behind) — plus
 * STC-527's full disk, where the helper stopped cleanly but could not write anchors.json.
 *
 * Reads `anchors.partial.json`, reads where each media file actually ENDS (the demux
 * already handles a fragmented file cut off mid-write, STC-394), builds the document, and
 * runs it through `loadSession` — the editor's own loader — before writing anything, so a
 * take this calls recovered is one the editor can open. Never overwrites an anchors.json,
 * never deletes a media file, never deletes the take: a failure leaves the directory
 * exactly as it was, for launch recovery to offer.
 *
 * Video is read by RANGE (box headers and the sample index), never whole — a take can be
 * gigabytes. Audio is read whole, as `session-io.ts` already does.
 */
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demuxTrack } from "@transform/demux.js";
import { demuxAudioTrack } from "@transform/demux-audio.js";
import { loadSession, rebaseMicAudio } from "@transform/session.js";
import type { ByteSource } from "@transform/chunk-reader.js";
import { PARTIAL_ANCHORS_FILE, recoverAnchors, type RecoveredMedia } from "@transform/recover-anchors.js";

export type TakeRecovery = { ok: true } | { ok: false; why: string };

/** A ranged reader over one file on disk. */
async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, "r");
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new Error(`${path}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`);
      }
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new Error(`${path}: short read (${bytesRead} of ${length})`);
      return buf;
    },
    close: () => fh.close(),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await (await open(path, "r")).close(); return true; } catch { return false; }
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function hasPartialAnchors(dir: string): Promise<boolean> {
  return (await exists(join(dir, PARTIAL_ANCHORS_FILE))) && !(await exists(join(dir, "anchors.json")));
}

/** A track's frames, or null when its file is missing or yields nothing — `recoverAnchors` drops it then. */
async function videoFrames(path: string, what: string): Promise<number[] | null> {
  let src: Awaited<ReturnType<typeof fileSource>> | undefined;
  try {
    src = await fileSource(path);
    const v = await demuxTrack(src, what);
    return v.framesNs.length > 0 ? v.framesNs : null;
  } catch (e) {
    console.error(`[recover] ${what} yielded no frames:`, (e as Error).message);
    return null;
  } finally {
    await src?.close().catch(() => {});
  }
}

async function audioLastNs(path: string, what: string, firstNs: number): Promise<number | null> {
  try {
    const raw = await demuxAudioTrack(toArrayBuffer(await readFile(path)), what);
    if (raw.framesNs.length === 0) return null;
    return rebaseMicAudio(raw, firstNs).framesNs.at(-1)!;
  } catch (e) {
    console.error(`[recover] ${what} yielded no samples:`, (e as Error).message);
    return null;
  }
}

export async function recoverTake(dir: string, reason: string): Promise<TakeRecovery> {
  if (await exists(join(dir, "anchors.json"))) {
    return { ok: false, why: "anchors.json already exists — this take is not one to recover" };
  }
  let partial: any;
  try {
    partial = JSON.parse(await readFile(join(dir, PARTIAL_ANCHORS_FILE), "utf8"));
  } catch (e) {
    return { ok: false, why: `no readable ${PARTIAL_ANCHORS_FILE}: ${(e as Error).message}` };
  }
  const files = (partial && typeof partial === "object" && partial.files) || {};

  const display = await videoFrames(join(dir, files.display ?? "display.mp4"), "display.mp4");
  const media: RecoveredMedia = { displayFramesNs: display ?? [] };
  if (partial?.camera?.present === true) {
    media.cameraFramesNs = files.camera ? await videoFrames(join(dir, files.camera), "camera.mp4") : null;
  }
  if (partial?.mic?.present === true) {
    media.micLastNs = files.mic ? await audioLastNs(join(dir, files.mic), "mic.m4a", partial.mic.firstFramePtsNs) : null;
  }
  if (partial?.system?.present === true) {
    media.systemLastNs = files.system ? await audioLastNs(join(dir, files.system), "system.m4a", partial.system.firstFramePtsNs) : null;
  }

  const r = recoverAnchors(partial, media, reason);
  if (!r.ok) return r;
  const anchors = r.anchors as any;

  // The editor's own loader, before anything is written: recovered means openable.
  let events: unknown = { version: 1, events: [] };
  try { events = JSON.parse(await readFile(join(dir, "events.json"), "utf8")); } catch { /* none: no cursor */ }
  const sources: Awaited<ReturnType<typeof fileSource>>[] = [];
  try {
    const displayMp4 = await fileSource(join(dir, anchors.files.display));
    sources.push(displayMp4);
    const cameraMp4 = anchors.files.camera ? await fileSource(join(dir, anchors.files.camera)) : undefined;
    if (cameraMp4) sources.push(cameraMp4);
    const micM4a = anchors.files.mic ? toArrayBuffer(await readFile(join(dir, anchors.files.mic))) : undefined;
    const systemM4a = anchors.files.system ? toArrayBuffer(await readFile(join(dir, anchors.files.system))) : undefined;
    await loadSession({ anchors, events: events as any, displayMp4, cameraMp4, micM4a, systemM4a });
  } catch (e) {
    return { ok: false, why: `the rebuilt take does not load: ${(e as Error).message}` };
  } finally {
    for (const s of sources) await s.close().catch(() => {});
  }

  try {
    // `wx`: if anything wrote anchors.json since the check above, it wins.
    await writeFile(join(dir, "anchors.json"), JSON.stringify(anchors), { flag: "wx" });
  } catch (e) {
    return { ok: false, why: `could not write anchors.json: ${(e as Error).message}` };
  }
  await rm(join(dir, PARTIAL_ANCHORS_FILE), { force: true }).catch(() => {});
  return { ok: true };
}
```

If `SessionInput`'s field types differ from what is passed (check `transform/src/session.ts:24-36`), adapt the call — do not cast around a real mismatch.

- [ ] **Step 4: Run it to verify it passes; typecheck**

Run: `npx vitest run --project unit app/test/recover-take.test.ts && npm run typecheck`
Expected: PASS, and the node pass accepts `@transform/session.js` (Task 1's `capture-colour.ts` change). If the node pass reports another DOM type somewhere in the import chain, fix it the same way (spell out the type) and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add app/src/recover-take.ts app/test/recover-take.test.ts
git commit -m "STC-530: recoverTake rebuilds anchors.json from the partial and the media

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The reason/note seam — `stop-copy.ts`, the panel line, the library note

**Files:**
- Create: `app/src/stop-copy.ts`, `app/test/stop-copy.test.ts`
- Modify: `app/src/thumbnail-window.ts:111` (`PresentOptions.recording`), `app/src/thumbnail-renderer.ts:146-152`, `app/renderer/thumbnail.html:~66,~143`, `app/src/main.ts` (`presentRecordingPanel`), `app/src/library-items.ts` (`TakeInfo`, `recordingItem`), `app/src/library.ts` (~797)
- Test: `app/test/stop-copy.test.ts`, an added case in the existing test file that covers `recordingItem` (find it: `grep -ln "recordingItem" app/test/*.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export type StopBlock = { t?: number; reason?: string } | undefined;
  export function panelReason(stop: StopBlock): string | undefined;
  export function libraryNote(stop: StopBlock): string | undefined;
  ```
  `PresentOptions.recording?: { durationMs: number; scope: string; reason?: string }`; `TakeInfo.stop?: { t: number; reason: string }`.

- [ ] **Step 1: Write the failing tests**

`app/test/stop-copy.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { panelReason, libraryNote } from "../src/stop-copy.js";

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
});
```

(If `anyOf` is not where the enum lives in the schema, read the schema's `stop.properties.reason` and adjust the path — the point is reading the list, not hard-coding it.)

In the test file that covers `recordingItem`, add (using that file's own `TakeInfo` fixture builder):

```ts
  test("a recovered recording carries the library note (STC-530)", () => {
    const item = recordingItem({ ...aTake(), stop: { t: 4_000_000_000, reason: "recorder-quit" } });
    expect(item.notes).toContain("Recovered after the recorder quit. No cursor data.");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit app/test/stop-copy.test.ts <the recordingItem test file>`
Expected: FAIL — module not found; note missing.

- [ ] **Step 3: Implement**

`app/src/stop-copy.ts`:

```ts
/**
 * What a take's stop says to a person, on the panel and in the library (STC-505's copy
 * table). ONE mapping from `anchors.stop` to words, so the panel and the library cannot
 * describe the same stop two ways.
 *
 * STC-530 fills in one reason, `recorder-quit`. Every other reason returns `undefined`
 * here ON PURPOSE: STC-529 (library notes for an early stop) and STC-531 (the panel's
 * reason line) add their rows to these two functions rather than a second path.
 * `app/test/stop-copy.test.ts` walks every reason in the schema, so a row added here is
 * tested the moment it exists.
 *
 * Pure and node-free: `library-items.ts` (which the renderer typecheck pass follows)
 * imports it.
 */
export type StopBlock = { t?: number; reason?: string } | undefined;

export function panelReason(stop: StopBlock): string | undefined {
  switch (stop?.reason) {
    case "recorder-quit":
      return "Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.";
    default:
      return undefined;
  }
}

export function libraryNote(stop: StopBlock): string | undefined {
  switch (stop?.reason) {
    case "recorder-quit":
      return "Recovered after the recorder quit. No cursor data.";
    default:
      return undefined;
  }
}
```

`app/src/library-items.ts`:
- `import { libraryNote } from "./stop-copy.js";`
- In `TakeInfo`, after `camera?`: 
  ```ts
  /** How the take stopped, when anchors.json says (STC-530). Read for the library note; STC-529 extends it. */
  stop?: { t: number; reason: string };
  ```
- In `recordingItem`, after the camera block: `const stopNote = libraryNote(t.stop); if (stopNote) notes.push(stopNote);`

`app/src/library.ts` in the `out.push({...})` of the recording reader (~797), after `camera: cameraSummary(anchors),`:
```ts
    stop: typeof anchors.stop?.reason === "string" && Number.isInteger(anchors.stop?.t)
      ? { t: anchors.stop.t, reason: anchors.stop.reason } : undefined,
```

`app/src/thumbnail-window.ts:111`:
```ts
  recording?: { durationMs: number; scope: string; reason?: string };
```
(It already travels as `JSON.stringify(opts.recording ?? null)`; nothing else in this file changes.)

`app/src/main.ts` `presentRecordingPanel`: change the local to `let recording: { durationMs: number; scope: string; reason?: string } = { durationMs: 0, scope: "Screen" };` and inside the `try` after parsing:
```ts
    recording = { durationMs: recordingDurationMs(anchors), scope: recordingScopeLabel(anchors),
                  reason: panelReason(anchors.stop) };
```
with `import { panelReason } from "./stop-copy.js";`.

`app/renderer/thumbnail.html`: next to `#takemeta`'s rule add `#takereason { margin-top: 4px; }` and `#takereason:empty { display: none; }`; after `<div id="takemeta"></div>` add `<div id="takereason"></div>`.

`app/src/thumbnail-renderer.ts` (~150): widen the parsed type to `{ durationMs: number; scope: string; reason?: string } | null` and after the `takemeta` line add:
```ts
  // STC-530: why this take stopped, when it was not a plain stop. Empty otherwise (hidden by CSS).
  ($("takereason") as HTMLElement).textContent = rec?.reason ?? "";
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run --project unit app/test/stop-copy.test.ts app/test/library-seam.test.ts <the recordingItem test file> && npm run typecheck`
Expected: PASS (`library-seam.test.ts` confirms no view branches on kind).

- [ ] **Step 5: Commit**

```bash
git add app/src/stop-copy.ts app/test/stop-copy.test.ts app/src/library-items.ts app/src/library.ts app/src/thumbnail-window.ts app/src/thumbnail-renderer.ts app/renderer/thumbnail.html app/src/main.ts app/test
git commit -m "STC-530: one mapping from a take's stop to the panel line and library note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire it — the live crash, the failed sidecar, and launch recovery

**Files:**
- Modify: `app/src/temp-takes.ts` (`TempTakeInfo.kind`, `listTempTakes`), `app/src/main.ts` (`startSupervisor` ~592, `onTakeEnded` ~760, `recoverUnsavedTakes` ~782), `app/src/renderer.ts:727-730`
- Test: `app/test/temp-takes.test.ts`

**Interfaces:**
- Consumes: `recoverTake`, `hasPartialAnchors` (Task 5); `RECOVERY_STOP_REASON`, `PARTIAL_ANCHORS_FILE` (Task 2); `presentRecordingPanel` (with reason, Task 6).
- Produces: `TempTakeInfo.kind` gains `"partial"`; `helper:recording-lost` payload gains `recovered: boolean`.

- [ ] **Step 1: Write the failing test**

In `app/test/temp-takes.test.ts`, alongside the existing `listTempTakes` classification tests (reuse that file's own temp-root setup):

```ts
  test("a take with anchors.partial.json and no anchors.json is `partial` (STC-530)", async () => {
    const dir = join(tempRoot, "2026-10-13_10-00-00");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "display.mp4"), Buffer.alloc(4096, 7));
    writeFileSync(join(dir, "anchors.partial.json"), "{}");
    expect((await listTempTakes(env)).find((t) => t.dir === dir)?.kind).toBe("partial");
  });

  test("a partial left beside a finished anchors.json is a plain recording (Review Focus 3)", async () => {
    const dir = join(tempRoot, "2026-10-13_10-00-01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "anchors.json"), "{}");
    writeFileSync(join(dir, "anchors.partial.json"), "{}");
    expect((await listTempTakes(env)).find((t) => t.dir === dir)?.kind).toBe("recording");
  });
```

(Use the file's actual names for the temp root and env — read its setup first.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit app/test/temp-takes.test.ts`
Expected: FAIL — kind is `unknown`.

- [ ] **Step 3: Classify `partial`**

`app/src/temp-takes.ts`: `kind: "still" | "recording" | "partial" | "unknown" | "empty";` and add to the doc comment, after the `unknown` paragraph:

```
   * `partial` (STC-530) is the same crash, from a helper new enough to have kept
   * `anchors.partial.json` current while recording: `recoverTake` (recover-take.ts) can turn it
   * into a recording. `anchors.json` wins over it — a partial left beside a finished take is a
   * write that raced the stop, not a take to recover.
```

In `listTempTakes`:
```ts
    const kind = names.includes("shot.json") ? "still"
               : names.includes("anchors.json") ? "recording"
               : names.includes(PARTIAL_ANCHORS_FILE) ? "partial"
               : await hasContent(dir, names) ? "unknown" : "empty";
```
with `import { PARTIAL_ANCHORS_FILE } from "@transform/recover-anchors.js";` (if `temp-takes.ts` does not already import from `@transform`, check the node pass accepts it — `recover-anchors.ts` imports only a type).

Run the test: PASS.

- [ ] **Step 4: Launch recovery finalises partials first**

In `recoverUnsavedTakes`, after the `empty` removal loop and before `const orphaned = …`, finalise every `partial` so the rest of the function — the count, the dialog, the per-kind loop — sees ordinary kinds:

```ts
    // STC-530: a take the helper died in, from a helper that kept anchors.partial.json.
    // Finished BEFORE counting, so the prompt and Review treat it as the recording it now is;
    // one that cannot be finished is exactly the `unknown` take this code already reveals.
    for (const t of found) {
      if (t.kind !== "partial") continue;
      const r = await recoverTake(t.dir, RECOVERY_STOP_REASON);
      if (r.ok) t.kind = "recording";
      else { console.error("[recovery] could not finish a crashed take:", t.dir, r.why); t.kind = "unknown"; }
    }
```

(`TempTakeInfo.kind` must be mutable for this — it is a plain interface field, so it is. Imports: `recoverTake` from `./recover-take.js`, `RECOVERY_STOP_REASON` from `@transform/recover-anchors.js`.)

- [ ] **Step 5: The live crash**

In `startSupervisor`, replace the two `recording-lost` handlers

```ts
  sup.on("recording-lost", (i) => send("helper:recording-lost", i));
  sup.on("recording-lost", () => showThumbnailsAfterCapture());
```

with one:

```ts
  // The helper died mid-take (STC-530). Since the helper keeps anchors.partial.json current,
  // what it wrote up to ~2 s before can be finished into an ordinary take and put up as its
  // panel — the same panel a clean stop gets. The renderer is told which happened: a
  // recovered take needs no toast (the panel carries the reason), one that could not be
  // recovered is left in temp storage, untouched, for launch recovery to offer.
  sup.on("recording-lost", (i) => { void onRecordingLost(i); });
```

and add next to `onTakeEnded`:

```ts
/**
 * The helper died mid-take (`HelperSupervisor`'s `recording-lost`, which carries the take's
 * temp `dir`). Panels hidden for the take come back first either way (STC-487). Quitting does
 * not present, the same rule as `onTakeEnded`: the take stays for next launch's recovery.
 */
async function onRecordingLost(i: { dir?: unknown } & Record<string, unknown>): Promise<void> {
  showThumbnailsAfterCapture();
  let recovered = false;
  if (typeof i.dir === "string" && !quitting) {
    const r = await recoverTake(i.dir, RECOVERY_STOP_REASON);
    if (r.ok) recovered = await presentRecordingPanel(i.dir, "fresh");
    else console.error("[recording-lost] could not recover the take:", i.dir, r.why);
  }
  send("helper:recording-lost", { ...i, recovered });
}
```

(Match `sup.on`'s actual payload type for `recording-lost` from `supervisor.ts:274` instead of the loose record type if it is exported.)

- [ ] **Step 6: A clean stop whose anchors.json failed**

In `onTakeEnded`, change the signature to receive the event and recover before presenting:

```ts
  sup.on("take-ended", (i) => { void onTakeEnded(i?.dir, i?.reason); });
```

```ts
async function onTakeEnded(dir: unknown, reason?: unknown): Promise<void> {
  if (typeof dir !== "string") return;
  if (quitting) return;
  showThumbnailsAfterCapture();
  // STC-527's worst case (STC-530): the helper stopped cleanly but anchors.json could not be
  // written. Its partial still describes the take; finish it with the reason the helper gave
  // (`stopped` is the app's own word for a stop it asked for, which the take records as `user`).
  if (await hasPartialAnchors(dir)) {
    const why = typeof reason === "string" && reason !== "stopped" ? reason : "user";
    const r = await recoverTake(dir, why);
    if (!r.ok) console.error("[take-ended] anchors.json is missing and the take could not be finished:", dir, r.why);
  }
  await presentRecordingPanel(dir, "fresh");
}
```

Keep the existing doc comment and the ordering comment about `showThumbnailsAfterCapture()`.

- [ ] **Step 7: The renderer's toast**

`app/src/renderer.ts:727`:

```ts
recorder.on("helper:recording-lost", (i) => {
  applyRecordingState(false);
  // STC-530: a recovered take is up as its own panel, with the reason on it — no toast
  // (STC-505: toasts are for events with no take to attach to). One that could not be
  // recovered is still on disk, untouched, and the next launch offers it.
  if (!i.recovered) alertUser("The recorder quit while recording, and the take couldn't be recovered.");
});
```

If `i` is typed (check `preload.ts`'s channel typing), add `recovered?: boolean` to that type.

- [ ] **Step 8: Run the unit suite and typecheck**

Run: `npx vitest run --project unit && npm run typecheck`
Expected: PASS. (Do NOT run the e2e project locally.)

- [ ] **Step 9: Commit**

```bash
git add app/src/temp-takes.ts app/src/main.ts app/src/renderer.ts app/src/preload.ts app/test/temp-takes.test.ts
git commit -m "STC-530: a take the recorder quit on reaches the panel, live and at launch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The fake helper can die mid-take; e2e

**Files:**
- Modify: `app/test/_fake-helper.mjs` (the `start` case, ~line 114), `app/test/crash-recovery.e2e.test.ts`
- Create: `app/test/recording-lost.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces: `STC_FAKE_DIE_MS=<ms>` — after `started`, the fake writes a real `display.mp4` and `anchors.partial.json` (from `fixtures/basic`) into the take dir and SIGKILLs itself after `<ms>`. `STC_FAKE_DIE_NO_PARTIAL=1` — dies the same way but writes nothing.

- [ ] **Step 1: The fake helper hook**

In `_fake-helper.mjs`, import `copyFileSync, readFileSync` and `fileURLToPath`/`dirname` as needed, and after `send("started", { seq, session });`:

```js
        // STC-530. The helper dying mid-take, as `kill -9` leaves it: a playable display.mp4
        // and the anchors.partial.json the real helper keeps current — never anchors.json.
        // fixtures/basic supplies both, so the app's recovery runs against a real mp4.
        if (process.env.STC_FAKE_DIE_MS && typeof cmd.dir === "string") {
          const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "basic");
          if (!process.env.STC_FAKE_DIE_NO_PARTIAL) {
            copyFileSync(join(fixture, "display.mp4"), join(cmd.dir, "display.mp4"));
            const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
            delete a.stop;
            writeFileSync(join(cmd.dir, "anchors.partial.json"), JSON.stringify({ ...a, version: 2 }));
          }
          setTimeout(() => process.kill(process.pid, "SIGKILL"), Number(process.env.STC_FAKE_DIE_MS));
        }
```

- [ ] **Step 2: The live e2e**

`app/test/recording-lost.e2e.test.ts` — copy the launch/teardown scaffolding from an existing e2e that starts a take through `app/test/_record-flow.ts`'s `startRecordFlow` (find one with `grep -ln startRecordFlow app/test/*.e2e.test.ts`) and count panels with `app/test/_windows.ts`'s `windowCount`, never `app.windows()`. Two tests:

```ts
  test("the helper dies mid-take: the take comes back as a panel with the reason, and no 'not saved' toast", async () => {
    // launch with STC_HELPER_BIN=<fake>, STC_FAKE_DIE_MS=1500
    // await startRecordFlow(...)
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 20_000 }).toBe(1);
    // the panel's reason line (read through the thumbnail window's page, the way thumbnail.e2e.test.ts reads #takemeta)
    expect(await reasonText()).toBe("Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.");
    // no alert was raised: read the alert record the same way other e2e tests read alertUser's output
    expect(await alerts()).not.toContainEqual(expect.stringMatching(/not saved|couldn't be recovered/));
  }, 90_000);

  test("the helper dies before writing anything: the toast says so and no panel appears", async () => {
    // STC_FAKE_DIE_MS=1500, STC_FAKE_DIE_NO_PARTIAL=1
    await expect.poll(() => alerts(), { timeout: 20_000 })
      .toContainEqual("The recorder quit while recording, and the take couldn't be recovered.");
    expect(await windowCount(app!, "thumbnail.html")).toBe(0);
  }, 90_000);
```

How an e2e reads a toast/alert and a panel's DOM already exists in this suite — `grep -n "alertUser\|takemeta\|__alerts" app/test/*.ts` and reuse that mechanism. The commented lines are filled from the scaffolding file you copied.

- [ ] **Step 3: Launch-recovery e2e**

In `app/test/crash-recovery.e2e.test.ts`, keep the existing "Review surfaces an unfinished take in Finder" test unchanged (its take has no partial — the pre-STC-530 shape). Add:

```ts
  test("Review puts a crashed take with anchors.partial.json up as a panel (STC-530)", async () => {
    const s = seed();
    const name = recentStamp(60 * 60 * 1000);
    const dir = join(s.tempTakes, name);
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, "fixtures/basic/display.mp4"), join(dir, "display.mp4"));
    const a = JSON.parse(readFileSync(join(root, "fixtures/basic/anchors.json"), "utf8"));
    delete a.stop;
    writeFileSync(join(dir, "anchors.partial.json"), JSON.stringify({ ...a, version: 2 }));

    const { calls, dialogs, revealed } = await launch(s, 0);   // 0 = "Review"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    const [d] = await dialogs();
    expect(d!.message).toBe("1 unsaved take recovered");
    expect(d!.detail).not.toMatch(/Finder/);          // it is a recording now, not an unfinished take
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    expect(await revealed()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8")).stop.reason).toBe("recorder-quit");
  }, 60_000);
```

(`root`, `cpSync` may need importing; follow that file's existing imports.)

- [ ] **Step 4: Typecheck, unit suite, then CI**

Run: `npm run typecheck && npx vitest run --project unit`
Expected: PASS. Then push and open a DRAFT PR so CI runs the e2e project (never run e2e locally):

```bash
git add app/test
git commit -m "STC-530: e2e — a lost take reaches the panel, live and at launch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --draft --base master --title "STC-530: a take the recorder quit on reaches the panel" --body "Draft for CI (e2e). Spec: docs/superpowers/specs/2026-10-13-stc-530-crash-take-panel-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: CI `test` green. If an e2e fails, diagnose from the CI log and `e2e-diag/` artifacts, fix, push again.

---

### Task 9: Runbook, docs, ticket hygiene

**Files:**
- Create: `docs/STC-530-RUNBOOK.md`
- Modify: `CLAUDE.md` (table), `docs/TICKET-LOG.md` (append a row)

- [ ] **Step 1: The runbook**

`docs/STC-530-RUNBOOK.md` — what only a Mac can settle, in order. Run from branch `accounts/stc-530-crash-take-panel` until it merges (`git fetch && git checkout accounts/stc-530-crash-take-panel && helper/build.sh && npm run app:start`):

1. **§0 Grant tests** (Patrick's terminal): `npm run test:capture -- helper/test/crash-partial.grant.test.ts`. All three pass; the kill test's recovered end within 2.5 s of the kill.
2. **§1 The acceptance:** start a take (Screen, ~10 s of visible motion, a clock on screen helps), then in a terminal `pkill -9 stc-helper`. Expect: the panel at the corner with the reason line; NO "not saved" toast; Edit opens it and it plays to within ~2 s of the kill; export works. Record the gap you saw.
3. **§2 With mic and camera on:** same, with a mic and camera chosen. Expect both tracks present and in sync up to the end.
4. **§3 Launch recovery:** repeat §1 but quit the app (⌘Q) with the panel untouched; relaunch. Expect the "1 unsaved take recovered" prompt with NO Finder sentence; Review → the panel.
5. **§4 The library:** Save the recovered take; its library tile shows "Recovered after the recorder quit. No cursor data."
6. **§5 Window drag:** a Window-scope take, drag the window around for 5 s, then `pkill -9`. Expect the recovered take to follow the window (STC-482's track survived).
7. **What is NOT checked here:** the disk-full panel copy (STC-531); notes for other stop reasons (STC-529).

- [ ] **Step 2: CLAUDE.md row**

Add a row to the "Where things are" table, near the STC-527 row:

```
| `transform/src/recover-anchors.ts`, `app/src/recover-take.ts`, `helper/src/PartialAnchors.swift`, `app/src/stop-copy.ts`, `schema/anchors-11.schema.json`, `docs/STC-530-RUNBOOK.md` | **a take the helper dies in reaches the panel** (STC-530). The helper keeps `anchors.partial.json` — the stop-time anchors document minus `stop`, from the same `anchorsDocument` — current from the first frame, rewritten (atomically, coalesced, never on a timer) at each track's first sample, pause/resume, refit and window move, and removed only once `anchors.json` is written. `recoverTake` (ONE path: live `recording-lost`, launch recovery's new `partial` kind, and STC-527's failed `anchors.json`) reads where each file actually ENDS from the media, builds the document (`recoverAnchors`, pure; a side track with no samples is DROPPED, a display with none refuses), checks it with `loadSession`, and never overwrites `anchors.json` or deletes anything. Reason `recorder-quit` is anchors-11, app-written only. `stop-copy.ts` is the ONE stop→words mapping for the panel line and the library note — `recorder-quit` only; STC-529/STC-531 add rows there. Fault `STC_CAPTURE_FAULT=anchors-write-failed`; fake `STC_FAKE_DIE_MS` |
```

- [ ] **Step 3: TICKET-LOG row**

Append a row to `docs/TICKET-LOG.md`'s table in its existing column format: STC-530 — what shipped (the above, one paragraph), what was learned (main could not import `loadSession` only because of one DOM type in `capture-colour.ts`; `disk-full.test.ts` drives a bare writer so the failed-anchors path moved to a pure harness plus the grant test; a missing side track drops rather than refuses), what's open (the runbook; disk-full copy is STC-531).

- [ ] **Step 4: Commit, mark ready, comment**

```bash
git add docs/STC-530-RUNBOOK.md CLAUDE.md docs/TICKET-LOG.md
git commit -m "STC-530: runbook, CLAUDE.md row, ticket log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Comment on STC-529 and STC-531 in Linear: "`app/src/stop-copy.ts` (STC-530) is the stop→words seam: `panelReason(stop)` feeds the panel's new `#takereason` line and `libraryNote(stop)` feeds `TakeInfo.notes`. Both return `undefined` for every reason but `recorder-quit`; add your rows there. `TakeInfo.stop` is already read." Hand Patrick the runbook with its branch.
