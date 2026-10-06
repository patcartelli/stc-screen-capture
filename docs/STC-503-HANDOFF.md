# STC-503 Handoff: App Icon and Menu Bar Glyph

## Current Status
⏳ **INCOMPLETE** - Menu bar icon needs redesign, app icon still pending

## The Problem
The menu bar camera icon, while now bolder and filling ~45% of the 16×16 space, **still does not visually match the prominence of other macOS menu bar icons**. 

User feedback: "it's not though?" when comparing to neighboring icons (link, Figma, VPN icons, etc.)

## What's Been Done

### ✅ Menu Bar Glyph (Code Complete, But Wrong Design)
- Replaced corner brackets with camera icon design
- Current implementation: `app/src/tray-menu.ts` marqueeMask() function
- All 21 tray-menu tests passing
- Icon fills ~45% of 16×16 space (test limit: max 50%)
- Issue: **Design is not visually prominent enough despite filling space**

**Current approach:** Procedurally generated camera (filled body + lens circle)
- 16px: Filled rectangle body + large lens circle
- 32px: Rectangle outline + centered lens circle

### ✅ App Icon Infrastructure (Ready, Awaiting PNG)
- `assets/icons/app-icon.svg` - video camera from pixel-icon-library
- Build scripts ready: `scripts/build-app-icon.sh` and `scripts/svg-to-png.mjs`
- `electron-builder.yml` configured to use icon
- Awaiting PNG rasterization

## What Needs to Happen

### Option 1: Better Design (Recommended)
The issue is **design**, not code. The procedural icon approach may be fundamentally limited.

Suggestions:
1. **Use a pre-made icon**: Consider using a pre-rasterized icon from the pixel-icon-library instead of procedurally drawing it. Options:
   - Use the actual PNG files from pixel-icon-library at 16px/32px
   - Convert those to BGRA buffer format for template image
   
2. **Rasterize once, use always**: Instead of procedural generation, pre-render the camera icon as PNGs (16×16 and 32×32) and load them as template images

3. **Different camera style**: The current "camera body + lens" may not be distinctive enough. Try:
   - A camera with more defined details
   - A video camera specifically (with tape/film element)
   - A recording indicator (red dot, etc.)

### Option 2: Accept Current Design
If the current bold design is acceptable, proceed to commit and move on.

## Files to Modify

**If redesigning menu bar icon:**
- `app/src/tray-menu.ts` - Replace `marqueeMask()` function with new design
- `app/test/tray-menu.test.ts` - Update test expectations if needed

**If using pre-made icons:**
- Add 16px and 32px PNG files to `assets/icons/`
- Modify `tray.ts` or `tray-menu.ts` to load PNGs instead of generating procedurally

## Test Requirements (Non-negotiable)
Any new icon design must:
1. Pass 21 tray-menu tests
2. Be perfectly symmetric (4-way mirror)
3. Fill 10-50% of icon space (10-50% of 256 pixels for 16px)
4. Stay within inset boundary (2px margin for 16px)
5. Work as macOS template image (alpha channel only)

## Branch Info
- **Branch**: `accounts/stc-503-app-icon-and-menu-bar-glyph`
- **PR**: #296
- **Commits**: 3 (infrastructure, icon implementation, guide)

## Screenshots Captured
1. Initial small icon (barely visible)
2. Bolder icon (still too small relative to neighbors)
3. Current 45%-fill solid icon (still not matching prominence)

## Next Steps for Agent
1. Decide: redesign or accept current
2. If redesigning:
   - Research better menu bar camera icon approaches
   - Consider pre-rasterized PNG approach
   - Implement new design in marqueeMask() or new function
   - Ensure all tests pass
3. If accepting:
   - Commit remaining changes
   - Move to app icon (.icns) generation
4. Get user approval before finalizing

## Key Learning
Procedurally drawn icons at 16px have very limited design space. A pre-made rasterized icon may be the better approach for achieving visual prominence comparable to OS icons.
