# STC-426 — visible vertical previews

The floating still previews now use their full window heights, separated by
12 screen points. Newest stays at the selected corner; older previews run
vertically into the work area. On a short display the next preview starts a
column farther inward. Expanding or entering redaction reflows the stack,
as does closing a preview. Each preview stays on the display where it opened.
Hidden exports and silent captures do not occupy visible slots.

## Check on the Mac

1. Capture three stills in succession. Each image should be fully visible,
   with a gap between previews; newest should be nearest the selected corner.
2. Expand the middle preview, then enter and leave Redact. Its neighbours
   should move to make room without covering one another.
3. Close the middle preview. The remaining previews should close the gap.
4. Repeat from a top corner and on a shorter work area. Overflow should
   continue in a column inward from the selected edge.
5. Capture while previews are visible. They should disappear during capture,
   then return without showing any panel that has already started settling.
6. With two displays, move the pointer to the other display and capture again.
   The existing previews should stay on their original display.

The automated window test checks the actual window rectangles through expand,
redact and removal. Pure layout tests cover all corners, negative display
origins, mixed heights and short-display wrapping. They do not judge whether
the 12-point gap feels right or how macOS presents several always-on-top windows.

## Related work

This checkout's floating preview is still-only. STC-392 owns the shared panel
for recordings and stills, persistent pending takes, three visible panels and
the overflow badge. Its open PR #188 changes the same panel code; carry the
full-height layout and resize reflow into that implementation when integrating.
STC-426 does not replace that ticket's lifecycle or overflow-badge decisions.

The current five-panel cap and automatic settlement remain the existing
behaviour. Column wrapping handles ordinary short-display overflow; a group
of several expanded redaction windows can exceed the available screen width.
The shared panel's bounded visible list belongs to STC-392.
