/**
 * What to tell the user when a Record or a shot did not happen — ONE mapping
 * from a refusal to its sentence, for every door (STC-465 review).
 *
 * There are four doors into a capture: the main window's buttons, the
 * menu-bar item, and the global hotkeys (Record, and each shot action). This
 * mapping used to live in `renderer.ts`, which meant only the WINDOW door
 * could say anything: `main.ts` discarded the menu-bar Record's result
 * outright, the Record hotkey only `console.error`ed it, and a hotkey or
 * menu-bar shot was reported only if a main window happened to be open to
 * receive `still:captured`. In a menu-bar-first app (STC-292) the window is
 * usually CLOSED, so the normal way to use the app was the one way that could
 * count down, refuse — no grant, say — and show nothing at all: an entire demo
 * recorded into nothing.
 *
 * Pure — no Electron, no DOM — because both processes need it: the renderer
 * (typechecked by `tsconfig.browser.json`) for the window door, and main
 * (`tsconfig.node.json`) for the others, which it announces itself with the
 * same message toast the window's `alertUser` already reaches. One module, so
 * a refusal cannot read one way from the window and another from the menu bar.
 */

/**
 * Why a take did not start, said in terms of what it costs and what to do.
 *
 * A map rather than the ternary chain this replaced: there are two permission
 * refusals now, they read almost identically to a user ("something about
 * privacy settings"), and they send you to DIFFERENT panes. A chain that grows
 * one arm per grant is how the second one ends up phrased as an afterthought
 * of the first.
 *
 * Neither says "try again" without saying what to change first — a start that
 * refused for a missing grant will refuse identically until the grant exists,
 * and inviting a retry is how someone presses Record four times and concludes
 * the app is broken.
 */
export const START_FAULTS: Record<string, string> = {
  // STC-391: a shot is mid-flight — most likely a self-timer, which
  // now spends seconds waiting with this window still live and pressable.
  "capture-in-flight":
    "A shot is already in progress. Finish or cancel it, then press Record.",
  "no-displays":
    "Screen Recording permission is required.\nGrant it in System Settings › " +
    "Privacy & Security › Screen & System Audio Recording, then try again.",
  // STC-315. This used to be a WARNING, arriving after the take was already
  // running: the recording went ahead with no cursor track at all, and since
  // the pixels never carry a pointer (the transform draws it from events.json)
  // the resulting file looked like every other take and had no cursor
  // anywhere. It is a refusal now — nothing was recorded — so the sentence has
  // to say that first, before the fix, or a user reads "grant this" and
  // assumes the take they just made is fine.
  //
  // The wording changed once macOS was WATCHED doing this (2026-09-09, on
  // hardware after `tccutil reset ListenEvent`). Two things were wrong with
  // the first draft, and both were guesses this file could not check from
  // Linux:
  //
  // (1) It assumed `tapCreate` fails SILENTLY and sent the reader to System
  //     Settings. It does not — macOS raises its own Input Monitoring prompt.
  //     So the first refusal a user ever sees usually has a dialog on screen
  //     next to it, and a message that ignores that sends them hunting through
  //     Settings for something they could have answered in place.
  //
  // (2) That prompt says "receive KEYSTROKES from any application". This app
  //     has never recorded a keypress — the tap's mask is mouse-only, and
  //     STC-327 exists precisely because nothing here captures keyboard input
  //     — but macOS's dialog is generic and cannot say so. Somebody reading
  //     that for a screen recorder has every reason to click Deny, and until
  //     now nothing told them otherwise. Naming the discrepancy is not
  //     reassurance for its own sake: it is the difference between a grant
  //     that gets given and one that gets refused for a sound reason.
  //
  // "Quit and reopen" rather than "press Record again", deliberately. Input
  // Monitoring commonly needs the granted process restarted, and that has NOT
  // been observed for THIS app: the runs that established the prompt went
  // through the terminal (which is the granted identity for a directly-spawned
  // helper), and `npm run app:start` makes the app a child of the terminal and
  // resolves to its grants too — STC-292's runbook already records that trap.
  // Only a bundle launched via `open` can settle it. So the instruction is the
  // one that is sufficient in EITHER case rather than the shorter one that
  // might send someone in a circle.
  "event-tap-unavailable":
    "Nothing was recorded — the take did not start.\n\nThe recorder could not " +
    "watch your mouse, and the cursor is never captured in the video itself: it " +
    "is drawn afterwards from what the tap records. A take without it would have " +
    "no cursor at all, so it is refused rather than made.\n\nmacOS may have just " +
    "asked to allow this — its dialog says \"keystrokes\", but this app records " +
    "mouse movement and clicks only, and never what you type.\n\nAllow it, or " +
    "tick the recorder under System Settings › Privacy & Security › Input " +
    "Monitoring. Then quit and reopen the recorder and press Record.",
};

/** The shape every door's Record answer shares (`main.ts`'s `RecordResult`). */
export interface RecordOutcome {
  ok: boolean;
  cancelled?: boolean;
  code?: string;
  detail?: string;
}

/**
 * The sentence for a Record that did not start, or `undefined` when there is
 * nothing to say:
 *
 *  - it DID start;
 *  - it was cancelled (Escape on the overlay or the countdown) — the user
 *    asked for nothing to happen, and telling them so would be the app arguing
 *    with them (STC-391);
 *  - `record-in-flight`: this same Record's own overlay or countdown is
 *    already on screen, and a second press of the key or the menu item while
 *    it is up is not a failure to report — the flow in front of the user is
 *    the answer. Saying anything here would also float a toast over the very
 *    overlay the user is framing a take with (the toast is not excluded from
 *    a capture).
 */
export function recordRefusalText(r: RecordOutcome): string | undefined {
  if (r.ok || r.cancelled || r.code === "record-in-flight") return undefined;
  const code = String(r.code);
  return START_FAULTS[code] ?? `Could not start: ${code}\n${r.detail ?? ""}`;
}

/** The shape every door's shot answer shares (`main.ts`'s `StillResult`). */
export interface StillOutcome {
  ok: boolean;
  cancelled?: boolean;
  code?: string;
  detail?: string;
  warning?: string;
}

/**
 * The sentence for a shot that did not happen — or, for one that did, the
 * helper's own warning about it (an alpha warning, say) — and `undefined`
 * when there is nothing to say, including a cancelled selection, which has
 * never produced a message (the way dismissing macOS's own crosshair does
 * not).
 */
export function stillNoticeText(r: StillOutcome): string | undefined {
  if (r.cancelled) return undefined;
  if (r.ok) return r.warning || undefined;
  return r.code === "no-displays"
    ? "Screen Recording permission is required.\nGrant it in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
    : r.code === "still-unsupported"
    ? "Shots need macOS 14 or newer."
    : r.code === "overlay-open"
    ? "A shot is already in progress."
    : `Could not take the shot: ${r.code}\n${r.detail ?? ""}`;
}
