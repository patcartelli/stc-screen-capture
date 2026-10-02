import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutCountdown } from "./_countdown-fixture.js";
import { toastPage, toastText } from "./_toast.js";
import { MESSAGE_TOAST_MIN_MS } from "../src/toast.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";
import { startRecordFlow } from "./_record-flow.js";

/**
 * A warning the helper sends on its reliable channel reaches the user, and a
 * refusal the helper answers a `start` with stops the take from happening.
 *
 * The renderer's handler matched a handful of codes and dropped the rest. The
 * one that hurt: `event-tap-unavailable`. The captured pixels carry no cursor
 * by design, so a take whose input tap never installed has no cursor anywhere,
 * and it looked exactly like a good take while it was being recorded.
 *
 * STC-315 moved that code from a warning to a REFUSAL, and the tests moved
 * with it. The first one below used to assert "the take carries on" — that was
 * a correct statement of the old contract, and relaxing it into "an alert
 * appeared" would have kept the file green while saying nothing about the only
 * thing that changed. It asserts the new contract instead: no take at all.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launchReady(env: Record<string, string>) {
  // An EMPTY recordings root, deliberately: the refusal test reads this
  // directory back to prove no take was created, and seeding it with a fixture
  // take would make "is it empty?" unanswerable. Nothing in this file opens a
  // take, so nothing needs one.
  const recordings = mkdtempSync(join(tmpdir(), "stc-takes-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", ...env },
  });
  // A stopped take leaves a fresh panel now (STC-487), so a quit raises the
  // "unsaved takes" warning (STC-392 D8). Unstubbed it is a real modal and
  // app.close() waits on it until closeApp gives up.
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
  return { win, recordings };
}

async function launchAndPressRecord(env: Record<string, string>, door: "window" | "menu-bar" = "window") {
  const { win, recordings } = await launchReady(env);
  // STC-388: `#record` opens the overlay; the bar's own Record starts the take.
  await startRecordFlow(app!, win, { door });
  return { win, recordings };
}

async function recordWithWarning(code: string, extraEnv: Record<string, string> = {}) {
  const { win } = await launchAndPressRecord({ STC_FAKE_WARNING: code, ...extraEnv });
  await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");
  return win;
}

describe("a start the helper refuses (STC-315)", () => {
  test("no cursor telemetry means no take, and the user is told before it did not happen", async () => {
    const { win, recordings } = await launchAndPressRecord({
      STC_FAKE_START_ERROR: "event-tap-unavailable",
    });

    // The TEXT is polled, not just the window: the toast window is listed as
    // soon as it commits navigation, before its DOM exists, and `toastText`
    // answers "" until then (`_toast.ts`). Reading once after the window
    // appeared raced that on PR #272's CI run.
    await expect.poll(() => toastText(app!), { timeout: 10_000 }).toMatch(/Nothing was recorded/);
    const alert = await toastText(app!);
    // What it cost FIRST. A message that opens with the fix reads as advice
    // about the next take and lets someone assume the one they just made is
    // fine — and there is no take, which is the entire point of the ticket.
    expect(alert).toMatch(/Nothing was recorded/);
    expect(alert).toMatch(/did not start/);
    // ...then why, in terms of the product rather than of CGEvent...
    expect(alert).toMatch(/drawn afterwards/);
    // ...then what to do, naming the pane. Not the Screen Recording one: this
    // refusal happens on machines whose Screen Recording grant is fine.
    expect(alert).toMatch(/Input Monitoring/);
    expect(alert).not.toMatch(/Screen & System Audio Recording/);

    // WATCHED on hardware 2026-09-09: macOS raises its own Input Monitoring
    // prompt on the first `tapCreate`, and that prompt says "keystrokes". This
    // app's tap mask is mouse-only and it has never recorded a keypress, so
    // without this sentence a user is asked to allow keylogging by a screen
    // recorder and has every reason to refuse. Both halves are asserted —
    // that the dialog is acknowledged at all, and that the discrepancy is
    // named — because a message mentioning one without the other is either a
    // dangling reference or an unanswered alarm.
    expect(alert).toMatch(/macOS may have just asked/);
    expect(alert).toMatch(/keystrokes/);
    expect(alert).toMatch(/mouse movement and clicks only/);

    // ── and it is all actually ON SCREEN ─────────────────────────────────
    //
    // Every assertion above reads `textContent`, which is blind to CSS
    // clipping — the whole message can be in the DOM and a fifth of it
    // visible, which is exactly what was happening (STC-412 final review,
    // C1): the message toast was reusing the undo toast's 240x68 box with
    // `#card { overflow: hidden }` and no `white-space` rule on `#label`.
    // This message is the longest string this app can put in front of anyone
    // (572 characters, four paragraphs), so it is the one to measure, and it
    // is measured in the REAL renderer rather than computed from a font
    // metric nobody can check.
    //
    // Three claims, each failing on its own: the paragraphs survive as
    // paragraphs (`pre-wrap` — without it every \n collapses to a space),
    // the text is not taller than the box that holds it (the clipping), and
    // the box is not wider than the window (which would clip it sideways
    // instead). `overflowBy` is the RENDERED label height minus the box's,
    // not `scrollHeight - clientHeight`: the latter is clamped at 0 once the
    // content fits, so it can say "it fits" and never say by how much —
    // the headroom is the number worth reporting when this eventually fails
    // on some other font stack. Watched failing at the old 240x68: +370px,
    // i.e. about 15% of the message on screen.
    const page = (await toastPage(app!))!;
    //
    // STC-457: the window is sized to the card now (`toast:fit`), so "the
    // label is shorter than a fixed box" became "the row is not scrolling"
    // (`scrollHeight` above `clientHeight` means content is hidden below) and
    // "the window is the card plus its 6 px gutter, or the 340 px ceiling".
    //
    // The window exists (hidden) before the page has measured itself and main
    // has answered with the fitted height, so wait for the resize first. If
    // `toast:fit` never lands, the window stays at the ceiling until main's
    // fallback shows it there, and this poll fails — which is the point.
    await expect.poll(() => page.evaluate(() => window.innerHeight), { timeout: 5_000 })
      .toBeLessThan(340);
    const fit = await page.evaluate(() => {
      const row = document.getElementById("row")!;
      const label = document.getElementById("label")!;
      const card = document.getElementById("card")!;
      return {
        whiteSpace: getComputedStyle(label).whiteSpace,
        hiddenBelow: row.scrollHeight - row.clientHeight,
        widerBy: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chars: (label.textContent ?? "").length,
        cardBottom: card.getBoundingClientRect().bottom,
        windowHeight: window.innerHeight,
      };
    });
    expect(fit.chars).toBeGreaterThan(400);
    expect(fit.whiteSpace).toBe("pre-wrap");
    expect(fit.hiddenBelow, `${fit.hiddenBelow}px of the message is scrolled out of view`).toBeLessThanOrEqual(0);
    expect(fit.widerBy).toBeLessThanOrEqual(0);
    // The card's bottom edge (plus its gutter) is inside the window: nothing
    // is cut off, and the window is not left taller than the card either.
    expect(fit.cardBottom + 6).toBeLessThanOrEqual(fit.windowHeight + 1);
    expect(fit.windowHeight, `window ${fit.windowHeight}px, card bottom ${fit.cardBottom}px, row scroll ${fit.hiddenBelow}px`).toBeLessThan(340);

    // "Quit and reopen", not "press Record again". Input Monitoring commonly
    // needs the granted process restarted and that is UNOBSERVED for this app
    // (see the renderer's comment), so the instruction has to be the one that
    // is sufficient either way. A regression to the shorter wording is a
    // message that can send someone in a circle.
    expect(alert).toMatch(/quit and reopen/i);

    // The app must NOT be in a recording state it cannot leave. Before this
    // ticket the same code arrived as a warning after `started`, so the button
    // said Stop and the state said recording — for a take that, from
    // STC-315 on, does not exist.
    //
    // Mutation-proven three ways, each failing exactly this test of the four:
    // drop START_FAULTS' entry (then renderer.ts's, now refusals.ts's), drop the stand-in's refusal, or
    // set `recording = true` on the failure path. A FOURTH mutation — the
    // stand-in claiming `state = "recording"` while still answering `error` —
    // deliberately did NOT fail, and that is a fact about the app rather than
    // a gap here: the recording state comes from the `start` reply, and no
    // real helper can be in the state that mutation invented.
    expect(await win.textContent("#record")).toBe("Record");
    await expect.poll(() => win.textContent("#state"), { timeout: 10_000 }).toBe("idle");
    expect(await win.isEnabled("#record")).toBe(true);

    // "No take directory can exist without a cursor track" — the acceptance
    // criterion, read off the disk rather than off the UI. The real helper
    // creates the directory and removes it again on a failed start
    // (App.removeIfNothingWorthKeeping); the stand-in never creates one. Both
    // satisfy this, and the assertion is the same either way.
    const takes = readdirSync(recordings).filter((n) => !n.startsWith("."));
    expect(takes).toEqual([]);
  }, 120_000);
});

/**
 * The SAME refusals, through the doors with no renderer waiting on the answer
 * (STC-465 review).
 *
 * The menu-bar item and the global hotkeys are the NORMAL way into a
 * menu-bar-first app, and until this fix a refusal through either said
 * nothing: the menu bar discarded `runRecordFlow`'s answer, the Record hotkey
 * only `console.error`ed it, and a shot's refusal travelled only over
 * `still:captured` — to a main window that is usually closed. So a user could
 * wait out the countdown, be refused, and record an entire demo into nothing.
 *
 * Driven through the REAL tray callback (`__stcTrayOnSelect`, the one seam
 * there is — see `_record-flow.ts`'s `door`), which reaches the same
 * `recordAndAnnounce`/`captureAndAnnounce` the hotkeys call. Both tests were
 * watched failing before the fix: no toast ever appeared. The main window IS
 * open here — it has to be on Linux CI, where closing the last window quits
 * the app — which makes these strictly stronger than they look: the window
 * being right there was not enough, because nothing ever told it.
 */
describe("a refusal through the menu bar or a hotkey is shown too (STC-465 review)", () => {
  test("a Record refused after the menu-bar item started it says why", async () => {
    const { win, recordings } = await launchAndPressRecord({
      STC_FAKE_START_ERROR: "event-tap-unavailable",
    }, "menu-bar");
    await expect.poll(() => toastText(app!), { timeout: 15_000 }).toMatch(/Nothing was recorded/);
    // The same sentence the window's own button gets — one mapping
    // (`refusals.ts`), so the door cannot change what the user is told.
    expect(await toastText(app!)).toMatch(/Input Monitoring/);
    // And no take, and no window left believing one is running.
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    expect(readdirSync(recordings).filter((n) => !n.startsWith("."))).toEqual([]);
  }, 120_000);

  test("a shot refused after the menu-bar item started it says why", async () => {
    const { win } = await launchReady({ STC_FAKE_STILL_ERROR: "no-displays" });
    // "display" needs no overlay — the whole display under the pointer — so
    // the refusal comes straight back from the helper.
    await app!.evaluate(() => (globalThis as any).__stcTrayOnSelect("action:display"));
    await expect.poll(() => toastText(app!), { timeout: 15_000 })
      .toMatch(/Screen Recording permission needed/);
    // No shot claimed in the window that did not ask for one.
    expect(await win.getAttribute("#stillstatus", "hidden")).not.toBeNull();
  }, 120_000);
});

describe("helper warnings during a take", () => {

  test("a code the UI has no words for is still shown, by name", async () => {
    const win = await recordWithWarning("some-new-fault");
    // Polled, not read once: the toast window is listed as soon as it commits
    // navigation, before its DOM exists, and `toastText` answers "" until then
    // (`_toast.ts`). A single read raced that on a loaded CI runner.
    await expect.poll(() => toastText(app!), { timeout: 10_000 }).toContain("some-new-fault");
  }, 120_000);

  test("a display stream that dies ends the take, and the UI says so (STC-306)", async () => {
    // Long enough for the poll above to see "recording" before the stand-in
    // ends the take on its own; the assertions below then wait for the end.
    const win = await recordWithWarning("av-runtime-error", { STC_FAKE_STREAM_DEATH_MS: "2500" });
    // The helper stopped by itself: an unsolicited `stopped` with reason
    // stream-stopped, which the supervisor reports as recording-ended. The
    // button must not go on saying "Stop" for a take that has already ended.
    await expect.poll(() => win.textContent("#state"), { timeout: 15_000 }).toBe("idle");
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    // The LAST word is the end of the take, not the tap warning that preceded
    // it, and it says what happened rather than quoting a reason code.
    await expect.poll(() => toastText(app!), { timeout: 10_000 })
      .toMatch(/display capture stopped unexpectedly, so the recording was stopped/);
    // Captured once rather than re-read: the toast auto-dismisses on its own
    // clock now (`toast.ts`'s `messageToastMs`), so chaining further live reads against it
    // would race that timer instead of asserting against the text the poll
    // above already confirmed is showing.
    const finalAlert = await toastText(app!);
    // Not "saved": a stop no longer promotes (STC-487), so it points at the panel.
    expect(finalAlert).toMatch(/waiting in the panel at the corner of the screen/);
    expect(finalAlert).not.toMatch(/was saved/);
    expect(finalAlert).not.toMatch(/press Stop/);
  }, 120_000);

  test("an idle display reconfiguration is not an alert", async () => {
    const win = await recordWithWarning("display-reconfigured");
    // Give it the time the others needed to appear, then require it did not.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await toastPage(app!)).toBeUndefined();
  }, 120_000);

  test("a display refit mid-take is not an alert, and the take keeps recording (STC-235)", async () => {
    const win = await recordWithWarning("display-refit");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await toastPage(app!)).toBeUndefined();
    expect(await win.textContent("#state")).toBe("recording");
    // Not a toast, but not invisible either: the refit's payload is logged to
    // the main window's console. The fake helper sends it 60 ms after start,
    // before this test holds the window, so read the page's console HISTORY
    // rather than subscribing late.
    await expect.poll(async () => (await win.consoleMessages())
      .some((m) => m.type() === "info" && m.text().startsWith("[helper] display-refit")),
      { timeout: 10_000 }).toBe(true);
  }, 120_000);

  test("a region that no longer fits its refit display ends the take, in words (STC-235)", async () => {
    // Modelled on "a display stream that dies ends the take" above, same
    // unsolicited-stop env vars — just a different reason, and no warning
    // precedes it (a region going out of bounds is not a dead stream).
    const { win } = await launchAndPressRecord({
      STC_FAKE_STREAM_DEATH_MS: "2500",
      STC_FAKE_STOP_REASON: "region-out-of-bounds",
    });
    await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");
    await expect.poll(() => win.textContent("#state"), { timeout: 15_000 }).toBe("idle");
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => toastText(app!), { timeout: 10_000 })
      .toMatch(/recorded area no longer fits on it, so the recording was stopped/);
  }, 120_000);

  // STC-412 Task 7: none of the tests above prove a toast actually goes away
  // ON ITS OWN — each either checks it appears with the right text, or never
  // appears at all. `recordWithWarning` already drives a real warning through
  // the same `STC_FAKE_WARNING` channel "a code the UI has no words for..."
  // above uses; this reuses it rather than inventing a second injection path.
  test("the toast auto-dismisses on its own, with no click", async () => {
    await recordWithWarning("some-new-fault");
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    // The duration is derived from the message's own length now (`toast.ts`'s
    // `messageToastMs`: a MESSAGE_TOAST_MIN_MS floor of 4 s plus 55 ms per
    // character, capped at 20 s) rather than a flat 4 s — a paragraph telling
    // someone to grant a permission and reopen the app cannot be read in the
    // time "Deleted" needs. This message is `RECORDING_FAULTS`' fallback,
    // "The recorder reported a problem: some-new-fault" — 47 characters, so
    // ~6.6 s. The bound is generously past that rather than tight against it,
    // for the same reason the comment it replaces gave: this must not become
    // a race with the very clock it is checking. It is also comfortably
    // under MESSAGE_TOAST_MAX_MS, so a message that somehow never expired
    // would still fail here rather than pass by outliving the poll.
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 15_000 }).toBe(false);
  }, 120_000);

  // STC-412 final review (C1): the ✕ the message mode gained, because a
  // length-derived clock is still a clock and a notice sitting over someone's
  // screen — a live take's own pixels included — has to be clearable early.
  test("the message toast's ✕ takes it away before its clock runs down", async () => {
    await recordWithWarning("some-new-fault");
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    const page = (await toastPage(app!))!;
    const shownAt = Date.now();
    // A close destroys the window out from under the click, the same race
    // `thumbnail.e2e.test.ts`'s `dismissAndTolerateClose` exists for — so the
    // close event is awaited first and a rejection is only tolerated if the
    // window really did go.
    const closed = page.waitForEvent("close", { timeout: 10_000 });
    const err = await page.click("#close").then(() => undefined, (e: unknown) => e);
    if (err !== undefined) await closed.catch(() => { throw err; });
    else await closed;
    expect(await toastPage(app!)).toBeUndefined();
    // The discriminator, and the reason this is not just "it went away": no
    // message toast can expire on its own before MESSAGE_TOAST_MIN_MS, the
    // floor under `messageToastMs` for a string of ANY length. Closing
    // inside that window therefore cannot be the timer. Imported rather than
    // restated — `toast.ts` is deliberately Electron-free so a test can read
    // its numbers instead of keeping a second copy of them in step by hand.
    expect(Date.now() - shownAt).toBeLessThan(MESSAGE_TOAST_MIN_MS);
  }, 120_000);
});
