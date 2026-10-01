/**
 * A recording's Copy, rendered (STC-488). Loads the take through
 * `session-io.ts` (the editor's own loader) and runs the unchanged
 * `exportSession` with the take's project: the default one, since a panel
 * only ever shows an unedited take. Never shown; cancelled by main
 * destroying this window, so nothing here listens for a cancel.
 */
import { loadTake, type TakeIO } from "./session-io.js";
import { exportSession } from "@transform/export";

declare global {
  interface Window {
    copyRender: TakeIO & {
      captureId(): Promise<string>;
      progress(done: number, total: number): void;
      write(bytes: ArrayBuffer): Promise<void>;
      failed(detail: string): void;
    };
  }
}

/** At most 10 progress messages a second: the panel draws a bar, not a frame counter. */
const PROGRESS_EVERY_MS = 100;

/**
 * Test seam: `STC_COPY_RENDER_DELAY_MS`, read by main and passed as `delayMs`.
 * The 5 s fixture renders in a second or two, so without it a test can't
 * reliably see a render IN PROGRESS: its progress bar, its locked buttons, or
 * a Trash landing mid-render. The natural trigger is a long take, which no
 * test can afford, the same reason STC_COUNTDOWN_FAULT exists. Zero/absent in
 * the product.
 */
const delayMs = Number(new URLSearchParams(location.search).get("delayMs")) || 0;

void (async () => {
  const io = window.copyRender;
  try {
    if (delayMs > 0) {
      io.progress(0, 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const { session, project } = await loadTake(io);
    let captureId: string | undefined;
    try { captureId = await io.captureId(); }
    catch (e) { console.error("[copy] could not resolve a capture id:", e); }
    let last = 0;
    const result = await exportSession(session, project, {
      captureId,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - last < PROGRESS_EVERY_MS && done < total) return;
        last = now;
        io.progress(done, total);
      },
    });
    if (!result.encoded) throw new Error("the export produced no file");
    await io.write(result.encoded.buffer.slice(
      result.encoded.byteOffset, result.encoded.byteOffset + result.encoded.byteLength) as ArrayBuffer);
  } catch (e: any) {
    io.failed(String(e?.message ?? e));
  }
})();
