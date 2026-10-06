# STC-503: App Icon and Menu Bar Glyph

## Status
✅ Menu bar glyph: COMPLETE
⏳ App icon (.icns): AWAITING PNG RASTERIZATION

## Implementation Summary

### Menu Bar Glyph (DONE)
Replaced the STC-292 corner bracket marquee icon with a symmetric camera icon.

**Design:**
- **Small (16px)**: simplified camera body rectangle with lens circle
- **Large (32px)**: camera body rectangle outline with centered lens circle
- Perfect 4-way mirror symmetry (guaranteed by setSym() helper)
- Template image format (black/white, works in light/dark modes)

**Changes:**
- `app/src/tray-menu.ts`: Updated `marqueeMask()` function
- `app/test/tray-menu.test.ts`: Updated tests for new icon design
- All 21 tray-menu tests passing ✅

### App Icon (.icns) - Infrastructure Complete

**Files Created:**
- `assets/icons/app-icon.svg`: Pixel-perfect video camera from pixel-icon-library
- `scripts/build-app-icon.sh`: Converts PNG → .icns using macOS `iconutil`
- `scripts/svg-to-png.mjs`: Converts SVG → PNG (uses ImageMagick or Inkscape)
- `package.json` scripts:
  - `npm run build:icon-png`: SVG → PNG conversion
  - `npm run build:icons`: Full pipeline (PNG → .icns)

**Configuration:**
- `electron-builder.yml`: Added `mac.icon: build/Capture.icns`
- `.gitignore`: Excludes `build/` directory (icon build artifacts)

## Next Steps

To complete the app icon (.icns generation):

### Option 1: Command Line (Automated)
```bash
# Install ImageMagick (if not present)
brew install imagemagick

# Run the build pipeline
npm run build:icons
```

This will:
1. Convert `assets/icons/app-icon.svg` → `assets/icons/app-icon-1024.png`
2. Scale PNG down to all required sizes (16, 32, 128, 256, 512px)
3. Create `build/Capture.icns` using `iconutil`

### Option 2: Manual (Design Tool)
1. Open `assets/icons/app-icon.svg` in Figma, Illustrator, or similar
2. Export as PNG: **1024×1024px**, transparent background
3. Save as `assets/icons/app-icon-1024.png`
4. Run: `npm run build:icons`

### Option 3: Online SVG Converter
1. Use an online tool (SVG to PNG) to convert `assets/icons/app-icon.svg`
2. Dimensions: **1024×1024px**, transparent background
3. Save as `assets/icons/app-icon-1024.png`
4. Run: `npm run build:icons`

## Verification

Once `assets/icons/app-icon-1024.png` exists, run:

```bash
npm run build:icons
# Expected output:
# ✓ Icon PNG created: assets/icons/app-icon-1024.png
# Generating icon set from assets/icons/app-icon-1024.png...
# Creating build/Capture.icns...
# ✓ Icon generated: build/Capture.icns
```

Then verify the icon:
```bash
file build/Capture.icns
# Should output: "macOS Icns image data"
```

## Testing

Run the application to verify the icon appears in:
- Dock (when app is running)
- Finder (when browsing the .app bundle)
- Menu bar (the camera glyph)

```bash
npm run app:start
```

## Technical Notes

- **SVG Source**: Pixel-perfect video camera from [pixel-icon-library](https://github.com/hackernoon/pixel-icon-library)
- **Menu bar glyph**: Black/white template image (~256 bytes at 1x + 2x)
- **App icon**: Multi-resolution .icns bundle (16×16 through 1024×1024)
- **Color scheme**: Black and white as specified
- **Symmetry**: All elements guaranteed symmetric for crisp rendering at small sizes

## Files Modified
- ✅ `app/src/tray-menu.ts` - Menu bar glyph implementation
- ✅ `app/test/tray-menu.test.ts` - Updated tests
- ✅ `electron-builder.yml` - Icon configuration
- ✅ `package.json` - Build scripts
- ✅ `.gitignore` - Build artifacts
- ✅ `assets/icons/app-icon.svg` - Icon source
- ✅ `scripts/build-app-icon.sh` - .icns builder
- ✅ `scripts/svg-to-png.mjs` - SVG to PNG converter

## Branch
`accounts/stc-503-app-icon-and-menu-bar-glyph`
