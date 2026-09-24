import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutCountdown } from "./_countdown-fixture.js";
import { toastPage, toastText } from "./_toast.js";
import { MESSAGE_TOAST_MIN_MS } from "../src/toast.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

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

async function launchAndPressRecord(env: Record<string, string>) {
  // An EMPTY recordings root, deliberately: the refusal test reads this
  // directory back to prove no take was created, and seeding it with a fixture
  // take would make "is it empty?" unanswerable. Nothing in this file opens a
  // take, so nothing needs one.
  const recordings = mkdtempSync(join(tmpdir(), "stc-takes-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
  await win.click("#record");
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

    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
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
    const fit = await page.evaluate(() => {
      const row = document.getElementById("row")!;
      const label = document.getElementById("label")!;
      return {
        whiteSpace: getComputedStyle(label).whiteSpace,
        overflowBy: label.getBoundingClientRect().height - row.clientHeight,
        widerBy: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chars: (label.textContent ?? "").length,
      };
    });
    expect(fit.chars).toBeGreaterThan(500);
    expect(fit.whiteSpace).toBe("pre-wrap");
    expect(fit.overflowBy, `label exceeds its box by ${fit.overflowBy}px`).toBeLessThanOrEqual(0);
    expect(fit.widerBy).toBeLessThanOrEqual(0);

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
    // drop the renderer's START_FAULTS entry, drop the stand-in's refusal, or
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

describe("helper warnings during a take", () => {

  test("a code the UI has no words for is still shown, by name", async () => {
    const win = await recordWithWarning("some-new-fault");
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    expect(await toastText(app!)).toContain("some-new-fault");
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
    expect(finalAlert).toMatch(/up to that point was saved/);
    expect(finalAlert).not.toMatch(/press Stop/);
  }, 120_000);

  test("an idle display reconfiguration is not an alert", async () => {
    const win = await recordWithWarning("display-reconfigured");
    // Give it the time the others needed to appear, then require it did not.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await toastPage(app!)).toBeUndefined();
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
