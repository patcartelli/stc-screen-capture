# STC-456 — Record options bar + device dropdowns, rebuilt to Capture SK 016

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Record options bar (and the device dropdowns it shares with the main window) to Patrick's Capture SK 016 Frame 9 design.

**Architecture:** The bar's GEOMETRY stays a pure main-process decision (`record-options.ts`), as it has been since STC-388: the overlay converts clicks to global points and hit-tests against rects the main process computed. What changes is the shape: a 340×108 two-row pane plus a separate Capture Video button underneath it. The dropdowns are the exception. They are sized to fit their text, which only the DOM can measure, so the main process decides WHERE a menu opens (an anchor point and a side), and the view lays it out with CSS and hit-tests its rows by DOM element. Both surfaces (the overlay bar and the main window's `#devicestate` popover) build their rows from ONE pure row model in `device-picker.ts`.

**Tech Stack:** TypeScript, Electron (main + renderer), vitest (pure tests), Playwright-Electron (e2e), esbuild (`app/build.mjs`).

**Spec:** Linear STC-456's description (reassessed 2026-09-28), plus [Capture SK 016, Frame 9](https://www.figma.com/design/bUFLOIAxW8Mun8AtEcf72R/Capture-SK-016?node-id=65-21) and the values Patrick gave in chat (copied into Global Constraints below).

## Global Constraints

- **Colors (bar and overlay menus):** surface `#0f0f0f`, on-surface `#ffffff`. Dark in BOTH OS appearances. The bar sits over someone else's screen (the pill's rule, STC-447).
- **Main window's dropdown:** same component and metrics, but colors from `tokens.css` (`--surface`, `--text`, …), so it follows the OS appearance.
- **Typography:** resolution field `JetBrains Mono` (`var(--font-mono)`). Everything else, INCLUDING dropdown rows, `Geist` (`var(--font-sans)`). The Figma frame shows mono dropdown rows; Patrick is changing that to Geist.
- **Pane:** 340 × 108, 16 px padding on all sides, radius 16.
- **Capture button:** 340 wide, 16 px left/right padding, 0 top/bottom, radius 16.
- **Dropdown:** width sized to fit its content.
- **Measured from the frame, not given, so tunable in one place:** row height 32 and row gap 12 inside the pane (16+32+12+32+16 = 108), capture button height 36, gap between pane and capture button 8, resolution text 24 px, UI text 13 px, dropdown row text 14 px, dropdown row height 44, icon size 20, stroke 1.5.
- **Control ids are stable where they already exist:** `size`, `expand`, `mic`, `camera`, `record` keep their names and their `#ctl-<id>` element ids. `app/test/_record-flow.ts` and six e2e files send `{ t: "control", id: "record" }` and read `#ctl-size`/`#ctl-expand`. The Record control is LABELLED "Capture Video"; its id stays `record`.
- **Out of scope, decided 2026-09-28:** no Capture Gif button (STC-395 stands), no Capture Screenshot button, no recording-profile control (STC-447), no placement animation (STC-447).
- **Keypress and click are DISABLED SLOTS.** They are laid out and drawn, never enabled, and a tooltip names the ticket (STC-419 / STC-420). Nothing reaches the helper or the transform.
- **The start-param builder in `main.ts` `recordFlowBody` stays the ONE place** a `start` request is assembled (STC-388 spec §3).
- **The overlay's CSP must allow `tokens.css` and the fonts:** `style-src 'self' 'unsafe-inline'; font-src 'self'`, as `index.html` already has.

## Review Focus

1. **Typing in the size field must not trigger the overlay's keys.** Enter commits the size, not the take. Space must not toggle window mode. Arrows must not nudge the marquee. Escape reverts the field; it does not cancel the overlay. → Task 6 routes keys by focus; Task 5 has an e2e check that a `size` event does not start a take.
2. **A size the display cannot hold** (0, empty, 99999, letters pasted in) → clamped to [MIN_SELECTION_POINTS, display], never a crash or an invisible marquee. → Task 3 tests.
3. **A press in the gap between the pane and the Capture button, or on the pane's padding,** must not start a new marquee underneath. (It does today on the old bar's padding.) → Task 2 `barContains` tests.
4. **Toggling Include System Audio must not close the menu or change the mic.** Picking Mute External must not touch system audio. → Task 1 and Task 4 tests.
5. **A stored camera uid that is no longer connected** still shows as itself, selected, rather than the menu silently showing "No Camera". → Task 1 test, reusing `deviceRows`' stale row.

---

## File map

| File | Change |
|---|---|
| `app/src/device-picker.ts` | + `MenuRow`, `micMenuRows`, `cameraMenuRows`, `applyMenuPick`. The ONE row model for both surfaces |
| `app/src/record-options.ts` | rewrite geometry: new `CONTROL_IDS`, pane + capture layout, `barContains`, `menuAnchor`, `resizeToPixels`, `parseDimension`. Remove `micMenuLayout`/`micItemAt` |
| `app/src/overlay-session.ts` | `OptionsState` gains `systemAudio`, `cameraDeviceUid`, `cameras`, `openMenu`; new events `menuPick`, `size`; controls `crop`, `settings`; `OverlayResult.afterClose` |
| `app/src/main.ts` | `recordFlowBody`: initial options, write-back, start params (`systemAudio`, `cameraDeviceUid`), `afterClose: "settings"` |
| `app/renderer/overlay.html` | new markup, icons, CSS, `tokens.css`, CSP |
| `app/renderer/device-menu.css` | NEW, the dropdown's shared CSS (both windows) |
| `app/src/icons.ts`, `scripts/vendor-icons.mjs`, `app/src/icons.LICENSE.txt` | NEW: Material Symbols Outlined w300, vendored by script at a pinned version |
| `app/src/overlay.ts` | draw the new bar and menus, size inputs, key routing |
| `app/renderer/index.html`, `app/src/renderer.ts` | main window popover uses `micMenuRows`/`cameraMenuRows` + `device-menu.css`; system audio row; `ui:open-settings` |
| `app/src/preload.ts` | expose `onOpenSettings` |
| tests | `app/test/device-picker.test.ts`, `record-options.test.ts`, `overlay-options.test.ts`, `record-flow.e2e.test.ts`, `mic-picker.e2e.test.ts` |
| docs | `docs/STC-456-RUNBOOK.md`, CLAUDE.md row, `docs/TICKET-LOG.md` row |

---

### Task 1: One dropdown row model for both surfaces

**Files:**
- Modify: `app/src/device-picker.ts`
- Test: `app/test/device-picker.test.ts`

**Interfaces:**
- Consumes: existing `deviceRows`, `DeviceChoice`, `DeviceLike`.
- Produces:
  ```ts
  export type MenuIcon = "system-audio" | "mic" | "mic-off" | "camera" | "camera-off";
  export type MenuPick = { kind: "toggle-system-audio" } | { kind: "choice"; choice: DeviceChoice };
  export interface MenuRow { key: string; pick: MenuPick; label: string; icon: MenuIcon; checked: boolean; closesMenu: boolean; }
  export interface DeviceSelection { micDeviceUid: string | null; systemAudio: boolean; camera: boolean; cameraDeviceUid: string | null; }
  export function micMenuRows(mics: DeviceLike[], s: DeviceSelection): MenuRow[];
  export function cameraMenuRows(cameras: DeviceLike[], s: DeviceSelection): MenuRow[];
  export function applyMenuPick(s: DeviceSelection, pick: MenuPick): DeviceSelection;
  export const MENU_LABELS: { systemAudio: "Include System Audio"; muteExternal: "Mute External"; noCamera: "No Camera"; autoCamera: "Automatic"; stale: "(not connected)" };
  ```

- [ ] **Step 1: Write the failing tests** (append to `app/test/device-picker.test.ts`)

```ts
import { micMenuRows, cameraMenuRows, applyMenuPick, MENU_LABELS, type DeviceSelection } from "../src/device-picker.js";

const sel = (over: Partial<DeviceSelection> = {}): DeviceSelection =>
  ({ micDeviceUid: null, systemAudio: false, camera: false, cameraDeviceUid: null, ...over });
const mics = [{ name: "Elgato Wave:3", uid: "wave" }, { name: "iPhone Microphone", uid: "iphone" }];
const cams = [{ name: "Elgato Facecam 4k", uid: "facecam" }, { name: "Camera 2", uid: "cam2" }];

describe("micMenuRows (STC-456)", () => {
  test("system audio, then Mute External, then every device — the design's order", () => {
    expect(micMenuRows(mics, sel()).map((r) => r.label)).toEqual(
      [MENU_LABELS.systemAudio, MENU_LABELS.muteExternal, "Elgato Wave:3", "iPhone Microphone"]);
  });
  test("system audio and the mic are checked INDEPENDENTLY — two checks can show at once", () => {
    const rows = micMenuRows(mics, sel({ systemAudio: true, micDeviceUid: "wave" }));
    expect(rows.filter((r) => r.checked).map((r) => r.label)).toEqual([MENU_LABELS.systemAudio, "Elgato Wave:3"]);
  });
  test("no mic chosen checks Mute External", () => {
    expect(micMenuRows(mics, sel()).find((r) => r.checked)?.label).toBe(MENU_LABELS.muteExternal);
  });
  test("toggling system audio keeps the menu open; picking a mic closes it", () => {
    const rows = micMenuRows(mics, sel());
    expect(rows[0].closesMenu).toBe(false);
    expect(rows.slice(1).every((r) => r.closesMenu)).toBe(true);
  });
  test("icons: laptop for system audio, mic-off for mute, mic for devices", () => {
    expect(micMenuRows(mics, sel()).map((r) => r.icon)).toEqual(["system-audio", "mic-off", "mic", "mic"]);
  });
  test("a stale mic uid shows as itself, checked", () => {
    const rows = micMenuRows(mics, sel({ micDeviceUid: "gone" }));
    expect(rows.at(-1)).toMatchObject({ label: MENU_LABELS.stale, checked: true });
  });
  test("keys are unique, so the DOM can find a row by key", () => {
    const keys = micMenuRows(mics, sel({ micDeviceUid: "gone" })).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("cameraMenuRows (STC-456)", () => {
  test("No Camera, Automatic, then every device", () => {
    expect(cameraMenuRows(cams, sel()).map((r) => r.label)).toEqual(
      [MENU_LABELS.noCamera, MENU_LABELS.autoCamera, "Elgato Facecam 4k", "Camera 2"]);
  });
  test("camera off checks No Camera even with a device uid stored", () => {
    const rows = cameraMenuRows(cams, sel({ camera: false, cameraDeviceUid: "facecam" }));
    expect(rows.filter((r) => r.checked).map((r) => r.label)).toEqual([MENU_LABELS.noCamera]);
  });
  test("camera on with a uid checks that device", () => {
    const rows = cameraMenuRows(cams, sel({ camera: true, cameraDeviceUid: "facecam" }));
    expect(rows.find((r) => r.checked)?.label).toBe("Elgato Facecam 4k");
  });
  test("a stored camera that is gone shows as itself, checked (Review Focus 5)", () => {
    const rows = cameraMenuRows(cams, sel({ camera: true, cameraDeviceUid: "gone" }));
    expect(rows.at(-1)).toMatchObject({ label: MENU_LABELS.stale, checked: true });
  });
  test("every camera row closes the menu", () => {
    expect(cameraMenuRows(cams, sel()).every((r) => r.closesMenu)).toBe(true);
  });
});

describe("applyMenuPick (STC-456)", () => {
  test("toggle-system-audio flips ONLY systemAudio (Review Focus 4)", () => {
    expect(applyMenuPick(sel({ micDeviceUid: "wave" }), { kind: "toggle-system-audio" }))
      .toEqual(sel({ micDeviceUid: "wave", systemAudio: true }));
  });
  test("a mic pick sets the uid and leaves system audio alone", () => {
    const s = applyMenuPick(sel({ systemAudio: true }), { kind: "choice", choice: { kind: "device", uid: "wave" } });
    expect(s).toEqual(sel({ systemAudio: true, micDeviceUid: "wave" }));
  });
  test("off from the MIC menu clears the mic; it does not turn the camera off", () => {
    const s = applyMenuPick(sel({ camera: true, micDeviceUid: "wave" }), { kind: "choice", choice: { kind: "off" }, menu: "mic" } as never);
    expect(s).toEqual(sel({ camera: true }));
  });
});
```

The last test shows the problem: `{ kind: "off" }` means different things in the two menus. Fix it in the type rather than the call site. `MenuPick` carries the menu:

```ts
export type MenuPick =
  | { kind: "toggle-system-audio" }
  | { kind: "choice"; menu: "mic" | "camera"; choice: DeviceChoice };
```

Update the tests above to pass `menu: "mic"` / `menu: "camera"` (drop the `as never`), and add:

```ts
  test("off from the CAMERA menu turns the camera off and keeps the uid", () => {
    const s = applyMenuPick(sel({ camera: true, cameraDeviceUid: "facecam" }),
      { kind: "choice", menu: "camera", choice: { kind: "off" } });
    expect(s).toEqual(sel({ camera: false, cameraDeviceUid: "facecam" }));
  });
  test("a camera device pick turns the camera ON and sets the uid", () => {
    expect(applyMenuPick(sel(), { kind: "choice", menu: "camera", choice: { kind: "device", uid: "cam2" } }))
      .toEqual(sel({ camera: true, cameraDeviceUid: "cam2" }));
  });
  test("Automatic turns the camera on with a null uid (the helper's pickCamera ranking)", () => {
    expect(applyMenuPick(sel({ cameraDeviceUid: "cam2" }), { kind: "choice", menu: "camera", choice: { kind: "auto" } }))
      .toEqual(sel({ camera: true, cameraDeviceUid: null }));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run app/test/device-picker.test.ts`
Expected: FAIL. `micMenuRows` is not exported.

- [ ] **Step 3: Implement** (append to `app/src/device-picker.ts`, and add a paragraph to the file header: STC-456 made this the ONE row model for the bar's menus AND the main window's popover)

```ts
export const MENU_LABELS = {
  systemAudio: "Include System Audio",
  muteExternal: "Mute External",
  noCamera: "No Camera",
  autoCamera: "Automatic",
  stale: "(not connected)",
} as const;

export type MenuIcon = "system-audio" | "mic" | "mic-off" | "camera" | "camera-off";
export type MenuPick =
  | { kind: "toggle-system-audio" }
  | { kind: "choice"; menu: "mic" | "camera"; choice: DeviceChoice };
export interface MenuRow {
  /** Stable and unique within one menu: what the DOM row carries as data-key. */
  key: string;
  pick: MenuPick;
  label: string;
  icon: MenuIcon;
  checked: boolean;
  /** A toggle keeps the menu open; a choice closes it. */
  closesMenu: boolean;
}
export interface DeviceSelection {
  micDeviceUid: string | null;
  systemAudio: boolean;
  camera: boolean;
  cameraDeviceUid: string | null;
}

const keyOf = (c: DeviceChoice): string => (c.kind === "device" ? `device:${c.uid}` : c.kind);

export function micMenuRows(mics: DeviceLike[], s: DeviceSelection): MenuRow[] {
  const current: DeviceChoice = s.micDeviceUid == null ? { kind: "off" } : { kind: "device", uid: s.micDeviceUid };
  const choices = deviceRows({ devices: mics, current, offLabel: MENU_LABELS.muteExternal, staleLabel: MENU_LABELS.stale });
  return [
    { key: "system-audio", pick: { kind: "toggle-system-audio" }, label: MENU_LABELS.systemAudio,
      icon: "system-audio", checked: s.systemAudio, closesMenu: false },
    ...choices.map((r): MenuRow => ({
      key: keyOf(r.choice), pick: { kind: "choice", menu: "mic", choice: r.choice }, label: r.label,
      icon: r.choice.kind === "off" ? "mic-off" : "mic", checked: r.selected, closesMenu: true,
    })),
  ];
}

export function cameraMenuRows(cameras: DeviceLike[], s: DeviceSelection): MenuRow[] {
  const current: DeviceChoice = !s.camera ? { kind: "off" }
    : s.cameraDeviceUid == null ? { kind: "auto" } : { kind: "device", uid: s.cameraDeviceUid };
  return deviceRows({ devices: cameras, current, offLabel: MENU_LABELS.noCamera,
                      autoLabel: MENU_LABELS.autoCamera, staleLabel: MENU_LABELS.stale })
    .map((r): MenuRow => ({
      key: keyOf(r.choice), pick: { kind: "choice", menu: "camera", choice: r.choice }, label: r.label,
      icon: r.choice.kind === "off" ? "camera-off" : "camera", checked: r.selected, closesMenu: true,
    }));
}

/** What a row press does to the selection: the ONE place, for both surfaces. */
export function applyMenuPick(s: DeviceSelection, pick: MenuPick): DeviceSelection {
  if (pick.kind === "toggle-system-audio") return { ...s, systemAudio: !s.systemAudio };
  const c = pick.choice;
  if (pick.menu === "mic") return { ...s, micDeviceUid: c.kind === "device" ? c.uid : null };
  if (c.kind === "off") return { ...s, camera: false };
  return { ...s, camera: true, cameraDeviceUid: c.kind === "device" ? c.uid : null };
}
```

The stale camera row's `choice` is `{ kind: "device", uid: "gone" }`, so its key is `device:gone`, the same shape as a connected device. `deviceRows` already appends it only when the uid is missing from `devices`, so keys stay unique.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run app/test/device-picker.test.ts`
Expected: PASS, including the existing `deviceRows`/`decidePopoverToggle` tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/device-picker.ts app/test/device-picker.test.ts
git commit -m "STC-456: one dropdown row model for the bar and the main window"
```

---

### Task 2: The bar's new geometry

**Files:**
- Modify: `app/src/record-options.ts`
- Test: `app/test/record-options.test.ts`

**Interfaces:**
- Consumes: `Rect`, `DisplayInfo`, `Point`, `rectContains` from `selection.ts`.
- Produces:
  ```ts
  export type ControlId = "size" | "expand" | "crop" | "settings" | "mic" | "camera" | "keys" | "clicks" | "record";
  export const CONTROL_IDS: readonly ControlId[];
  export const PANE_WIDTH = 340, PANE_HEIGHT = 108, PANE_PADDING = 16, CAPTURE_GAP = 8, CAPTURE_HEIGHT = 36;
  export const BAR_HEIGHT: number; // PANE_HEIGHT + CAPTURE_GAP + CAPTURE_HEIGHT = 152
  export interface BarLayout { rect: Rect; pane: Rect; capture: Rect; placement: "below" | "above" | "inside"; controls: readonly { id: ControlId; rect: Rect }[]; }
  export function barLayout(selection: Rect, display: DisplayInfo): BarLayout;
  export function barContains(p: Point, layout: BarLayout): boolean;
  export function controlAt(p: Point, layout: BarLayout): ControlId | undefined;
  export function controlEnabled(id: ControlId, s: { mics: readonly unknown[] }): boolean;
  export type MenuId = "mic" | "camera";
  export interface MenuAnchor { menu: MenuId; x: number; y: number; side: "below" | "above"; }
  export function menuAnchor(layout: BarLayout, menu: MenuId, display: DisplayInfo): MenuAnchor;
  ```
  `barWidth()` is removed. The width is `PANE_WIDTH`. `micMenuLayout`/`micItemAt`/`MicMenuLayout` are removed; Task 4 removes their last caller.

- [ ] **Step 1: Rewrite the tests.** Keep the four placement-rule tests and "always fully inside the display" / "global points" tests unchanged apart from these edits: replace `barWidth()` with `PANE_WIDTH`; `BAR_HEIGHT` now means the whole block. Replace the `describe("the controls")` and `describe("the mic menu")` blocks with:

```ts
describe("the controls (STC-456)", () => {
  const sel = { x: 400, y: 300, width: 400, height: 200 };
  const l = barLayout(sel, display);

  test("the pane is 340 × 108 and the capture button sits 8 below it, full width", () => {
    expect(l.pane).toMatchObject({ width: 340, height: 108 });
    expect(l.capture).toMatchObject({ x: l.pane.x, width: 340, height: CAPTURE_HEIGHT });
    expect(l.capture.y).toBe(l.pane.y + 108 + CAPTURE_GAP);
    expect(l.rect).toEqual({ x: l.pane.x, y: l.pane.y, width: 340, height: BAR_HEIGHT });
  });
  test("every control id is laid out exactly once, in CONTROL_IDS order", () => {
    expect(l.controls.map((c) => c.id)).toEqual([...CONTROL_IDS]);
  });
  test("every pane control sits inside the pane's 16px padding", () => {
    for (const c of l.controls.filter((c) => c.id !== "record")) {
      expect(c.rect.x).toBeGreaterThanOrEqual(l.pane.x + 16);
      expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(l.pane.x + 340 - 16);
      expect(c.rect.y).toBeGreaterThanOrEqual(l.pane.y + 16);
      expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(l.pane.y + 108 - 16);
    }
  });
  test("row 1 is size, expand, crop; row 2 is settings, mic, camera, keys, clicks", () => {
    const y = (id: string) => l.controls.find((c) => c.id === id)!.rect.y;
    for (const id of ["expand", "crop"]) expect(y(id)).toBe(y("size"));
    for (const id of ["mic", "camera", "keys", "clicks"]) expect(y(id)).toBe(y("settings"));
    expect(y("settings")).toBeGreaterThan(y("size"));
  });
  test("record IS the capture button", () => {
    expect(l.controls.find((c) => c.id === "record")!.rect).toEqual(l.capture);
  });
  test("controls do not overlap each other", () => {
    for (const a of l.controls) for (const b of l.controls) {
      if (a !== b) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
  });
  test("a press finds the control under it", () => {
    for (const c of l.controls) {
      expect(controlAt({ x: c.rect.x + c.rect.width / 2, y: c.rect.y + c.rect.height / 2 }, l)).toBe(c.id);
    }
  });
  test("the gap between pane and button is NOT the bar, and so not a swallowed press", () => {
    const gap = { x: l.pane.x + 170, y: l.pane.y + 108 + CAPTURE_GAP / 2 };
    expect(barContains(gap, l)).toBe(false);
    expect(controlAt(gap, l)).toBeUndefined();
  });
  test("the pane's own padding IS the bar: a press there is swallowed, not a new marquee (Review Focus 3)", () => {
    const padding = { x: l.pane.x + 4, y: l.pane.y + 4 };
    expect(barContains(padding, l)).toBe(true);
    expect(controlAt(padding, l)).toBeUndefined();
  });
  test("keys and clicks are always disabled; mic needs a mic", () => {
    expect(controlEnabled("keys", { mics: [{}] })).toBe(false);
    expect(controlEnabled("clicks", { mics: [{}] })).toBe(false);
    expect(controlEnabled("mic", { mics: [] })).toBe(false);
    expect(controlEnabled("mic", { mics: [{}] })).toBe(true);
    expect(controlEnabled("camera", { mics: [] })).toBe(true);
  });
});

describe("where a menu opens (STC-456)", () => {
  // Patrick, 2026-09-28: below its trigger, OVER the capture button.
  test("drops from the trigger's bottom-left, 4 below it", () => {
    const l = barLayout({ x: 200, y: 200, width: 300, height: 200 }, display);
    const trig = l.controls.find((c) => c.id === "mic")!.rect;
    expect(menuAnchor(l, "mic", display)).toEqual(
      { menu: "mic", side: "below", x: trig.x, y: trig.y + trig.height + MENU_GAP });
  });
  test("it covers the capture button rather than avoiding it", () => {
    const l = barLayout({ x: 200, y: 200, width: 300, height: 200 }, display);
    const a = menuAnchor(l, "camera", display);
    expect(a.y).toBeLessThan(l.capture.y + l.capture.height);
  });
  test("flips ABOVE the trigger when a full menu would run off the display's bottom", () => {
    // Bar placed low: the marquee fills the display, so the bar sits inside at the bottom.
    const l = barLayout(display.bounds, display);
    const trig = l.controls.find((c) => c.id === "mic")!.rect;
    const a = menuAnchor(l, "mic", display);
    expect(a.side).toBe("above");
    expect(a.y).toBe(trig.y - MENU_GAP);
  });
});
```

(Import `PANE_WIDTH`, `CAPTURE_GAP`, `CAPTURE_HEIGHT`, `MENU_GAP`, `barContains`, `menuAnchor`; drop `barWidth`, `micItemAt`, `micMenuLayout`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run app/test/record-options.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Implement.** Replace the geometry section and the mic-menu section of `record-options.ts`. Keep `barLayout`'s placement logic byte for byte; only `width` and the control loop change.

```ts
export type ControlId =
  | "size" | "expand" | "crop" | "settings" | "mic" | "camera" | "keys" | "clicks" | "record";

/** Row 1, then row 2, then the capture button (STC-456, Capture SK 016 Frame 9). */
export const CONTROL_IDS: readonly ControlId[] =
  ["size", "expand", "crop", "settings", "mic", "camera", "keys", "clicks", "record"];

// Given by Patrick (2026-09-28): the pane and its padding.
export const PANE_WIDTH = 340;
export const PANE_HEIGHT = 108;
export const PANE_PADDING = 16;
// Measured from the frame, not given. Tune here, nowhere else.
const ROW_HEIGHT = 32;
const ROW_GAP = 12;
const ICON_CONTROL = 32;
const CARET_CONTROL = 48;          // icon + ▾
export const CAPTURE_GAP = 8;
export const CAPTURE_HEIGHT = 36;
export const MENU_GAP = 4;
/** The tallest a menu is expected to be (6 rows of 44 + padding), for the
 * below/above decision only. The view sizes the menu; this is an upper bound. */
const MENU_MAX_HEIGHT = 280;

/** The whole block the placement rules move: pane + gap + capture button. */
export const BAR_HEIGHT = PANE_HEIGHT + CAPTURE_GAP + CAPTURE_HEIGHT;

const ROW2: readonly { id: ControlId; w: number }[] = [
  { id: "settings", w: ICON_CONTROL }, { id: "mic", w: CARET_CONTROL },
  { id: "camera", w: CARET_CONTROL }, { id: "keys", w: ICON_CONTROL }, { id: "clicks", w: ICON_CONTROL },
];

function paneControls(pane: Rect): { id: ControlId; rect: Rect }[] {
  const inner = { x: pane.x + PANE_PADDING, y: pane.y + PANE_PADDING,
                  width: PANE_WIDTH - PANE_PADDING * 2 };
  const y1 = inner.y, y2 = inner.y + ROW_HEIGHT + ROW_GAP;
  const right = inner.x + inner.width;
  const crop = { x: right - ICON_CONTROL, y: y1, width: ICON_CONTROL, height: ROW_HEIGHT };
  const expand = { x: crop.x - 8 - ICON_CONTROL, y: y1, width: ICON_CONTROL, height: ROW_HEIGHT };
  // 16 before expand: room for the hairline divider the view draws there.
  const size = { x: inner.x, y: y1, width: expand.x - 16 - inner.x, height: ROW_HEIGHT };
  const used = ROW2.reduce((n, c) => n + c.w, 0);
  const gap = (inner.width - used) / (ROW2.length - 1);
  let x = inner.x;
  const row2 = ROW2.map((c) => {
    const r = { id: c.id, rect: { x, y: y2, width: c.w, height: ROW_HEIGHT } };
    x += c.w + gap;
    return r;
  });
  return [{ id: "size", rect: size }, { id: "expand", rect: expand }, { id: "crop", rect: crop }, ...row2];
}
```

In `barLayout`: `const width = PANE_WIDTH;`, and replace the control loop with:

```ts
  const pane: Rect = { x, y, width: PANE_WIDTH, height: PANE_HEIGHT };
  const capture: Rect = { x, y: y + PANE_HEIGHT + CAPTURE_GAP, width: PANE_WIDTH, height: CAPTURE_HEIGHT };
  const controls = [...paneControls(pane), { id: "record" as const, rect: capture }];
  return { rect: { x, y, width: PANE_WIDTH, height: BAR_HEIGHT }, pane, capture, placement, controls };
```

Then:

```ts
/** A press the bar swallows: on the pane (padding included) or the capture
 * button, never the gap between them, which is the user's screen. */
export function barContains(p: Point, layout: BarLayout): boolean {
  return rectContains(layout.pane, p) || rectContains(layout.capture, p);
}

export function controlAt(p: Point, layout: BarLayout): ControlId | undefined {
  if (!barContains(p, layout)) return undefined;
  return layout.controls.find((c) => rectContains(c.rect, p))?.id;
}

/** Keys and clicks are slots for STC-419/STC-420: laid out now so the bar
 * does not change shape when they land, and never enabled until then. */
export function controlEnabled(id: ControlId, s: { mics: readonly unknown[] }): boolean {
  if (id === "keys" || id === "clicks") return false;
  if (id === "mic") return s.mics.length > 0;
  return true;
}

export type MenuId = "mic" | "camera";
export interface MenuAnchor { menu: MenuId; x: number; y: number; side: "below" | "above"; }

/**
 * Where a menu opens: dropping from its trigger's bottom-left and OVER the
 * capture button (Patrick, 2026-09-28). Flipped above the trigger only when a
 * menu of MENU_MAX_HEIGHT would run off the display's bottom — the bar's
 * `inside` placement at the bottom edge is the case that forces it. `y` is the
 * menu's NEAR edge: its top when below, its bottom when above. The view sizes
 * the menu to fit and clamps it horizontally, since only it knows the width.
 */
export function menuAnchor(layout: BarLayout, menu: MenuId, display: DisplayInfo): MenuAnchor {
  const trig = layout.controls.find((c) => c.id === menu)!.rect;
  const b = display.bounds;
  const below = trig.y + trig.height + MENU_GAP;
  if (below + MENU_MAX_HEIGHT <= b.y + b.height - BAR_MARGIN) {
    return { menu, side: "below", x: trig.x, y: below };
  }
  return { menu, side: "above", x: trig.x, y: trig.y - MENU_GAP };
}
```

Delete `CONTROL_WIDTHS`, `BAR_PADDING`, `CONTROL_GAP`, `CONTROL_HEIGHT`, `barWidth`, `MIC_ITEM_HEIGHT`, `MIC_MENU_WIDTH`, `MicMenuLayout`, `micMenuLayout`, `micItemAt`, and the `micLabel`/`MicInfo` import if nothing else uses it. Remove `micMenuOpen` from `OptionsState` here; Task 4 moves `OptionsState` onto its new shape. For THIS task, change `OptionsState`'s `micMenuOpen: boolean` to `openMenu: MenuId | null` so it compiles.

- [ ] **Step 4: Run the pure tests** (`overlay-session.ts`/`overlay.ts` will not typecheck until Tasks 4 and 6, which is expected)

Run: `npx vitest run app/test/record-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/record-options.ts app/test/record-options.test.ts
git commit -m "STC-456: the bar's geometry — a 340x108 pane over a capture button"
```

---

### Task 3: Typing a size

**Files:**
- Modify: `app/src/record-options.ts`
- Test: `app/test/record-options.test.ts`

**Interfaces:**
- Consumes: `MIN_SELECTION_POINTS` from `selection.ts`, `pixelSize`.
- Produces:
  ```ts
  export function parseDimension(text: string): number | undefined; // digits only, >0
  export function resizeToPixels(anchor: Rect, display: DisplayInfo, widthPx: number, heightPx: number): Rect;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("typing a size (STC-456)", () => {
  // scaleFactor 2: 1 pt = 2 px.
  test("parseDimension keeps digits and refuses everything else", () => {
    expect(parseDimension("1440")).toBe(1440);
    expect(parseDimension(" 1440 ")).toBe(1440);
    expect(parseDimension("")).toBeUndefined();
    expect(parseDimension("0")).toBeUndefined();
    expect(parseDimension("14a0")).toBeUndefined();
    expect(parseDimension("-5")).toBeUndefined();
    expect(parseDimension("1e3")).toBeUndefined();
  });
  test("resizes around the marquee's centre, and the readout shows what was typed", () => {
    const anchor = { x: 400, y: 300, width: 400, height: 200 };
    const r = resizeToPixels(anchor, display, 1000, 600);
    expect(r).toEqual({ x: 350, y: 250, width: 500, height: 300 });
    expect(sizeLabel(r, display)).toBe("1000 × 600");
  });
  test("an odd pixel count on a 2x display rounds to a whole point", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 1001, 601);
    expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
  });
  test("larger than the display clamps to the display (Review Focus 2)", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 99999, 99999);
    expect(r).toEqual(display.bounds);
  });
  test("tiny clamps UP to MIN_SELECTION_POINTS, never to an invisible marquee", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 1, 1);
    expect(r.width).toBe(MIN_SELECTION_POINTS);
    expect(r.height).toBe(MIN_SELECTION_POINTS);
  });
  test("growing near an edge shifts the rect back inside rather than clipping it", () => {
    const r = resizeToPixels({ x: 1500, y: 900, width: 100, height: 100 }, display, 800, 400);
    expect(r).toEqual({ x: 1200, y: 800, width: 400, height: 200 });
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run app/test/record-options.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** A typed dimension: digits only, positive. Anything else is "not a number
 * yet", and the field reverts rather than guessing. */
export function parseDimension(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
}

/**
 * The marquee after the user types a size in PIXELS (the unit the readout
 * shows, `sizeLabel`), in global POINTS. Centred on the old anchor, whole
 * points, at least MIN_SELECTION_POINTS, at most the display, then shifted
 * (never shrunk) to sit inside it.
 */
export function resizeToPixels(anchor: Rect, display: DisplayInfo,
                               widthPx: number, heightPx: number): Rect {
  const b = display.bounds;
  const s = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const w = clamp(Math.round(widthPx / s), MIN_SELECTION_POINTS, b.width);
  const h = clamp(Math.round(heightPx / s), MIN_SELECTION_POINTS, b.height);
  const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2;
  const x = clamp(Math.round(cx - w / 2), b.x, b.x + b.width - w);
  const y = clamp(Math.round(cy - h / 2), b.y, b.y + b.height - h);
  return { x, y, width: w, height: h };
}
```

(Import `MIN_SELECTION_POINTS` from `./selection.js`.)

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/record-options.ts app/test/record-options.test.ts
git commit -m "STC-456: typing a size resizes the marquee around its centre"
```

---

### Task 4: The session: menus, size, crop, settings

**Files:**
- Modify: `app/src/record-options.ts` (`OptionsState`), `app/src/overlay-session.ts`
- Test: `app/test/overlay-options.test.ts`

**Interfaces:**
- Consumes: Task 1 `applyMenuPick`, `MenuPick`, `DeviceSelection`; Task 2 `menuAnchor`, `MenuId`; Task 3 `resizeToPixels`.
- Produces:
  ```ts
  // record-options.ts
  export interface OptionsState extends DeviceSelection {
    mics: readonly MicInfo[]; cameras: readonly DeviceLike[];
    fullDisplay: boolean; openMenu: MenuId | null;
  }
  // overlay-session.ts
  export type OverlayEvent = SelectionEvent
    | { t: "control"; id: ControlId }
    | { t: "menuPick"; pick: MenuPick }
    | { t: "menuClose" }
    | { t: "size"; width: number; height: number };
  export interface OverlayResult { outcome; excludeWindowIds; options?: OptionsState; afterClose?: "settings"; }
  export function toggleMenu(open: MenuId | null, clicked: MenuId): MenuId | null; // = decidePopoverToggle
  export function sizedState(state: SelectionState, anchor: Rect, display: DisplayInfo, w: number, h: number): SelectionState;
  export function croppedState(state: SelectionState): SelectionState;
  ```
  `initialOptions` becomes `Pick<OptionsState, "micDeviceUid" | "camera" | "mics" | "systemAudio" | "cameraDeviceUid" | "cameras">`.
  The overlay payload's `micMenu` is replaced by `menu?: { anchor: MenuAnchor; rows: MenuRow[] }`.

- [ ] **Step 1: Write the failing tests** (append to `app/test/overlay-options.test.ts`)

```ts
import { sizedState, croppedState, toggleMenu } from "../src/overlay-session.js";

describe("the bar's own events (STC-456)", () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2 };

  test("a typed size in region mode resizes the marquee and stays in region mode", () => {
    const s = { ...initialState("region"), rect: { x: 400, y: 300, width: 400, height: 200 } };
    const out = sizedState(s, s.rect!, display, 1000, 600);
    expect(out.mode).toBe("region");
    expect(out.rect).toEqual({ x: 350, y: 250, width: 500, height: 300 });
  });
  test("a typed size with a WINDOW picked becomes a region of that size, centred on the window", () => {
    const s = { ...initialState("window"), hoveredWindowId: 7 };
    const win = { x: 100, y: 100, width: 600, height: 400 };
    const out = sizedState(s, win, display, 400, 400);
    expect(out.mode).toBe("region");
    expect(out.rect).toEqual({ x: 300, y: 200, width: 200, height: 200 });
  });
  test("crop clears the marquee and returns to region drawing", () => {
    const s = { ...initialState("window"), rect: { x: 1, y: 1, width: 10, height: 10 } };
    const out = croppedState(s);
    expect(out.mode).toBe("region");
    expect(out.rect).toBeUndefined();
    expect(out.drag).toBeUndefined();
  });
  test("one menu at a time: the other trigger switches, the same one closes", () => {
    expect(toggleMenu(null, "mic")).toBe("mic");
    expect(toggleMenu("mic", "mic")).toBeNull();
    expect(toggleMenu("mic", "camera")).toBe("camera");
  });
});
```

(Check `SelectionState`'s drag field name in `selection.ts` before writing `croppedState`. Use whatever the reducer uses for "no drag in progress".)

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run app/test/overlay-options.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

In `record-options.ts`, replace `OptionsState`:

```ts
import type { DeviceLike, DeviceSelection } from "./device-picker.js";

export interface OptionsState extends DeviceSelection {
  /** What the mic menu can offer. Empty disables the mic control outright. */
  mics: readonly MicInfo[];
  /** What the camera menu can offer. Empty still offers No Camera / Automatic. */
  cameras: readonly DeviceLike[];
  /** (keep the existing fullDisplay doc comment verbatim) */
  fullDisplay: boolean;
  /** Which menu is open, if any. One at a time. */
  openMenu: MenuId | null;
}
```

In `overlay-session.ts`:

```ts
import { decidePopoverToggle, applyMenuPick, micMenuRows, cameraMenuRows, type MenuPick } from "./device-picker.js";
import { menuAnchor, resizeToPixels, type MenuId } from "./record-options.js";
import { micLabel } from "./mic-devices.js";

export const toggleMenu = (open: MenuId | null, clicked: MenuId): MenuId | null =>
  decidePopoverToggle(open, clicked);

export function sizedState(state: SelectionState, anchor: Rect, display: DisplayInfo,
                           w: number, h: number): SelectionState {
  return { ...state, mode: "region", rect: resizeToPixels(anchor, display, w, h), drag: undefined };
}

export function croppedState(state: SelectionState): SelectionState {
  return { ...state, mode: "region", rect: undefined, drag: undefined };
}
```

In `onEvent`, before the selection reducer:

```ts
    if (ev.t === "menuPick") {
      const next = applyMenuPick(this.options, ev.pick);
      const closes = ev.pick.kind !== "toggle-system-audio";
      this.options = { ...this.options, ...next, openMenu: closes ? null : this.options.openMenu };
      return this.broadcast();
    }
    if (ev.t === "menuClose") {
      this.options = { ...this.options, openMenu: null };
      return this.broadcast();
    }
    if (ev.t === "size") return this.onSize(ev.width, ev.height);
```

```ts
  /** A size typed into the bar (STC-456). The field sends pixels; `sizedState`
   * turns them into a region. It is a marquee change like a handle drag, so
   * it clears `fullDisplay` through the same `fullDisplayFor` rule and
   * re-confirms `pending` the way `expand` does. */
  private onSize(width: number, height: number): void {
    if (this.phase !== "options") return;
    const anchor = this.anchorRect();
    const d = this.displayForSelection();
    if (!anchor || !d) return;
    const prevRect = this.state.rect;
    this.state = sizedState(this.state, anchor, d, width, height);
    this.options = { ...this.options,
      fullDisplay: fullDisplayFor(this.options.fullDisplay, false, prevRect, this.state.rect) };
    const outcome = confirm(this.state, this.ctx);
    if (outcome) this.setPending(outcome);
    this.broadcast();
  }
```

`onControl`: `size` stays a no-op (the view focuses the field itself). Add:

```ts
      case "crop":
        // Back to drawing a region. The options phase ends with it: a fresh
        // release re-enters it through nextPhase, exactly as the first one did.
        this.state = croppedState(this.state);
        this.phase = "select";
        this.setPending(undefined);
        this.options = { ...this.options, fullDisplay: false, openMenu: null };
        return this.broadcast();
      case "settings":
        this.afterClose = "settings";
        return void this.finish({ kind: "cancelled" });
      case "mic":
        if (this.options.mics.length === 0) return;
        this.options = { ...this.options, openMenu: toggleMenu(this.options.openMenu, "mic") };
        return this.broadcast();
      case "camera":
        this.options = { ...this.options, openMenu: toggleMenu(this.options.openMenu, "camera") };
        return this.broadcast();
      case "keys":
      case "clicks":
        return;   // disabled slots, STC-419 / STC-420
```

Every place that set `micMenuOpen: false` now sets `openMenu: null`. Add `private afterClose: "settings" | undefined;` and include `...(this.afterClose ? { afterClose: this.afterClose } : {})` in `finish`'s `settle`. Add `afterClose?: "settings"` to `OverlayResult`.

Constructor:

```ts
    this.options = {
      micDeviceUid: opts.initialOptions?.micDeviceUid ?? null,
      camera: opts.initialOptions?.camera ?? false,
      systemAudio: opts.initialOptions?.systemAudio ?? false,
      cameraDeviceUid: opts.initialOptions?.cameraDeviceUid ?? null,
      mics: opts.initialOptions?.mics ?? [],
      cameras: opts.initialOptions?.cameras ?? [],
      fullDisplay: false,
      openMenu: null,
    };
```

`push()`: replace `micMenu: …` with

```ts
      menu: layout && d && this.options.openMenu ? {
        anchor: menuAnchor(layout, this.options.openMenu, d),
        rows: this.options.openMenu === "mic"
          ? micMenuRows(this.options.mics.map((m) => ({ name: micLabel(m), uid: m.uid })), this.options)
          : cameraMenuRows([...this.options.cameras], this.options),
      } : undefined,
```

Delete the `micPick` event variant and its handler.

- [ ] **Step 4: Run tests and the typecheck for the main pass**

Run: `npx vitest run app/test/overlay-options.test.ts app/test/record-options.test.ts app/test/device-picker.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: errors ONLY in `app/src/overlay.ts` (Task 6) and `app/src/main.ts` `initialOptions` (Task 5). Anything else is a real break; fix it now.

- [ ] **Step 5: Commit**

```bash
git add app/src/record-options.ts app/src/overlay-session.ts app/test/overlay-options.test.ts
git commit -m "STC-456: session handles menus, typed size, crop and settings"
```

---

### Task 5: `main.ts`: what the bar reads, writes back, and sends

**Files:**
- Modify: `app/src/main.ts` (`recordFlowBody`, and a `camerasForBar` beside `micsForBar`), `app/src/preload.ts`
- Test: `app/test/record-flow.e2e.test.ts`

**Interfaces:**
- Consumes: Task 4 `OverlayResult.afterClose`, `OptionsState` fields.
- Produces: IPC `ui:open-settings` (main → main window renderer), and `window.recorder.onOpenSettings(cb)` in preload. The exact bridge name follows whatever `preload.ts` already exposes; read it first.

- [ ] **Step 1: Write the failing e2e tests.** Read `app/test/_record-flow.ts` for how a test drives the bar and reads the helper's `start` request (the existing "picking a window records THAT window — start sends its windowId" test shows the pattern). Add to `record-flow.e2e.test.ts`:

```ts
describe("system audio and the camera device reach start (STC-456, absorbs STC-459)", () => {
  test("Include System Audio on → start carries systemAudio: true, and it is written back", async () => {
    // drive: open the record flow, release a region, then
    //   send({ t: "control", id: "mic" }) and send({ t: "menuPick", pick: { kind: "toggle-system-audio" } }),
    //   then send({ t: "control", id: "record" })
    // assert: the recorded start request has systemAudio === true,
    //   and settings.json's systemAudio is true.
  });
  test("off → the key is ABSENT, not false (the existing pin)", async () => { /* same, without the toggle */ });
  test("a camera picked on the bar → start carries camera: true and that cameraDeviceUid", async () => {
    // send({ t: "menuPick", pick: { kind: "choice", menu: "camera", choice: { kind: "device", uid: "<a fake uid>" } } })
  });
  test("a typed size does NOT start a take (Review Focus 1)", async () => {
    // send({ t: "size", width: 800, height: 600 }); wait one broadcast;
    // assert: no start request, and #ctl-size's text is "800 × 600".
  });
  test("Settings closes the overlay without a take and opens the settings sheet", async () => {
    // send({ t: "control", id: "settings" });
    // assert: no start request, overlay windows gone (_windows.ts hasWindow),
    //   and the main window's #profilesheet is open.
  });
});
```

Write each body in full, using the helpers that file already uses; the comments above state what each must do and assert. How to read the start request is decided by what `_record-flow.ts` already exposes; do not invent a second seam. If it cannot read `start` params, extend `_record-flow.ts` rather than adding a helper here.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run app/test/record-flow.e2e.test.ts -t "STC-456"`. Expected: FAIL. (e2e needs `npm run build` first; see `package.json`'s test script for the exact prerequisite.)

- [ ] **Step 3: Implement** in `recordFlowBody`:

```ts
  const cameras = await camerasForBar();
  const { outcome, options, afterClose } = await openOverlay({
    windows, mode: "region", purpose: "record",
    initialOptions: {
      micDeviceUid: stored.micDeviceUid, camera: stored.camera, mics,
      systemAudio: stored.systemAudio, cameraDeviceUid: stored.cameraDeviceUid, cameras,
    },
    dist: here, renderer: join(here, "..", "renderer"),
  });
  if (afterClose === "settings") { openSettingsSheet(); return { ok: false, cancelled: true }; }
  if (outcome.kind === "cancelled" || !options) return { ok: false, cancelled: true };

  writeSettings(app.getPath("userData"), {
    camera: options.camera, micDeviceUid: options.micDeviceUid,
    systemAudio: options.systemAudio, cameraDeviceUid: options.cameraDeviceUid,
  });
```

In the start-param builder, the `cameraDeviceUid` and `systemAudio` lines read `options.*` instead of `stored.*`. Update both comments: the bar HAS these controls now (STC-456), and STC-459 is folded in.

```ts
async function camerasForBar(): Promise<DeviceLike[]> {
  try {
    const r = await sup!.devices();
    const cams = (r as { cameras?: unknown }).cameras;
    return Array.isArray(cams) ? cams as DeviceLike[] : [];
  } catch {
    return [];
  }
}
```

Make ONE `sup.devices()` call for both lists, not two: change `micsForBar` into `devicesForBar(): Promise<{ mics: MicInfo[]; cameras: DeviceLike[] }>` and update its caller (the line that computes `mics` before `recordFlowBody`). Two calls would enumerate CoreAudio twice, and STC-233 records it stalling.

`openSettingsSheet()`: show and focus the main window (reuse the existing "show main window" helper `main.ts` already has for the tray), then `win.webContents.send("ui:open-settings")`. In `preload.ts` expose `onOpenSettings(cb)` on the existing bridge; in `renderer.ts` subscribe and call the same function the profile button's click handler calls to open `#profilesheet`.

- [ ] **Step 4: Run.** `npm run typecheck` (only `overlay.ts` errors may remain), then the e2e file. Expected: the new tests PASS, and every existing record-flow test still PASSES.

- [ ] **Step 5: Commit**

```bash
git add app/src/main.ts app/src/preload.ts app/src/renderer.ts app/test/record-flow.e2e.test.ts app/test/_record-flow.ts
git commit -m "STC-456: the bar's system audio and camera reach start; Settings opens the sheet"
```

---

### Task 6: The overlay's view

**Files:**
- Create: `app/renderer/device-menu.css`
- Modify: `app/renderer/overlay.html`, `app/src/overlay.ts`, `app/build.mjs` (only if renderer CSS is copied rather than served in place; check how `tokens.css` reaches `index.html`)

**Interfaces:**
- Consumes: payload `{ bar, options, menu?: { anchor: MenuAnchor; rows: MenuRow[] } }`; events from Task 4.
- Produces: DOM ids `#pane`, `#ctl-<id>` for every `ControlId`, `#size-w`, `#size-h` (inputs inside `#ctl-size`), `#menu` with `[data-key]` rows.

- [ ] **Step 1: `device-menu.css`**, shared by both windows. Colors are variables the host sets.

```css
/* The device dropdown (STC-456). One component for the Record options bar
   (dark, forced) and the main window's #devicestate popover (follows the OS).
   The host sets --menu-surface / --menu-on-surface; everything else is here. */
.device-menu {
  position: fixed; box-sizing: border-box; z-index: 10;
  width: max-content; min-width: 200px; max-width: 320px;
  padding: 4px 0; border-radius: 16px;
  background: var(--menu-surface); color: var(--menu-on-surface);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
  font: 400 14px/1 var(--font-sans);
}
.device-menu .row {
  display: flex; align-items: center; gap: 12px;
  height: 44px; padding: 0 16px; cursor: default; white-space: nowrap;
}
.device-menu .row:hover { background: color-mix(in srgb, var(--menu-on-surface) 8%, transparent); }
.device-menu .row .label { flex: 1; }
.device-menu .row svg { width: 20px; height: 20px; flex: none; opacity: .72; }
.device-menu .row .check { visibility: hidden; opacity: 1; }
.device-menu .row[aria-checked="true"] .check { visibility: visible; }
```

- [ ] **Step 2: `overlay.html`.** CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'`. Add `<link rel="stylesheet" href="tokens.css">` and `<link rel="stylesheet" href="device-menu.css">`. `tokens.css` sets `:root` colors and `font-family`; the overlay body must stay transparent, so re-assert `background: transparent` on `html, body` after the link (the existing rule does; keep it below the links). Replace the `#bar`/`#micmenu` CSS and markup:

```css
  :root { --menu-surface: #0f0f0f; --menu-on-surface: #ffffff; }
  #bar { position: fixed; pointer-events: none; }
  #pane, #ctl-record {
    position: fixed; box-sizing: border-box; border-radius: 16px;
    background: #0f0f0f; color: #ffffff; pointer-events: auto;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
    font: 400 13px/1 var(--font-sans);
  }
  .ctl { position: fixed; display: flex; align-items: center; justify-content: center;
         border-radius: 8px; color: rgba(255,255,255,.72); pointer-events: auto; }
  .ctl:hover { color: #fff; background: rgba(255,255,255,.08); }
  .ctl[data-on="1"] { color: #fff; }
  .ctl[data-enabled="0"] { opacity: .32; }
  .ctl[data-enabled="0"]:hover { background: none; }
  .ctl svg { width: 20px; height: 20px; }
  .ctl .caret { width: 10px; height: 10px; margin-left: 2px; }
  #ctl-size { justify-content: flex-start; gap: 8px; color: #fff;
              font: 400 24px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
  #ctl-size input { all: unset; width: 4ch; font: inherit; color: inherit; caret-color: #fff; }
  #ctl-size input:focus { box-shadow: 0 1px 0 rgba(255,255,255,.6); }
  #ctl-size .x { opacity: .72; }
  #ctl-expand::before { content: ""; position: absolute; left: -9px; top: 6px; bottom: 6px;
                        width: 1px; background: rgba(255,255,255,.18); }
  #ctl-record { justify-content: flex-start; gap: 10px; padding: 0 16px; color: #fff; }
  #ctl-record .label { flex: 1; }
  #ctl-record .kbd { opacity: .56; }
```

Markup: `#pane` is a background element with no children, so positioned children stay in global→local coordinates like every other control. Each `.ctl` is a sibling:

```html
  <div id="bar" hidden>
    <div id="pane"></div>
    <div class="ctl" id="ctl-size"><input id="size-w" inputmode="numeric" aria-label="Width in pixels"><span class="x">×</span><input id="size-h" inputmode="numeric" aria-label="Height in pixels"></div>
    <div class="ctl" id="ctl-expand" title="Whole display">ICON:expand</div>
    <div class="ctl" id="ctl-crop" title="Select an area">ICON:crop</div>
    <div class="ctl" id="ctl-settings" title="Settings">ICON:sliders</div>
    <div class="ctl" id="ctl-mic" aria-label="Microphone">ICON:mic ICON:caret</div>
    <div class="ctl" id="ctl-camera" aria-label="Camera">ICON:camera ICON:caret</div>
    <div class="ctl" id="ctl-keys" title="Show keypresses — coming with STC-419">ICON:command</div>
    <div class="ctl" id="ctl-clicks" title="Show clicks — coming with STC-420">ICON:click</div>
    <div class="ctl" id="ctl-record">ICON:record<span class="label">Capture Video</span><span class="kbd">ICON:return</span></div>
  </div>
  <div id="menu" class="device-menu" hidden role="menu"></div>
```

Icons are **Material Symbols, Outlined, weight 300** (Patrick, 2026-09-28), vendored from `@material-symbols/svg-300` (Apache-2.0) at a PINNED version by a script, never hand-copied:

- Create `scripts/vendor-icons.mjs`. It runs `npm pack @material-symbols/svg-300@0.47.5` into a temp dir, extracts `package/outlined/<name>.svg` for each entry of the map below, keeps only the `d` of each `<path>` (their viewBox is `0 -960 960 960`), and writes `app/src/icons.ts`. Its header names the package, the version, the weight, and the licence, and says it is GENERATED and edited only by re-running the script. Commit the generated file; the build does not fetch anything.
- `app/src/icons.ts` (generated, node-free, so both renderers can import it):

  ```ts
  export type Glyph = "expand" | "crop" | "settings" | "mic" | "mic-off" | "camera" | "camera-off"
    | "system-audio" | "command" | "click" | "record" | "return" | "caret" | "check";
  const PATHS: Record<Glyph, string> = { /* generated */ };
  /** One glyph as an inline SVG, 20x20, filled with currentColor. */
  export function iconSvg(g: Glyph, cls = ""): string {
    return `<svg class="${cls}" viewBox="0 -960 960 960" aria-hidden="true"><path d="${PATHS[g]}"/></svg>`;
  }
  ```

| Glyph | Material Symbol |
|---|---|
| expand | `open_in_full` |
| crop | `crop` |
| settings | `tune` |
| mic / mic-off | `mic` / `mic_off` |
| camera / camera-off | `videocam` / `videocam_off` |
| system-audio | `laptop_mac` |
| command | `keyboard_command_key` |
| click | `ads_click` |
| record | `radio_button_checked` |
| return | `keyboard_return` |
| caret | `keyboard_arrow_down` |
| check | `check` |

All 14 were checked present in 0.47.5 on 2026-09-28. Add the Apache-2.0 notice as `app/src/icons.LICENSE.txt`, copied from the package's own `LICENSE`.

In the markup, each `ICON:name` above becomes `<span data-icon="name"></span>` (caret: `<span data-icon="caret" data-class="caret"></span>`). At startup `overlay.ts` replaces every `[data-icon]` with `iconSvg(name, cls)`. There is no second copy of any path in HTML. The CSS for glyphs is `fill: currentColor` (Material Symbols are filled outlines, not strokes). Replace `stroke`-based rules if any were written.

`MenuIcon` (Task 1) is a subset of `Glyph`. `renderMenu` and `renderer.ts` call `iconSvg(r.icon)` and `iconSvg("check", "check")`.

- [ ] **Step 3: `overlay.ts`.** Replace `renderBar`, and the micmenu parts of the pointerdown handler.

```ts
import { barContains, controlAt, controlEnabled, parseDimension, sizeLabel,
         type BarLayout, type ControlId, type MenuAnchor, type OptionsState } from "./record-options.js";
import type { MenuRow } from "./device-picker.js";
import { iconSvg } from "./icons.js";
import { pixelSize } from "./selection.js";

const pane = $("pane"), menuEl = $("menu");
const sizeW = $("size-w") as HTMLInputElement, sizeH = $("size-h") as HTMLInputElement;

function placeAt(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`; el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
}

function renderBar(p: OverlayPayload): void {
  if (p.phase !== "options" || !p.bar || !p.options || !p.display) {
    bar.hidden = true; menuEl.hidden = true; return;
  }
  bar.hidden = false;
  placeAt(pane, toLocal(p.bar.pane));
  for (const c of p.bar.controls) {
    const el = ctl(c.id);
    placeAt(el, toLocal(c.rect));
    el.dataset.enabled = controlEnabled(c.id, p.options) ? "1" : "0";
  }
  // The field shows the live size unless the user is typing in it: a
  // broadcast mid-edit must not overwrite what they have typed so far.
  const px = p.anchor ? pixelSize(p.anchor, p.display) : undefined;
  if (document.activeElement !== sizeW) sizeW.value = px ? String(px.width) : "";
  if (document.activeElement !== sizeH) sizeH.value = px ? String(px.height) : "";
  ctl("size").dataset.label = p.anchor ? sizeLabel(p.anchor, p.display) : "—";
  ctl("expand").dataset.on = p.options.fullDisplay ? "1" : "0";
  ctl("mic").dataset.on = p.options.micDeviceUid != null ? "1" : "0";
  ctl("camera").dataset.on = p.options.camera ? "1" : "0";
  // Trigger glyph follows the state: mic-off when muted, camera-off when off.
  ctl("mic").querySelector("svg:first-child")!.outerHTML = iconSvg(p.options.micDeviceUid != null ? "mic" : "mic-off");
  ctl("camera").querySelector("svg:first-child")!.outerHTML = iconSvg(p.options.camera ? "camera" : "camera-off");
  renderMenu(p.menu);
}

function renderMenu(m: { anchor: MenuAnchor; rows: MenuRow[] } | undefined): void {
  if (!m) { menuEl.hidden = true; return; }
  menuEl.replaceChildren(...m.rows.map((r) => {
    const row = document.createElement("div");
    row.className = "row"; row.dataset.key = r.key;
    row.setAttribute("role", r.closesMenu ? "menuitemradio" : "menuitemcheckbox");
    row.setAttribute("aria-checked", String(r.checked));
    row.innerHTML = `${iconSvg(r.icon)}<span class="label"></span>${iconSvg("check", "check")}`;
    row.querySelector(".label")!.textContent = r.label;
    return row;
  }));
  menuEl.hidden = false;
  const a = { x: m.anchor.x - origin.x, y: m.anchor.y - origin.y };
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  const top = m.anchor.side === "below" ? a.y : a.y - h;
  menuEl.style.left = `${Math.max(8, Math.min(a.x, window.innerWidth - w - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
}
```

`ctl("size").textContent` is gone. `#ctl-size` now holds inputs, so the e2e tests that read `#ctl-size`'s text must read its `data-label` instead. Update them (`record-flow.e2e.test.ts`'s "dragging a handle changes #ctl-size" and friends) in this task; the test logic stays the same.


Pointerdown (replace the options-phase block):

```ts
  if (current?.phase === "options" && current.bar) {
    const row = (e.target as Element).closest?.("#menu .row") as HTMLElement | null;
    if (row && current.menu) {
      const hit = current.menu.rows.find((r) => r.key === row.dataset.key);
      if (hit) send({ t: "menuPick", pick: hit.pick });
      return;
    }
    const g = toGlobal(e);
    const hit = controlAt(g, current.bar);
    if (current.menu && hit !== "mic" && hit !== "camera") send({ t: "menuClose" });
    if (hit === "size") return;            // the input takes focus by default
    if (hit) {
      if (controlEnabled(hit, current.options!)) send({ t: "control", id: hit });
      return;
    }
    if (barContains(g, current.bar) || current.menu) return;   // Review Focus 3
  }
```

Keys: the size inputs own their keys (Review Focus 1). At the top of the `keydown` listener:

```ts
  const t = e.target as HTMLElement;
  if (t === sizeW || t === sizeH) {
    if (e.key === "Enter") { e.preventDefault(); commitSize(); t.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); t.blur(); render(current!); }  // revert
    return;   // nothing typed in the field reaches the selection reducer
  }
  if (e.key === "Escape" && current?.menu) { e.preventDefault(); send({ t: "menuClose" }); return; }
```

```ts
function commitSize(): void {
  const w = parseDimension(sizeW.value), h = parseDimension(sizeH.value);
  if (w === undefined || h === undefined) { if (current) render(current); return; }
  send({ t: "size", width: w, height: h });
}
for (const f of [sizeW, sizeH]) {
  // Numbers only, as typed: strip anything else the moment it lands (a paste included).
  f.addEventListener("input", () => { f.value = f.value.replace(/\D+/g, "").slice(0, 5); });
  f.addEventListener("focus", () => f.select());
  // Leaving the pair commits; Tab from W to H does not.
  f.addEventListener("blur", (ev) => {
    const to = ev.relatedTarget;
    if (to !== sizeW && to !== sizeH) commitSize();
  });
}
```

Escape is the tricky case: blur fires during Escape, and `commitSize` would commit the half-typed value. Set a `let reverting = false` flag in the Escape branch before `t.blur()`, skip `commitSize` in the blur handler while it is set, then clear it.

The Enter in the size field must NOT reach the existing forwarder (`send({ t: "key", key: "Enter" })`, which confirms and, in the options phase, could re-confirm). The early `return` above guarantees that. The legend's options-phase text becomes: `Adjust selection · <kbd>Return</kbd> Capture Video · <kbd>Esc</kbd> cancel`. Check what Return does in the options phase in `selection.ts`/`overlay-session.ts` first. If Return does not currently commit Record in the options phase, keep "Click **Capture Video**" and do NOT add a Return binding in this ticket; say so in the runbook.

- [ ] **Step 4: Build and typecheck**

Run: `npm run typecheck && node app/build.mjs`
Expected: clean. Then `npx vitest run app/test/record-flow.e2e.test.ts app/test/still-overlay.e2e.test.ts`. Expected: PASS. The still overlay has no bar and must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/overlay.html app/renderer/device-menu.css app/src/overlay.ts app/src/icons.ts app/src/icons.LICENSE.txt scripts/vendor-icons.mjs app/test/record-flow.e2e.test.ts
git commit -m "STC-456: draw the new bar, its menus, and the typed size field"
```

---

### Task 7: The main window's popover joins the component

**Files:**
- Modify: `app/renderer/index.html`, `app/src/renderer.ts`
- Test: `app/test/mic-picker.e2e.test.ts`, `app/test/camera-toggle.e2e.test.ts` (read both first; update selectors only where the row markup changed)

**Interfaces:**
- Consumes: Task 1 `micMenuRows`, `cameraMenuRows`, `applyMenuPick`; Task 6 `device-menu.css`, `iconSvg`.

- [ ] **Step 1: Write the failing e2e test** in `mic-picker.e2e.test.ts`:

```ts
test("the mic popover offers Include System Audio, and toggling it persists without closing (STC-456)", async () => {
  // open #mic-picker; the first row's text is "Include System Audio";
  // click it; the popover is still open; its aria-checked is now "true";
  // settings.json has systemAudio: true.
});
```

Write the body with the helpers that file already uses.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** In `index.html`, link `device-menu.css`, give `#devicepopover` the `device-menu` class, and set `--menu-surface: var(--surface); --menu-on-surface: var(--text)` on it. Delete the old `#devicepopover` / `#devicepopover button` rules (the STC-414 block). Keep `.devicepicker-trigger`. In `renderer.ts`, the block at `:293` that calls `deviceRows(...)` becomes `micMenuRows(knownMics, selection)` / `cameraMenuRows(knownCameras, selection)`, where `selection` is built from the current settings. Rows are drawn exactly as `overlay.ts`'s `renderMenu` draws them: same classes, same `data-key`, same `aria-checked`, same `iconSvg`. A row click runs `applyMenuPick`, writes the changed fields through the existing settings-write IPC, and closes the popover only when `row.closesMenu`. The popover stays anchored under its trigger (not beside anything). That positioning code is unchanged.

- [ ] **Step 4: Run** `npx vitest run app/test/mic-picker.e2e.test.ts app/test/camera-toggle.e2e.test.ts app/test/device-picker.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/index.html app/src/renderer.ts app/test/mic-picker.e2e.test.ts app/test/camera-toggle.e2e.test.ts
git commit -m "STC-456: main window popover uses the shared dropdown, gains system audio"
```

---

### Task 8: Runbook, CLAUDE.md, ticket log, full suite

**Files:**
- Create: `docs/STC-456-RUNBOOK.md`
- Modify: `CLAUDE.md` (the "Where things are" table), `docs/TICKET-LOG.md`

- [ ] **Step 1: `docs/STC-456-RUNBOOK.md`.** Branch name at the top. Numbered checks, each with what it must show:
  1. Bar against the frame, side by side: pane 340×108, radius 16, `#0f0f0f`, JetBrains Mono size, Geist elsewhere. Screenshot it in both OS appearances; it must be dark in both.
  2. Icons: Material Symbols Outlined w300. Check each reads at 20 px on the dark pane.
  3. Size field: click W, type `1280`, Tab, type `720`, Return. The marquee resizes around its centre and no take starts. Type letters: nothing appears. Escape mid-edit: the old value returns and the overlay stays open.
  4. Crop: returns to drawing; a new drag brings the bar back.
  5. Settings: the overlay closes and the main window opens with the settings sheet.
  6. Mic menu: drops below its button, over Capture Video, and flips above it when the bar sits at the bottom of the screen. Toggling Include System Audio keeps it open. Record → `system.m4a` exists in the take.
  7. Camera menu: pick a named camera, Record → that camera is in the take.
  8. Keypress / click: visibly disabled, tooltips name STC-419 / STC-420.
  9. Main window popover: same rows, follows light/dark.
  10. A press in the pane's padding does not start a new marquee.
- [ ] **Step 2: CLAUDE.md row** for `app/src/record-options.ts` + `device-picker.ts` + `device-menu.css` (STC-456): the two-row pane, the one dropdown component, menus positioned by main but sized by the DOM, keypress/click slots, and STC-459 folded in. **TICKET-LOG row** for STC-456.
- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm test`
Expected: green. Report the actual counts. A failure is reported with its output, not described.

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/STC-456-RUNBOOK.md CLAUDE.md docs/TICKET-LOG.md
git commit -m "STC-456: runbook, CLAUDE.md and ticket log"
git push -u origin HEAD
gh pr create --base master --title "STC-456: Record options bar + device dropdowns, rebuilt to Capture SK 016"
```

Then hand Patrick the runbook WITH the branch name (CLAUDE.md, "Hand off a runbook WITH its branch").

---

## Decisions, confirmed by Patrick 2026-09-28

1. **Menus drop BELOW their trigger and OVER the capture button.** They flip above the trigger only when the bar sits at the bottom of the display. The main window's popover stays under its trigger, as it is today.
2. **The camera menu keeps an "Automatic" row** between No Camera and the devices. It was left out of the frame by accident.
3. **The mic and camera triggers change glyph with state:** mic-off when muted, camera-off when off.
4. **Return in the size field commits the size**, never the take.
5. **Presses on the bar's own padding are swallowed**, never a new marquee.
6. **Icons are Material Symbols Outlined, weight 300.**
