#!/usr/bin/env node

/**
 * STC-503: Convert SVG icon to PNG
 * Usage: npm run build:icon-png
 *
 * Attempts to convert assets/icons/app-icon.svg to PNG using available tools.
 * If no tool is found, provides manual instructions.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";

const svg = "assets/icons/app-icon.svg";
const png = "assets/icons/app-icon-1024.png";
const size = 1024;

if (!existsSync(svg)) {
  console.error(`✗ Source SVG not found: ${svg}`);
  process.exit(1);
}

console.log(`Converting ${svg} → ${png} (${size}x${size})...`);

try {
  // Try ImageMagick convert (most reliable)
  execSync(`convert -background none -size ${size}x${size} "${svg}" -gravity center -extent ${size}x${size} "${png}"`, {
    stdio: "inherit"
  });
  console.log(`✓ Icon PNG created: ${png}`);
  process.exit(0);
} catch (e1) {
  // Try Inkscape
  try {
    execSync(`inkscape --export-type=png --export-width=${size} --export-height=${size} -o "${png}" "${svg}"`, {
      stdio: "inherit"
    });
    console.log(`✓ Icon PNG created: ${png}`);
    process.exit(0);
  } catch (e2) {
    // No tool available - provide manual instructions
    console.log("\n⚠ No image conversion tool found.");
    console.log("\nTo create the icon, choose one:");
    console.log("\n1. Install ImageMagick:");
    console.log("   brew install imagemagick");
    console.log("   npm run build:icon-png");
    console.log("\n2. Manual conversion:");
    console.log("   - Open Figma or Illustrator");
    console.log("   - Open assets/icons/app-icon.svg");
    console.log(`   - Export as PNG: ${size}×${size}px, transparent background`);
    console.log(`   - Save as: ${png}`);
    console.log("   - Then run: npm run build:icons");
    process.exit(1);
  }
}
