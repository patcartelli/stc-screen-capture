import type { Page } from "playwright";

/**
 * A transient UI state (STC-389) — the app claims a device works, then
 * stops claiming it, and the two states can be closer together than one
 * poll interval. Racing `expect.poll` against that window reads the RUNNER's
 * speed, not the app's correctness: the fix is to stop sampling a point in
 * time and instead record the whole sequence of values an element's text
 * takes, then assert on ORDER.
 *
 * `observeTextSequence` must be installed before the action that starts the
 * transition — a MutationObserver added after the first value has already
 * been replaced cannot see it either.
 */
export async function observeTextSequence(win: Page, elementId: string): Promise<void> {
  await win.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`observeTextSequence: no element #${id}`);
    const key = `__stateSequence_${id}`;
    (window as any)[key] = [el.textContent ?? ""];
    new MutationObserver(() => {
      (window as any)[key].push(el.textContent ?? "");
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }, elementId);
}

/** Read back everything `observeTextSequence` has recorded for `elementId` so far. */
export async function textSequence(win: Page, elementId: string): Promise<string[]> {
  return win.evaluate((id) => (window as any)[`__stateSequence_${id}`] ?? [], elementId);
}

/**
 * Did `needle` appear in `sequence` strictly before `terminal` first did?
 *
 * Both must actually occur — a `terminal` that never appears has nothing to
 * be "before", and a `needle` that never appears cannot be before it either.
 * This is the ordering claim the two STC-389 tests exist to prove: the
 * device name was shown, and only then replaced. A stand-in that skips the
 * device-name event must fail this, not merely miss a poll.
 */
export function occursBefore(sequence: readonly string[], needle: string, terminal: string): boolean {
  const terminalIndex = sequence.findIndex((s) => s.includes(terminal));
  if (terminalIndex === -1) return false;
  const needleIndex = sequence.findIndex((s) => s.includes(needle));
  return needleIndex !== -1 && needleIndex < terminalIndex;
}
