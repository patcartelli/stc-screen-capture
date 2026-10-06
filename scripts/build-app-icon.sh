#!/bin/bash
set -e

# Build app icon (.icns) from source PNG using iconutil
# STC-503: converts PNG sources to macOS .icns format
#
# On first run, this requires SVG to be pre-rasterized to PNG at source size.
# Use a tool like Figma, Illustrator, or web-based converter to export
# the SVG at 1024px and save as assets/icons/app-icon-1024.png
#
# Then this script scales it down and creates the .icns bundle.

ICON_SRC="${1:-assets/icons/app-icon-1024.png}"
ICON_OUT="build/Capture.icns"
ICONSET_DIR="build/Capture.iconset"

if [ ! -f "$ICON_SRC" ]; then
  echo "Error: Icon source not found: $ICON_SRC"
  echo ""
  echo "To create the icon:"
  echo "1. Convert assets/icons/app-icon.svg to PNG at 1024x1024"
  echo "2. Save as assets/icons/app-icon-1024.png"
  echo "3. Run: $0"
  exit 1
fi

# Create iconset directory
mkdir -p "$ICONSET_DIR"

# macOS requires specific icon sizes and naming conventions
# Format: icon_<width>x<height><@2x>.png
# Standard set: 16, 32, 128, 256, 512
SIZES=(16 32 128 256 512)

echo "Generating icon set from $ICON_SRC..."

for size in "${SIZES[@]}"; do
  # 1x variant
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET_DIR/icon_${size}x${size}.png"

  # 2x variant (for Retina displays)
  size_2x=$((size * 2))
  sips -z "$size_2x" "$size_2x" "$ICON_SRC" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png"
done

# 1024x1024 (used as toc)
sips -z 1024 1024 "$ICON_SRC" --out "$ICONSET_DIR/icon_512x512@2x.png"

# Create .icns file from iconset
echo "Creating $ICON_OUT..."
iconutil -c icns -o "$ICON_OUT" "$ICONSET_DIR"

echo "✓ Icon generated: $ICON_OUT"
if [ -f "$ICON_OUT" ]; then
  size=$(du -h "$ICON_OUT" | cut -f1)
  echo "✓ Size: $size"
fi
