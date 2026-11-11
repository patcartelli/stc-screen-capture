/**
 * The live camera view's decisions on the app side (STC-638). No DOM, no
 * Electron, no helper: `overlay-session.ts` wires it, the overlay window draws
 * it, and every rule here is tested without either.
 *
 * Patrick's decision (2026-11-10): the preview starts when the CAMERA MENU opens
 * and stops when it closes, so the camera's light is on only while someone is
 * choosing. The menu stays open on a pick (STC-583), so a pick that changes the
 * device RESTARTS the preview on the new one, and picking Off ends it.
 *
 *  1. **Wanted** (`previewWanted`): the camera menu is open AND the camera is on.
 *     Camera Off has nothing to show, so no preview and no light.
 *  2. **One transition at a time** (`previewTransition`): asked-for state vs.
 *     wanted state; a different device is a `start` (the helper replaces the old
 *     preview), the same device is nothing.
 *  3. **The view starts `starting` and stays there until a frame arrives**, not
 *     until the helper says `camera-preview-started`: that reply means the
 *     session is running, and a cold camera (an Elgato measured 3.2 s) can still
 *     be a moment from its first picture. A user looking at a blank tile needs to
 *     read "starting", not "broken".
 *  4. **A late answer never wins** (`gen`): a start that finishes after the menu
 *     closed, or after another device was picked, is ignored, and so is a frame
 *     that arrives after a stop.
 *  5. **A refusal is shown, not retried**: no Camera grant, no such camera, a
 *     helper that is busy. The view says so in a sentence (`previewLine`) and
 *     nothing is retried until the want changes.
 *
 * The preview never reaches a take, `render()` or an export: its frames travel
 * main -> overlay window and are drawn to a canvas, and that is all.
 */

/** What the view is showing. */
export type PreviewView =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "unavailable"; code: string };

/** The device the preview should show; `null` is "automatic" (the helper's pick). */
export interface PreviewWant { uid: string | null }

/** Rule 1. */
export function previewWanted(o: {
  openMenu: string | null; camera: boolean; cameraDeviceUid: string | null;
}): PreviewWant | null {
  return o.openMenu === "camera" && o.camera ? { uid: o.cameraDeviceUid } : null;
}

/** Rule 2. */
export function previewTransition(asked: PreviewWant | null, want: PreviewWant | null): "none" | "start" | "stop" {
  if (!want) return asked ? "stop" : "none";
  if (!asked) return "start";
  return asked.uid === want.uid ? "none" : "start";
}

/** The sentence for a tile that has no picture. Never a raw helper code. */
export function previewLine(v: PreviewView): string {
  switch (v.kind) {
    case "off": return "";
    case "starting": return "Starting camera…";
    case "live": return "";
    case "unavailable":
      switch (v.code) {
        case "camera-not-authorized": return "Camera access is off";
        case "camera-not-found": return "Camera not found";
        case "camera-no-device": return "No camera available";
        case "device-lost": return "Camera disconnected";
        case "bad-state": return "Camera is in use";
        default: return "Camera unavailable";
      }
  }
}

/** The helper's reliable stop reasons (`CameraPreviewDecisions.swift`'s `PreviewStopReason`). */
export type PreviewStopReason = "stopped" | "take-started" | "timeout" | "device-lost";

/** What the controller needs from the outside: the two helper commands. */
export interface PreviewPort {
  /** Resolves once the preview is running; rejects with an error carrying the helper's `code`. */
  start(uid: string | null): Promise<void>;
  stop(): Promise<void>;
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && c ? c : "camera-failed";
};

/**
 * Rules 2-5 as one object, so the ordering (who may speak after whom) is tested
 * with plain promises. `onChange` is called whenever `view` changes; the caller
 * redraws and calls `sync` again, which is why `sync` is idempotent.
 */
export class PreviewController {
  private asked: PreviewWant | null = null;
  private gen = 0;
  private current: PreviewView = { kind: "off" };

  constructor(private readonly port: PreviewPort, private readonly onChange: () => void) {}

  get view(): PreviewView { return this.current; }

  private set(v: PreviewView): void {
    const same = v.kind === this.current.kind
      && (v.kind !== "unavailable" || (this.current as { code?: string }).code === v.code);
    this.current = v;
    if (!same) this.onChange();
  }

  /** Make the helper match `want`. Idempotent. */
  sync(want: PreviewWant | null): void {
    const t = previewTransition(this.asked, want);
    if (t === "none") return;
    const gen = ++this.gen;
    if (t === "stop") {
      this.asked = null;
      this.set({ kind: "off" });
      this.port.stop().catch(() => {});
      return;
    }
    this.asked = want;
    this.set({ kind: "starting" });
    this.port.start(want!.uid).then(
      () => { /* running; the picture is what moves `starting` to `live` */ },
      (e) => { if (gen === this.gen) this.set({ kind: "unavailable", code: codeOf(e) }); },
    );
  }

  /**
   * A frame arrived. True when it should be forwarded to the window: one that
   * belongs to a preview still wanted (rule 4).
   */
  frame(): boolean {
    if (!this.asked) return false;
    if (this.current.kind === "unavailable") return false;
    this.set({ kind: "live" });
    return true;
  }

  /** The helper ended the preview on its own (`camera-preview-stopped` with no command). */
  stopped(reason: string): void {
    if (!this.asked) return;
    this.gen++;
    if (reason === "device-lost") {
      // Kept asked: nothing is retried until the want changes (rule 5).
      this.set({ kind: "unavailable", code: "device-lost" });
      return;
    }
    // timeout / take-started / anything else: forget it, so the next `sync` with the
    // same want starts it again (a menu left open past the helper's guard keeps its view).
    this.asked = null;
    this.set({ kind: "off" });
  }

  /** The overlay is closing: stop whatever is running. */
  close(): void { this.sync(null); }
}

/**
 * Rule-of-thirds guide lines inside a `w` x `h` picture, as segments. Pure so the
 * numbers are tested; the overlay draws each twice (a dark line under a light one)
 * so the guides hold their contrast on any picture (STC-497's 3:1).
 */
export function thirdsLines(w: number, h: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const x1 = w / 3, x2 = (2 * w) / 3, y1 = h / 3, y2 = (2 * h) / 3;
  return [
    { x1, y1: 0, x2: x1, y2: h }, { x1: x2, y1: 0, x2, y2: h },
    { x1: 0, y1, x2: w, y2: y1 }, { x1: 0, y1: y2, x2: w, y2 },
  ];
}

/**
 * The tile the menu grows by. The menu is a fixed 280 px wide (`device-menu.css`),
 * the tile is 16:9 inside an 8 px inset (264 wide -> 148.5), plus a margin above
 * and below. Named here so `menuHeight` and the CSS cannot drift apart silently;
 * `overlay.html` holds the same numbers and `record-options.test.ts` checks them.
 */
export const PREVIEW_TILE_WIDTH = 264;
export const PREVIEW_TILE_HEIGHT = 148;
export const PREVIEW_TILE_MARGIN_TOP = 8;
export const PREVIEW_TILE_MARGIN_BOTTOM = 4;
export const PREVIEW_EXTRA_HEIGHT = PREVIEW_TILE_HEIGHT + PREVIEW_TILE_MARGIN_TOP + PREVIEW_TILE_MARGIN_BOTTOM;
