/**
 * Whether quitting with takes nobody has decided on should stop to ask
 * (STC-392 D8), split from the dialog that renders the answer so the rule
 * itself is testable with no window and no OS.
 *
 * ## The system-initiated case is not a special case bolted onto a user-quit
 * rule; it is the reason this function exists at all
 *
 * The obvious framing is "warn on quit, except when the system is going
 * down" — as if a logout were a carve-out from a rule built for a plain
 * ⌘Q. Read the spec's own words and it inverts: a modal nobody is looking
 * at, holding up a LOGOUT or a scheduled restart that every other app on the
 * machine is already honouring, is a WORSE failure than the takes it claims
 * to protect. And it protects nothing extra by holding on: Quit Anyway never
 * deletes (see main.ts's `before-quit` — its teardown chain is
 * `closeThumbnail`/`closeOverlay`/`sup.shutdown`, none of which touch temp
 * storage) and STC-393's recovery prompt finds every take left there on the
 * next launch regardless of which path ended the process. So the warning
 * buys something only when a person is still at the keyboard and could still
 * choose — which is exactly, and only, the user-initiated case. That is why
 * `systemInitiated` is checked FIRST and short-circuits unconditionally: the
 * spec's own "however many are waiting" is this rule stated in one phrase.
 *
 * ## What "systemInitiated" is actually built on
 *
 * See the long comment at this function's one call site in `main.ts` for
 * what was and was not verified about macOS actually telling the two cases
 * apart on this machine.
 */
export function quitDecision(input: { unhandled: number; systemInitiated: boolean }): "quit" | "warn" {
  if (input.systemInitiated) return "quit";
  if (input.unhandled === 0) return "quit";
  return "warn";
}

/**
 * What the warning dialog offers. `main.ts` is the only reader — see
 * `quitDecision`'s call site for what each does and does not do.
 */
export type QuitChoice = "save-all" | "quit-anyway" | "cancel";
