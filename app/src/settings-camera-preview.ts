import { PreviewController, type PreviewPort, type PreviewView } from "./camera-preview.js";

/**
 * The Settings > Camera pane's live view (STC-638 slice 3). Electron-free: main
 * wires the helper port and the window sends, and every rule is tested without
 * either.
 *
 * It is the camera menu's preview (`PreviewController`) with a different
 * owner, and the helper runs ONE preview at a time, so the owners take turns:
 *
 *  1. **Wanted only while the pane is being looked at**: the Camera pane shown
 *     AND the window focused (the renderer says so; `requested`). A Settings
 *     window left behind another app has no business lighting the camera.
 *  2. **The record bar wins** (`suspend`/`resume`): while the overlay is up its
 *     own preview owns the helper, so this one stops first (commands reach the
 *     helper in order) and comes back when the bar closes, if the pane is
 *     still being looked at.
 *  3. **Never during a take** (`blocked`): the helper refuses a preview then
 *     anyway; asking would only show "Camera is in use".
 *  4. **The stored device**: the one the record bar will use (`uid`, null =
 *     automatic). Changing it in the bar is not seen here until the next sync.
 */
export interface SettingsPreviewHost {
  port: PreviewPort;
  /** The camera uid the bar will record with, read when a preview starts. */
  uid(): string | null;
  /** True while a take is recording or starting. */
  blocked(): boolean;
  /** The view changed (starting / live / unavailable / off). */
  onView(view: PreviewView): void;
}

export class SettingsCameraPreview {
  private requested = false;
  private suspended = false;
  private readonly controller: PreviewController;

  constructor(private readonly host: SettingsPreviewHost) {
    this.controller = new PreviewController(host.port, () => host.onView(this.controller.view));
  }

  get view(): PreviewView { return this.controller.view; }

  /** The renderer's word: the Camera pane is (not) being looked at. */
  request(on: boolean): void {
    this.requested = on;
    this.sync();
  }

  /** The record bar is opening: let go of the helper. */
  suspend(): void {
    this.suspended = true;
    this.sync();
  }

  /** The record bar closed: take the helper back if still wanted. */
  resume(): void {
    this.suspended = false;
    this.sync();
  }

  /** The Settings window closed. */
  close(): void {
    this.requested = false;
    this.sync();
  }

  /** A picture from the helper. True when the window should get it. */
  frame(): boolean { return this.controller.frame(); }

  /** The helper ended the preview itself. */
  stopped(reason: string): void { this.controller.stopped(reason); }

  private sync(): void {
    const want = this.requested && !this.suspended && !this.host.blocked();
    this.controller.sync(want ? { uid: this.host.uid() } : null);
  }
}
