# STC-457 runbook — the toast's layout pass

Branch: `accounts/stc-457-toast-styling` (PR open, **not on `master` yet**: run it from this branch).

```bash
git fetch origin && git checkout accounts/stc-457-toast-styling
npm ci && npm run app:package       # then tools/vm/fresh.sh (clean TCC), as docs/VM-TESTING.md says
```

What changed: the message toast (`toast.html`) loads `tokens.css` and follows the OS light/dark
setting; a message is `{ title?, body, action? }` (`app/src/toast-message.ts`); the window is sized to
its card (`toast:fit`, ceiling 340 px) instead of a fixed 400x300; the two permission refusals carry
a button that opens the matching System Settings pane. A plain string still renders, body only.
Camera and mic fault messages are deliberately still plain strings (follow-up).

## VM pass, 2026-09-30 (clean clone, packaged app from this branch)

| # | Check | Result | Observed by |
|---|---|---|---|
| 1 | Main window renders | pass | Patrick, by eye |
| 2 | Record with no Screen Recording grant gives a toast | pass | Patrick |
| 3 | Layout: icon, bold title, dim body, corner ×, button, drain bar, compact card | pass | Patrick (screenshot) |
| 4 | "Open System Settings" opens the Screen Recording pane and dismisses the toast | pass | Patrick |
| 5 | Dark and light appearance both readable | pass | Patrick |
| 6 | Input Monitoring toast ("Nothing was recorded", "Open Input Monitoring") | **not reachable in the VM** | see below |

Item 6: with Input Monitoring off the take STARTED and recorded one cursor event, so the refusal
never fired. That is STC-480, not a toast problem. The toast itself is covered by
`warnings.e2e.test.ts` (`STC_FAKE_START_ERROR=event-tap-unavailable`), which measures that message:
no scrolled-out text, and a window shorter than the ceiling. **Host:** still worth one look with a
real Mac and a real refusal once STC-480 is resolved.

## What only a Mac can settle

1. Whether Geist actually loads in the toast (`font-src 'self'`): the e2e fit check measures whatever
   font rendered, so it cannot tell you which one that was.
2. Whether the window resize before showing is invisible on a real display: there is a 1.5 s
   fallback (`FIT_FALLBACK_MS`) that shows the window at the ceiling if the page never answers, so
   a toast that appears tall and then never shrinks means `toast:fit` did not arrive.
3. Bottom-corner placement: the window is re-anchored after the resize
   (`positionFor` with the fitted height); check a bottom corner does not jump.
4. Reduced motion, unchanged, but the bar is now `--accent` not a literal.
