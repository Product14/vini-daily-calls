// Run: node scripts/renderReportPng.js [input.html] [output.png]
//
// Headless-Chromium screenshot of the email report — sized for Slack desktop
// (canvas width 760px, ~2× device pixel ratio so it stays crisp on retina).
//
// Default I/O:
//   input  = agents-preview-2.html
//   output = agents-preview-2.png
//
// Slack's image preview caps the visible inline height; tall PNGs still
// render but require a click-through to view full. That's fine — the
// top fold (hero band + first 1-2 agent cards) is the daily eyeball-target.

import puppeteer from "puppeteer";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const inputArg  = process.argv[2] || "agents-preview-2.html";
const outputArg = process.argv[3] || inputArg.replace(/\.html?$/i, ".png");
const inputPath  = resolve(ROOT, inputArg);
const outputPath = resolve(ROOT, outputArg);

if (!existsSync(inputPath)) {
  console.error(`✗ Input not found: ${inputPath}`);
  process.exit(1);
}

console.log(`→ Rendering ${inputArg} → ${outputArg} (full-page, 760w @ 2x)`);

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  // Slack desktop renders inline images well at ~720–760px wide. Use 760
  // canvas + 2× device-pixel-ratio = a 1520px-wide PNG that downscales
  // cleanly on retina but stays sharp.
  await page.setViewport({ width: 760, height: 1200, deviceScaleFactor: 2 });
  const fileUrl = "file://" + inputPath;
  await page.goto(fileUrl, { waitUntil: "networkidle0" });

  // Make sure any web-fonts have settled before snapping.
  await page.evaluate(() => document.fonts ? document.fonts.ready : null);

  await page.screenshot({ path: outputPath, fullPage: true, type: "png" });
  console.log(`✓ Wrote ${outputArg}`);
} finally {
  await browser.close();
}
