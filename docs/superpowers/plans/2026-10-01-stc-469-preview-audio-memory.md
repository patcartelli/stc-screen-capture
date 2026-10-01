# STC-469 Preview Audio Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the editor holding a redundant decoded mic copy, let export reuse the preview's decoded tracks instead of decoding (and cleaning) a second set, and state a measured per-minute memory ceiling for preview audio.

**Architecture:** One function, `decodeMicForMix(audio, strength | null)`, becomes the only way a mic `PcmTrack` is produced for playback or mixing — export, the editor and the narration worker all call it, so a track produced in one place is byte-identical to what another would produce. The narration worker now receives the COMPRESSED mic (`DemuxedAudio`) and decodes it itself, so the editor can drop its raw mic once the cleaned one plays. A pure decision in `audio-mix.ts` (`reusableTracks`) says whether a track the editor offers is the one an export plan needs.

**Tech Stack:** TypeScript, WebCodecs (`AudioDecoder`, dedicated worker), Electron renderer, Vitest (Node unit + Playwright-Electron e2e), `afconvert` (macOS) for the measurement take.

**Spec:** `docs/superpowers/specs/2026-10-01-stc-469-preview-audio-memory-design.md`

## Global Constraints

- The preview must stay exactly the export's mix (STC-454). No streaming / partial decode, no approximation.
- Narration cleanup runs on the WHOLE mic track, before the export window is cut (STC-455) — unchanged.
- The mic-only export path (`plan.path === "mic"`, `AudioData` passthrough) is NOT touched.
- "Whatever was playing keeps playing" until a newly decoded/cleaned mic arrives (Patrick, 2026-09-25).
- `audioGen` must drop any decode or clean that lands after its take closed.
- No new IPC channel. No new production behaviour behind a test flag — test hooks only READ state or call `exportSession` the way the editor does (precedent: `__stcVideoBytesRead`, `editor.ts:1423`).
- `npm run typecheck` (all three passes) and `npm test` green before any PR.
- e2e: run in the VM first where it disrupts the host (memory: "Run e2e in the VM first"; `docs/VM-TESTING.md` in the main checkout).

## Review Focus

1. **Cleanup toggled on → off → on quickly while the worker is busy** — the final mic playing must match the project's final state (cleaned at the final strength, or raw), never stuck on an intermediate. Test: Task 3, "rapid toggles settle on the project's state".
2. **Export started while the preview is still cleaning** — the editor offers the raw mic (`cleanedAt: null`) with a plan that wants cleaned; export must decode and clean itself, not reuse. Test: Task 1, "raw offered, plan wants cleaned → not reused".
3. **Mic muted with cleanup on** — `plan.mic` is false; no mic may be reused or mixed. Test: Task 1, "muted mic → nothing reused for mic".
4. **Take closed while the raw mic is being re-decoded** — the late decode must not resurrect state on the next take. Test: Task 3, "a re-decode that lands after close is dropped" (via `audioGen`, asserted through the hook after reopening).
5. **Cleanup at strength 0** — `exportAudioPlan` treats it as no clean; the editor must play/offer the RAW mic, and export must reuse only a raw (`cleanedAt === null`) track. Test: Task 1, "strength 0 reuses only raw".

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `transform/src/audio-mix.ts` | modify | add `DecodedMic`, `ExportDecoded`, `reusableTracks` — the ONE reuse decision |
| `transform/src/decode-audio.ts` | modify | add `decodeMicForMix` — the ONE way a mic `PcmTrack` is made |
| `transform/src/export.ts` | modify | `opts.decoded`, `opts.audioHash`; `ExportResult.audioHash`, `.audioReused` |
| `app/src/narration-worker.ts` | modify | request carries `audio: DemuxedAudio`; decodes via `decodeMicForMix` |
| `app/src/editor.ts` | modify | `micSource`, drop `rawMic` once cleaned plays, `ensureRawMic`, offer tracks to export, test hooks |
| `transform/test/audio-mix.test.ts` | modify | unit tests for `reusableTracks` |
| `app/test/_take-fixture.ts` | modify | `makeMicAndSystemTakeFolder` |
| `app/test/preview-audio.e2e.test.ts` | modify | worker test to the new message shape; preview memory behaviour |
| `app/test/export-audio-reuse.e2e.test.ts` | create | export with reuse == export without, and reuse actually happened |
| `scripts/measure-preview-memory.mjs` | modify | stage audio, enable cleanup, wait for audio, measure export peak |
| `scripts/make-long-audio-take.mjs` | create | synthetic long mic + system take from a real one, via `afconvert` |
| `docs/STC-469-RUNBOOK.md` | create | numbers, the ceiling formula, what only a Mac can settle |
| `docs/TICKET-LOG.md`, `CLAUDE.md` | modify | ticket row; table row |

---

### Task 1: The reuse decision (pure)

**Files:**
- Modify: `transform/src/audio-mix.ts` (after `exportAudioPlan`, ~line 286)
- Test: `transform/test/audio-mix.test.ts`

**Interfaces:**
- Consumes: `PcmTrack` (`audio-mix.ts:52`), `exportAudioPlan`'s return `{ path, cleanMic, mic, system }`.
- Produces:
  ```ts
  export interface DecodedMic { track: PcmTrack; cleanedAt: number | null }
  export interface ExportDecoded { system?: PcmTrack | null; mic?: DecodedMic | null }
  export function reusableTracks(
    plan: { mic: boolean; system: boolean; cleanMic: boolean },
    cleanup: { enabled: boolean; strength: number } | undefined,
    offered: ExportDecoded | undefined,
  ): { mic: PcmTrack | null; system: PcmTrack | null }
  ```
  `null` in the result means "decode it yourself".

- [ ] **Step 1: Write the failing tests** — append to `transform/test/audio-mix.test.ts` (add `reusableTracks` to the existing import from `../src/audio-mix.js`):

```ts
describe("reusableTracks: may export use what the preview already decoded", () => {
  const t = (n: number): PcmTrack => ({ startNs: 0, sampleRate: 48_000, channels: [new Float32Array(n)] });
  const sys = t(1), raw = t(2), clean50 = t(3);
  const on = { enabled: true, strength: 0.5 };

  test("system offered and planned → reused", () => {
    expect(reusableTracks({ mic: false, system: true, cleanMic: false }, undefined, { system: sys }).system).toBe(sys);
  });
  test("system muted (plan.system false) → not reused", () => {
    expect(reusableTracks({ mic: false, system: false, cleanMic: false }, undefined, { system: sys }).system).toBeNull();
  });
  test("cleaned at the plan's strength → reused", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: on });
    expect(reusableTracks(plan, on, { mic: { track: clean50, cleanedAt: 0.5 } }).mic).toBe(clean50);
  });
  test("cleaned at a different strength → not reused", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: on });
    expect(reusableTracks(plan, on, { mic: { track: clean50, cleanedAt: 0.7 } }).mic).toBeNull();
  });
  test("raw offered, plan wants cleaned (preview still cleaning) → not reused", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: on });
    expect(reusableTracks(plan, on, { mic: { track: raw, cleanedAt: null } }).mic).toBeNull();
  });
  test("cleaned offered, plan wants raw (cleanup just switched off) → not reused", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: true, cleanup: { enabled: false, strength: 0.5 } });
    expect(reusableTracks(plan, { enabled: false, strength: 0.5 }, { mic: { track: clean50, cleanedAt: 0.5 } }).mic).toBeNull();
  });
  test("raw offered, plan wants raw → reused", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: true });
    expect(reusableTracks(plan, undefined, { mic: { track: raw, cleanedAt: null } }).mic).toBe(raw);
  });
  test("strength 0 reuses only raw", () => {
    const zero = { enabled: true, strength: 0 };
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: true, cleanup: zero });
    expect(plan.cleanMic).toBe(false);
    expect(reusableTracks(plan, zero, { mic: { track: raw, cleanedAt: null } }).mic).toBe(raw);
    expect(reusableTracks(plan, zero, { mic: { track: clean50, cleanedAt: 0 } }).mic).toBeNull();
  });
  test("muted mic → nothing reused for mic", () => {
    const plan = exportAudioPlan({ encode: true, hasMic: true, hasSystem: true, cleanup: on, micMuted: true });
    expect(reusableTracks(plan, on, { mic: { track: clean50, cleanedAt: 0.5 } }).mic).toBeNull();
  });
  test("nothing offered → decode both", () => {
    expect(reusableTracks({ mic: true, system: true, cleanMic: false }, undefined, undefined)).toEqual({ mic: null, system: null });
  });
});
```

(`PcmTrack` type: add `type PcmTrack` to the import if the file doesn't already import it.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/audio-mix.test.ts`
Expected: FAIL — `reusableTracks` is not exported.

- [ ] **Step 3: Implement** — in `transform/src/audio-mix.ts`, directly after `exportAudioPlan`:

```ts
/**
 * STC-469. A track the editor's preview has already decoded, offered to the
 * export so it is not decoded (and cleaned) a second time. `cleanedAt` is the
 * narration-cleanup strength it was cleaned at, or null for the raw mic.
 */
export interface DecodedMic { track: PcmTrack; cleanedAt: number | null }
export interface ExportDecoded { system?: PcmTrack | null; mic?: DecodedMic | null }

/**
 * Is the offered track the one this export plan needs? The ONE place that is
 * answered. A track is reused only when it is exactly what the export would
 * have produced itself — same function, same input (decode-audio.ts's
 * `decodeMicForMix`) — so reuse never changes a sample. Anything else
 * (null) means: decode it yourself, exactly as before.
 */
export function reusableTracks(
  plan: { mic: boolean; system: boolean; cleanMic: boolean },
  cleanup: { enabled: boolean; strength: number } | undefined,
  offered: ExportDecoded | undefined,
): { mic: PcmTrack | null; system: PcmTrack | null } {
  const system = plan.system ? offered?.system ?? null : null;
  const m = plan.mic ? offered?.mic ?? null : null;
  const wantCleanedAt = plan.cleanMic ? cleanup!.strength : null;
  const mic = m && m.cleanedAt === wantCleanedAt ? m.track : null;
  return { mic, system };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run transform/test/audio-mix.test.ts`
Expected: PASS (all, including the existing `exportAudioPlan` tests).

- [ ] **Step 5: Commit**

```bash
git add transform/src/audio-mix.ts transform/test/audio-mix.test.ts
git commit -m "STC-469: reusableTracks — may export reuse the preview's decoded audio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One mic-track producer; the worker decodes the compressed mic

**Files:**
- Modify: `transform/src/decode-audio.ts`
- Modify: `app/src/narration-worker.ts`
- Modify: `app/src/editor.ts` (`loadPreviewAudio` ~1951, `pumpClean` ~2017, module state ~1913, `closeTake` ~1507, hooks near `editor.ts:1423`)
- Test: `app/test/preview-audio.e2e.test.ts` (the "cleanup worker" test)

**Interfaces:**
- Consumes: `decodeAllAudio`, `pcmTrackOf` (`decode-audio.ts`), `cleanNarration` (`narration-clean.ts`), `DemuxedAudio` (`demux-audio.ts:62`).
- Produces:
  ```ts
  // decode-audio.ts
  export async function decodeMicForMix(audio: DemuxedAudio, cleanStrength: number | null): Promise<PcmTrack | null>
  // narration-worker.ts message shapes
  interface Request { id: number; strength: number; audio: DemuxedAudio }
  // reply: { id: number; track: PcmTrack | null } | { id: number; error: string }
  // editor.ts module state
  let micSource: DemuxedAudio | null
  // editor.ts test hook (read-only)
  window.__stcPreviewAudio(): { micAudio: DemuxedAudio | null; rawMicHeld: boolean; cleanedFor: number | null;
                                playing: "raw" | "cleaned" | null; cleaning: boolean }
  ```

- [ ] **Step 1: Rewrite the worker e2e test to the new message shape (failing)** — replace the body of `test("the cleanup worker loads under the editor's CSP and cleans what it is sent", …)` in `app/test/preview-audio.e2e.test.ts`. The cleaning EFFECT is pinned by `transform/test/narration-clean.test.ts`; this test pins bundling, CSP, the message shape, and that the worker's decode agrees with the editor's:

```ts
  test("the cleanup worker loads under the editor's CSP, decodes the compressed mic, and answers", async () => {
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    const result = await win.evaluate(async () => {
      const hook = (window as any).__stcPreviewAudio();
      const audio = hook.micAudio;
      const w = new Worker("../dist/narration-worker.js");
      const reply = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("worker did not answer in 20 s")), 20_000);
        w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
        w.onerror = (e) => { clearTimeout(t); reject(new Error(`worker error: ${e.message}`)); };
        w.postMessage({ id: 1, strength: 0.5, audio });
      });
      w.terminate();
      const out: Float32Array = reply.track.channels[0];
      return {
        id: reply.id, error: reply.error, startNs: reply.track.startNs, length: out.length,
        finite: out.every(Number.isFinite), micStillUsable: hook.micAudio.chunks.length > 0,
        // The raw mic is playing (cleanup is off by default), so its length
        // is what the worker's decode must produce.
        expectedLength: hook.micLength,
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(1);
    expect(result.finite).toBe(true);
    expect(result.length).toBe(result.expectedLength);
    // Cloned, not transferred: the session keeps its compressed mic.
    expect(result.micStillUsable).toBe(true);
  }, 120_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/test/preview-audio.e2e.test.ts -t "cleanup worker"`
Expected: FAIL — `__stcPreviewAudio is not a function`.

- [ ] **Step 3: Add `decodeMicForMix`** — `transform/src/decode-audio.ts`, add the import and, after `pcmTrackOf`:

```ts
import { cleanNarration } from "./narration-clean.js";
```

```ts
/**
 * The ONE way a mic `PcmTrack` is made for playing or mixing (STC-469): the
 * export, the editor and the narration worker all call this, so a track made
 * in one of them is sample-for-sample the track any other would make — which
 * is what lets the export reuse the preview's (audio-mix.ts `reusableTracks`).
 * `cleanStrength` null is the raw mic; a number is that track through
 * `cleanNarration`, on the WHOLE take (STC-455: the noise profile is learned
 * from every pause).
 */
export async function decodeMicForMix(audio: DemuxedAudio, cleanStrength: number | null): Promise<PcmTrack | null> {
  const track = pcmTrackOf(await decodeAllAudio(audio), "mic.m4a");
  return track && cleanStrength !== null ? cleanNarration(track, cleanStrength) : track;
}
```

- [ ] **Step 4: Rewrite the worker** — `app/src/narration-worker.ts` in full:

```ts
import { decodeMicForMix } from "@transform/decode-audio";
import type { DemuxedAudio } from "@transform/demux-audio";

/**
 * Narration cleanup OFF the editor's main thread (STC-454). The preview plays
 * the cleaned mic, like the export (Patrick, 2026-09-25), and cleaning is
 * about 1 s per minute of audio — long enough on a real take to stall the
 * picture and the transport if it ran where they do.
 *
 * STC-469: it is sent the COMPRESSED mic (~1 MB/min, structured-cloned — the
 * session keeps using its own) and decodes it here, through the same
 * `decodeMicForMix` the export calls, so the editor never has to keep a raw
 * decoded copy just to have something to send. Nothing here decides
 * anything. The cleaned samples are transferred back, not copied.
 */
interface Request { id: number; strength: number; audio: DemuxedAudio }

const post = (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage.bind(self);

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, strength, audio } = e.data;
  try {
    const track = await decodeMicForMix(audio, strength);
    post({ id, track }, track ? track.channels.map((c) => c.buffer as ArrayBuffer) : []);
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
```

- [ ] **Step 5: Editor — decode through `decodeMicForMix`, keep `micSource`, send it to the worker, add the hook.** In `app/src/editor.ts`:

  Add to the import from `@transform/decode-audio` (wherever `decodeAllAudio`/`pcmTrackOf` are imported): `decodeMicForMix`. Add `import type { DemuxedAudio } from "@transform/demux-audio";` if not already imported.

  Module state (after `let rawMic: PcmTrack | null = null;`):

```ts
/** The take's COMPRESSED mic — what the cleanup worker and a raw re-decode start from (STC-469). Null when there is no playable mic. */
let micSource: DemuxedAudio | null = null;
```

  In `loadPreviewAudio`, replace the mic decode and the `rawMic = mic;` line:

```ts
    const [mic, system] = await Promise.all([
      session.micAudio ? decodeMicForMix(session.micAudio, null) : null,
      session.systemAudio ? decodeAllAudio(session.systemAudio).then((d) => pcmTrackOf(d, "system.m4a")) : null,
    ]);
    if (gen !== audioGen || !player) return;
    rawMic = mic;
    micSource = mic ? session.micAudio! : null;
```

  In `pumpClean`, replace the guard, the copy and the post:

```ts
function pumpClean(): void {
  if (cleanBusy || cleanWanted === null || !micSource) return;
  const strength = cleanWanted;
  const id = ++cleanSeq;
  const gen = audioGen;
  cleanBusy = true;
  setCleaning(true);
  const worker = cleanWorker ??= new Worker("../dist/narration-worker.js");
  worker.onmessage = /* unchanged for now — Task 3 changes the success branch */ …;
  // The COMPRESSED mic, cloned (STC-469): the worker decodes it itself, so
  // nothing here has to keep a raw decoded copy alive just to send one.
  worker.postMessage({ id, strength, audio: micSource });
}
```

  (Keep the existing `worker.onmessage` body exactly as it is in this task; delete only the `const track: PcmTrack = …slice()…` line and its comment, and change the `postMessage` call.)

  In `refreshCleanMic`, change the first guard from `if (!previewAudio || !rawMic) return;` to `if (!previewAudio || !micSource) return;`.

  In `closeTake`, after `rawMic = null;` add `micSource = null;`.

  Next to the `__stcVideoBytesRead` hook (`editor.ts:1423`), add:

```ts
// STC-469: what the preview is holding, for the e2e suite. Read-only.
(window as unknown as { __stcPreviewAudio: () => unknown }).__stcPreviewAudio = () => {
  const playing = previewAudio?.micTrack ?? null;
  return {
    micAudio: micSource,
    rawMicHeld: rawMic !== null,
    cleanedFor,
    playing: playing === null ? null : playing === cleanedMic ? "cleaned" : playing === rawMic ? "raw" : null,
    cleaning: ($("previewaudio") as HTMLButtonElement).dataset.cleaning === "true",
    micLength: playing?.channels[0]?.length ?? null,
  };
};
```

- [ ] **Step 6: Run the e2e and the typecheck**

Run: `npm run typecheck && npx vitest run app/test/preview-audio.e2e.test.ts`
Expected: typecheck clean; all preview-audio tests PASS (the worker test now via the compressed mic).

- [ ] **Step 7: Commit**

```bash
git add transform/src/decode-audio.ts app/src/narration-worker.ts app/src/editor.ts app/test/preview-audio.e2e.test.ts
git commit -m "STC-469: one mic-track producer; the cleanup worker decodes the compressed mic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The editor stops holding the raw mic while the cleaned one plays

**Files:**
- Modify: `app/src/editor.ts` (`refreshCleanMic`, `pumpClean`'s `onmessage`, new `ensureRawMic`, `closeTake`)
- Test: `app/test/preview-audio.e2e.test.ts`

**Interfaces:**
- Consumes: `micSource`, `decodeMicForMix`, `__stcPreviewAudio()` (Task 2).
- Produces: `function ensureRawMic(): void`; state `let rawLoading: boolean`. Invariant after settling: cleanup on ⇒ `rawMicHeld === false && playing === "cleaned" && cleanedFor === strength`; cleanup off ⇒ `playing === "raw" && cleanedFor === null`.

- [ ] **Step 1: Write the failing tests** — append inside `describe("preview sound", …)`:

```ts
  const held = (win: Page) => win.evaluate(() => {
    const h = (window as any).__stcPreviewAudio();
    return { raw: h.rawMicHeld, playing: h.playing, cleanedFor: h.cleanedFor, cleaning: h.cleaning };
  });
  async function setCleanup(win: Page, on: boolean): Promise<void> {
    await win.click("#audiobtn");
    const box = win.locator("#voicecleanon");
    if ((await box.isChecked()) !== on) await box.click();
    await win.keyboard.press("Escape");
  }

  test("cleanup on drops the raw mic once the cleaned one plays; off decodes it back", async () => {
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    expect(await held(win)).toMatchObject({ raw: true, playing: "raw", cleanedFor: null });

    await setCleanup(win, true);
    await expect.poll(() => held(win), { timeout: 30_000 })
      .toEqual({ raw: false, playing: "cleaned", cleanedFor: 0.5, cleaning: false });

    await setCleanup(win, false);
    await expect.poll(() => held(win), { timeout: 30_000 })
      .toEqual({ raw: true, playing: "raw", cleanedFor: null, cleaning: false });
  }, 120_000);

  test("rapid toggles settle on the project's state", async () => {
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    await win.click("#audiobtn");
    const box = win.locator("#voicecleanon");
    for (let i = 0; i < 5; i++) await box.click(); // off → on, five times: ends ON
    await win.keyboard.press("Escape");
    await expect.poll(() => held(win), { timeout: 30_000 })
      .toEqual({ raw: false, playing: "cleaned", cleanedFor: 0.5, cleaning: false });
  }, 120_000);

  test("a re-decode that lands after close is dropped", async () => {
    const { dir } = makeMicTakeFolder();
    let win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    await setCleanup(win, true);
    await expect.poll(() => held(win), { timeout: 30_000 }).toMatchObject({ raw: false, playing: "cleaned" });
    // Off starts a raw re-decode; closing the window at once must not let it
    // land on the next opening of the take.
    await setCleanup(win, false);
    await win.close();
    win = await openEditorFromLibrary(app!, mainWin!);
    await win.waitForSelector("#stage", { timeout: 20_000 });
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    // Reopened with cleanup OFF (persisted): raw, and nothing cleaned left over.
    await expect.poll(() => held(win), { timeout: 30_000 })
      .toEqual({ raw: true, playing: "raw", cleanedFor: null, cleaning: false });
  }, 180_000);
```

`openEditorFromLibrary(app, win)` clicks Preview in the MAIN (library) window, so keep it: at the top of the file add `let mainWin: Page | undefined;`, and in the file's existing `openEditor` helper add `mainWin = launched.win;` right after `app = launched.app;`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run app/test/preview-audio.e2e.test.ts -t "raw mic|rapid|re-decode"`
Expected: FAIL — after cleanup on, `raw` is still `true`.

- [ ] **Step 3: Implement.** In `app/src/editor.ts`:

  State (next to `micSource`):

```ts
let rawLoading = false;
```

  Replace `refreshCleanMic` entirely:

```ts
/** Point the preview at the mic the export would use: raw, or cleaned at the project's strength. */
function refreshCleanMic(): void {
  if (!previewAudio || !micSource) return;
  const cleanup = openProject?.narrationCleanup;
  const { cleanMic } = exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup });
  if (!cleanMic) {
    cleanWanted = null;
    if (rawMic) {
      useMic(rawMic);
      // STC-469: off means raw, so the cleaned copy is dead weight now.
      cleanedMic = null;
      cleanedFor = null;
    } else {
      // The raw mic was dropped while the cleaned one played: decode it back.
      // Whatever is playing keeps playing until it arrives.
      ensureRawMic();
    }
    if (!cleanBusy) setCleaning(false);
    return;
  }
  if (cleanedMic && cleanedFor === cleanup!.strength) {
    cleanWanted = null;
    useMic(cleanedMic);
    // STC-469: the cleaned mic is what plays; the worker re-cleans from the
    // COMPRESSED track, so the raw decoded copy buys nothing any more.
    rawMic = null;
    return;
  }
  cleanWanted = cleanup!.strength;
  pumpClean();
}

/** Decode the raw mic again (STC-469), then let `refreshCleanMic` re-decide — the project may have changed meanwhile. */
function ensureRawMic(): void {
  if (rawMic || rawLoading || !micSource) return;
  rawLoading = true;
  const gen = audioGen;
  decodeMicForMix(micSource, null).then((track) => {
    if (gen !== audioGen) return;
    rawLoading = false;
    // It decoded once already, so null here would mean the decoder changed
    // its mind; with no raw to fall back to, there is no playable mic.
    if (!track) { micSource = null; return; }
    rawMic = track;
    refreshCleanMic();
  }, (e: any) => {
    if (gen !== audioGen) return;
    rawLoading = false;
    console.warn(`preview mic re-decode failed: ${e?.message ?? e}`);
  });
}
```

  In `pumpClean`'s `worker.onmessage`, replace the success branch:

```ts
    if (e.data.track) {
      cleanedMic = e.data.track;
      cleanedFor = strength;
      if (cleanWanted === strength) {
        cleanWanted = null;
        useMic(cleanedMic);
        rawMic = null; // STC-469: see refreshCleanMic
      }
    } else if (e.data.track === null) {
      cleanWanted = null; // a mic that decodes to nothing has nothing to clean
    } else {
```

  (the `else` keeps the existing error branch: `cleanWanted = null; console.warn(...)`.) Then, after `if (cleanWanted !== null) pumpClean(); else setCleaning(false);`, add one line so a cleaned result that arrived while cleanup was switched OFF hands back to the raw path:

```ts
    if (cleanWanted === null && !cleanBusy) refreshCleanMic();
```

  (Re-entrancy check: `refreshCleanMic` only calls `pumpClean` when `cleanWanted` becomes non-null, and the cleaned-at-current-strength branch sets it null and returns — no loop.)

  Update the `onmessage` type: `MessageEvent<{ id: number; track?: PcmTrack | null; error?: string }>`.

  In `closeTake`, after `micSource = null;` add `rawLoading = false;`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run typecheck && npx vitest run app/test/preview-audio.e2e.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/editor.ts app/test/preview-audio.e2e.test.ts
git commit -m "STC-469: drop the raw mic while the cleaned one plays; decode it back on off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Export reuses the preview's tracks

**Files:**
- Modify: `transform/src/export.ts` (`ExportOptions` ~27, `ExportResult` ~48, mix decode ~170-180, mix loop ~387-410, return ~463)
- Modify: `app/src/editor.ts` (export call ~2265, new `decodedForExport`, test hook)
- Modify: `app/test/_take-fixture.ts`
- Create: `app/test/export-audio-reuse.e2e.test.ts`

**Interfaces:**
- Consumes: `reusableTracks`, `ExportDecoded` (Task 1); `decodeMicForMix` (Task 2); `rawMic`, `cleanedMic`, `cleanedFor`, `previewAudio` (editor).
- Produces:
  ```ts
  // ExportOptions
  decoded?: ExportDecoded;
  /** Test/gate only: SHA-256 over every mixed block handed to the encoder. */
  audioHash?: boolean;
  // ExportResult
  audioHash: string;                                   // "" unless opts.audioHash and the mix path ran
  audioReused: { mic: boolean; system: boolean };
  // editor.ts
  function decodedForExport(): ExportDecoded
  window.__stcExportForTest(opts: { reuse: boolean }): Promise<{ audioHash: string; audioReused: { mic: boolean; system: boolean } }>
  // _take-fixture.ts
  export function makeMicAndSystemTakeFolder(takeName?: string): { dir: string; takeDir: string }
  ```

- [ ] **Step 1: Add the fixture** — in `app/test/_take-fixture.ts`, after `makeMicTakeFolder`:

```ts
/**
 * Mic AND system audio (STC-469): the two fixtures above, together. Both
 * tracks are the placeholder AAC that decodes (to near-silence) in Chromium,
 * which is enough to drive the export's MIX path end to end.
 */
export function makeMicAndSystemTakeFolder(
  takeName = "2026-10-01_10-00-00-micsys",
): { dir: string; takeDir: string } {
  const { dir, takeDir } = makeMicTakeFolder(takeName);
  const { frames, frameUs } = writePlaceholderAac(join(takeDir, "system.m4a"), 2);
  const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
  anchors.version = 6;
  anchors.files = { ...anchors.files, system: "system.m4a" };
  anchors.system = {
    present: true, sampleRate: 48_000, channels: 2,
    firstFramePtsNs: 100_000_000, lastFramePtsNs: 100_000_000 + Math.round((frames - 1) * frameUs * 1000),
  };
  writeFileSync(join(takeDir, "anchors.json"), JSON.stringify(anchors, null, 2));
  return { dir, takeDir };
}
```

- [ ] **Step 2: Write the failing e2e** — create `app/test/export-audio-reuse.e2e.test.ts`:

```ts
import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeMicAndSystemTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-469: the export reuses the tracks the preview already decoded. Reuse is
 * only allowed when the track is what the export would have made itself
 * (audio-mix.ts `reusableTracks`, decode-audio.ts `decodeMicForMix`), so the
 * MIXED SAMPLES must be identical with and without it — checked here by the
 * export's own audio hash — and the reuse must actually have happened,
 * or "identical" would be two runs of the old path agreeing.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir, {});
  app = launched.app;
  const win = await openEditorFromLibrary(app, launched.win);
  await win.waitForSelector("#stage", { timeout: 20_000 });
  await expect.poll(() => win.getAttribute("#previewaudio", "data-state"), { timeout: 30_000 }).toBe("ready");
  return win;
}

const settled = (win: Page) => win.evaluate(() => (window as any).__stcPreviewAudio().cleaning === false);
const exportWith = (win: Page, reuse: boolean) =>
  win.evaluate((reuse) => (window as any).__stcExportForTest({ reuse }), reuse);

describe("export reuses the preview's decoded audio", () => {
  test("cleanup on: same mixed samples, mic and system both reused", async () => {
    const { dir } = makeMicAndSystemTakeFolder();
    const win = await openEditor(dir);
    await win.click("#audiobtn");
    await win.locator("#voicecleanon").check();
    await win.keyboard.press("Escape");
    await expect.poll(() => win.evaluate(() => (window as any).__stcPreviewAudio().playing), { timeout: 30_000 }).toBe("cleaned");
    await expect.poll(() => settled(win), { timeout: 30_000 }).toBe(true);

    const reused = await exportWith(win, true);
    const fresh = await exportWith(win, false);
    expect(reused.audioReused).toEqual({ mic: true, system: true });
    expect(fresh.audioReused).toEqual({ mic: false, system: false });
    expect(reused.audioHash).not.toBe("");
    expect(reused.audioHash).toBe(fresh.audioHash);
  }, 180_000);

  test("cleanup off: the raw mic is reused, same mixed samples", async () => {
    const { dir } = makeMicAndSystemTakeFolder();
    const win = await openEditor(dir);
    const reused = await exportWith(win, true);
    const fresh = await exportWith(win, false);
    expect(reused.audioReused).toEqual({ mic: true, system: true });
    expect(reused.audioHash).toBe(fresh.audioHash);
  }, 180_000);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run app/test/export-audio-reuse.e2e.test.ts`
Expected: FAIL — `__stcExportForTest is not a function`.

- [ ] **Step 4: Export.** In `transform/src/export.ts`:

  Imports: add `reusableTracks, type ExportDecoded` to the `./audio-mix.js` import, and `decodeMicForMix` to the `./decode-audio.js` import. Remove `cleanNarration`'s import if nothing else in the file uses it (grep first).

  `ExportOptions`, after `captureId`:

```ts
  /**
   * STC-469: tracks the caller (the editor's preview) has already decoded.
   * Used only where `reusableTracks` says they are exactly what this export
   * would make itself; otherwise ignored and the export decodes as before.
   */
  decoded?: ExportDecoded;
  /** Test/gate only: a SHA-256 over every mixed audio block handed to the encoder. */
  audioHash?: boolean;
```

  `ExportResult`, after `mixEncodedChunks`:

```ts
  /** "" unless `opts.audioHash` was set and the mix path ran. */
  audioHash: string;
  /** STC-469: which mix inputs came from `opts.decoded` rather than a fresh decode. */
  audioReused: { mic: boolean; system: boolean };
```

  Replace the `if (mixing) { … }` block (~line 172-179):

```ts
  // STC-469: the preview's own tracks, where they are exactly what we would
  // decode here (audio-mix.ts `reusableTracks`) — no second decode, and no
  // second `cleanNarration`, which is the export's largest transient (its
  // Float64 STFT buffers run ~7x the mic).
  const reuse = reusableTracks(plan, cleanup, opts.decoded);
  if (mixing) {
    mixSystem = plan.system && session.systemAudio
      ? reuse.system ?? pcmTrackOf(await decodeAllAudio(session.systemAudio), "system.m4a")
      : null;
    // The WHOLE track, before the window is cut, so the noise profile is
    // learned from every pause in the take rather than only the clip's —
    // and a trimmed export cleans exactly as the full one would.
    mixMic = plan.mic && micAudio
      ? reuse.mic ?? await decodeMicForMix(micAudio, cleaning ? cleanup!.strength : null)
      : null;
  }
  const audioReused = { mic: mixing && reuse.mic !== null && mixMic === reuse.mic, system: mixing && reuse.system !== null && mixSystem === reuse.system };
```

  Audio hash: next to `const rolling = new Uint8Array(32);` add `const audioRolling = new Uint8Array(32);`. In the mix loop, right after `for (let ch = 0; ch < MIX_CHANNELS; ch++) data.set(planes[ch]!, ch * n);`:

```ts
          if (opts.audioHash) {
            const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as BufferSource));
            const b = at / MIX_BLOCK_FRAMES;
            for (let i = 0; i < 32; i++) audioRolling[i]! ^= h[i]! + ((b * 31 + i) & 0xff);
          }
```

  In the return object, after `mixEncodedChunks`:

```ts
      audioHash: opts.audioHash && mixing && !cancelled ? await sha256Hex(audioRolling) : "",
      audioReused,
```

  If any OTHER `return {` in `exportSession` builds an `ExportResult` (grep `return {` in the file), add the same two fields there (`audioHash: ""`, `audioReused: { mic: false, system: false }`). `npm run typecheck` will name any you miss.

- [ ] **Step 5: Editor.** In `app/src/editor.ts`, import `type ExportDecoded` from `@transform/audio-mix`. Add near `previewLevels`:

```ts
/**
 * The tracks the preview holds, offered to the export (STC-469). The mic is
 * tagged with what it IS — raw, or cleaned at a strength — and
 * `reusableTracks` decides whether that is what this export needs.
 */
function decodedForExport(): ExportDecoded {
  const mic = previewAudio?.micTrack ?? null;
  const cleanedAt = mic !== null && mic === cleanedMic ? cleanedFor : null;
  const known = mic !== null && (mic === cleanedMic || mic === rawMic);
  return {
    system: previewAudio?.systemTrack ?? null,
    mic: known ? { track: mic!, cleanedAt } : null,
  };
}
```

  In the export call (`exportSession(openSession, exporting, { hash: true, captureId, … })`), add `decoded: decodedForExport(),`.

  Next to the `__stcPreviewAudio` hook:

```ts
// STC-469: the export exactly as the editor runs it, with or without the
// preview's tracks — for the e2e identity check and the memory measurement.
// Nothing is written; the encoded file is discarded.
(window as unknown as { __stcExportForTest: (o: { reuse: boolean }) => Promise<unknown> }).__stcExportForTest =
  async ({ reuse }) => {
    if (!openSession || !openProject) throw new Error("no take open");
    const r = await exportSession(openSession, structuredClone(openProject), {
      audioHash: true, decoded: reuse ? decodedForExport() : undefined,
    });
    return { audioHash: r.audioHash, audioReused: r.audioReused };
  };
```

- [ ] **Step 6: Run**

Run: `npm run typecheck && npx vitest run app/test/export-audio-reuse.e2e.test.ts transform/test/audio-mix.test.ts transform/test/export-pip.test.ts`
Expected: all PASS.

- [ ] **Step 7: Run the export gate, since `export.ts` changed**

Run: `npm run gate:export` (needs Chrome; on a host without a take, it defaults to the newest take — if none has audio, note that the gate covers the video path only).
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add transform/src/export.ts app/src/editor.ts app/test/_take-fixture.ts app/test/export-audio-reuse.e2e.test.ts
git commit -m "STC-469: export reuses the preview's decoded audio when it is the same track

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Measure, state the ceiling, write it down

**Files:**
- Modify: `scripts/measure-preview-memory.mjs`
- Create: `scripts/make-long-audio-take.mjs`
- Create: `docs/STC-469-RUNBOOK.md`
- Modify: `docs/TICKET-LOG.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `__stcPreviewAudio()`, `__stcExportForTest({ reuse })`.
- Produces: `node scripts/make-long-audio-take.mjs <srcTake> <minutes> <outParentDir>` → a take dir with `mic.m4a` (mono) + `system.m4a` (stereo) of that length; `node scripts/measure-preview-memory.mjs <takeDir> [--cleanup] [--export]`.

- [ ] **Step 1: Synthetic long take** — create `scripts/make-long-audio-take.mjs`:

```js
/**
 * A long mic + system take for measuring preview AUDIO memory (STC-469).
 *
 * Copies a real take's video and sidecars, then writes `mic.m4a` (mono) and
 * `system.m4a` (stereo) of the requested length — a tone over hiss with
 * pauses, so narration cleanup has something to learn — encoded to AAC by
 * macOS's own `afconvert`. The display stays as short as the source:
 * `loadSession` accepts audio longer than the picture, and the audio cost
 * scales with the AUDIO's length, which is what this measures.
 *
 * Usage: node scripts/make-long-audio-take.mjs <srcTake> <minutes> <outParentDir>
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

const [src, minutesArg, outParent] = process.argv.slice(2);
const minutes = Number(minutesArg);
if (!src || !existsSync(join(src, "anchors.json")) || !(minutes > 0) || !outParent) {
  console.error("usage: node scripts/make-long-audio-take.mjs <srcTake> <minutes> <outParentDir>");
  process.exit(2);
}
const take = join(outParent, `${basename(src)}-long${minutes}m`);
mkdirSync(take, { recursive: true });
for (const f of ["anchors.json", "events.json", "display.mp4", "project.json"]) {
  if (existsSync(join(src, f))) cpSync(join(src, f), join(take, f));
}

const RATE = 48_000;
/** 16-bit PCM WAV, written in one-second blocks so an hour never sits in memory. */
function writeWav(path, channels, seconds) {
  const frames = RATE * seconds;
  const dataBytes = frames * channels * 2;
  const fd = openSync(path, "w");
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  writeSync(fd, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const block = Buffer.alloc(RATE * channels * 2);
  for (let s = 0; s < seconds; s++) {
    const speaking = s % 5 < 3; // 3 s of "speech", 2 s of pause
    for (let i = 0; i < RATE; i++) {
      const t = (s * RATE + i) / RATE;
      const v = (speaking ? 0.2 * Math.sin(2 * Math.PI * 220 * t) : 0) + 0.01 * rnd();
      for (let c = 0; c < channels; c++) block.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), (i * channels + c) * 2);
    }
    writeSync(fd, block);
  }
  closeSync(fd);
}

const seconds = Math.round(minutes * 60);
for (const [name, channels] of [["mic", 1], ["system", 2]]) {
  const wav = join(take, `${name}.wav`);
  writeWav(wav, channels, seconds);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac@48000", wav, join(take, `${name}.m4a`)], { stdio: "inherit" });
  rmSync(wav);
}

const a = JSON.parse(readFileSync(join(take, "anchors.json"), "utf8"));
const lastNs = 100_000_000 + seconds * 1e9 - Math.round((1024 * 1e9) / RATE);
a.version = Math.max(a.version, 6);
a.files = { ...a.files, mic: "mic.m4a", system: "system.m4a" };
a.mic = { present: true, device: "Synthetic", sampleRate: RATE, channels: 1, firstFramePtsNs: 100_000_000, lastFramePtsNs: lastNs };
a.system = { present: true, sampleRate: RATE, channels: 2, firstFramePtsNs: 100_000_000, lastFramePtsNs: lastNs };
writeFileSync(join(take, "anchors.json"), JSON.stringify(a, null, 2));
console.log(take);
```

  Run: `node scripts/make-long-audio-take.mjs ~/Desktop/stc/2026-09-23_10-27-09 30 "$TMPDIR/stc469"`
  Expected: prints the take path; `mic.m4a` ≈ 30 min. If the source take's anchors version or schema refuses the added blocks at load time (the editor shows a load error), record the exact error in the runbook and hand the measurement to Patrick instead — do not change `loadSession`.

- [ ] **Step 2: Fix the measurement script** — `scripts/measure-preview-memory.mjs`:

  In `stage(withCamera)`: change the files list to

```js
  const files = ["anchors.json", "events.json", "display.mp4", "project.json", "mic.m4a", "system.m4a"];
```

  After the existing "picture shows non-black pixels" wait in `measure()`, add (using whichever variable holds the editor `Page` there — read the function first):

```js
    // STC-469: the audio is part of what the preview holds. Wait for it to
    // decode, turn cleanup on if asked, and wait for the cleaned mic to play.
    await editorWin.waitForFunction(() => {
      const s = document.getElementById("previewaudio")?.dataset.state;
      return s && s !== "loading";
    }, null, { timeout: 600_000 });
    if (process.argv.includes("--cleanup")) {
      await editorWin.click("#audiobtn");
      await editorWin.locator("#voicecleanon").check();
      await editorWin.keyboard.press("Escape");
      await editorWin.waitForFunction(() => (window).__stcPreviewAudio?.().playing === "cleaned", null, { timeout: 600_000 });
    }
```

  And, after the steady-state RSS is read, when `--export` is passed:

```js
    if (process.argv.includes("--export")) {
      for (const reuse of [false, true]) {
        let peak = 0;
        const timer = setInterval(async () => { peak = Math.max(peak, await rendererRss(app)); }, 250);
        await editorWin.evaluate((reuse) => (window).__stcExportForTest({ reuse }), reuse);
        clearInterval(timer);
        console.log(`  export (reuse=${reuse}): peak renderer RSS ${mb(peak)} MB`);
      }
    }
```

  Update the header's Usage line: `node scripts/measure-preview-memory.mjs <takeDir> [--cleanup] [--export]`.

- [ ] **Step 3: Measure master vs this branch**

```bash
TAKE=$(node scripts/make-long-audio-take.mjs ~/Desktop/stc/2026-09-23_10-27-09 30 "$TMPDIR/stc469")
node scripts/measure-preview-memory.mjs "$TAKE" --cleanup --export
```

  For master's preview numbers: `git worktree add "$TMPDIR/stc469-master" origin/master`, copy this branch's `scripts/measure-preview-memory.mjs` into it, `npm ci` there, and run the same command WITHOUT `--export` (master has no `__stcExportForTest`; the branch's `reuse=false` run IS master's export behaviour). Remove that worktree afterwards (`git worktree remove`).
  Expected: branch steady state lower than master by ≈ one mono mic (≈ 11.5 MB/min × 30 ≈ 345 MB); export peak with reuse lower than without.
  Run in the VM if launching Electron on the host is disruptive (memory: "Run e2e in the VM first").

- [ ] **Step 4: Runbook** — create `docs/STC-469-RUNBOOK.md` with: what changed (three bullets from the spec), the measured table (master vs branch, steady state with cleanup on, export peak reuse=false vs true, the take's length and channel layout), the ceiling stated as a formula — steady state ≈ `minutes × (mic channels × 11.5 + system channels × 11.5) MB` at 48 kHz, i.e. ≈ 34.5 MB/min for mono mic + stereo system, plus ≈ 1 MB/min compressed — and what only a Mac can settle:
  1. a REAL ≥ 30 min take with mic + system: run the Step 3 command against it;
  2. cleanup off on a long take: the cleaned voice keeps playing, then switches to raw — does the gap feel right (it is a full re-decode, seconds on a long take);
  3. export with the editor open on a long take: no visible stall beyond today's.
  Name the branch to run it from (`accounts/stc-469-preview-audio-memory` until merged, then `master`).

- [ ] **Step 5: Ticket log + CLAUDE.md** — append an STC-469 row to `docs/TICKET-LOG.md`'s table in the same column format as the STC-236 row (what shipped, what was learned — the measured numbers —, what is open: option B). Add a `CLAUDE.md` table row after the `transform/src/preview-audio.ts` row:

```
| `docs/STC-469-RUNBOOK.md` | preview audio memory (STC-469): the editor no longer keeps a raw decoded mic while the cleaned one plays (the cleanup worker decodes the COMPRESSED mic itself, `decode-audio.ts`'s `decodeMicForMix` — the ONE mic-track producer), and export reuses the preview's decoded tracks where `audio-mix.ts`'s `reusableTracks` says they are exactly what it would make. Whole-track PCM is kept on purpose: the preview must stay the export's mix. The measured ceiling and what only a Mac can settle are in the runbook; streaming PCM through a temp file is the filed follow-up |
```

- [ ] **Step 6: File option B** — list Linear issues first (memory: "List Linear issues before filing one"; search "PCM", "audio memory", "temp file"), then file in team "Studio cartelli", project "Capture", related to STC-469: "Preview audio PCM via a temp-file cache read by range", with the spec's option-B description and the measured ceiling from Step 3 as the reason it may or may not be needed.

- [ ] **Step 7: Full verification and commit**

Run: `npm run typecheck && npm test`
Expected: green.

```bash
git add scripts/measure-preview-memory.mjs scripts/make-long-audio-take.mjs docs/STC-469-RUNBOOK.md docs/TICKET-LOG.md CLAUDE.md
git commit -m "STC-469: measure preview audio memory; runbook, ceiling, ticket-log row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §1 → Tasks 2-3; §2 → Tasks 1, 4; §3 → Task 5; Testing → Tasks 1-4. Out-of-scope items untouched.
- Names used across tasks: `reusableTracks`, `ExportDecoded`, `DecodedMic`, `decodeMicForMix`, `micSource`, `rawLoading`, `ensureRawMic`, `decodedForExport`, `__stcPreviewAudio` (fields `micAudio, rawMicHeld, cleanedFor, playing, cleaning, micLength`), `__stcExportForTest({ reuse })` → `{ audioHash, audioReused }`.
- Known soft spot: the placeholder AAC decodes to near-silence, so the identity hash alone could pass on two runs of the old path — which is why `audioReused` is asserted alongside it.
