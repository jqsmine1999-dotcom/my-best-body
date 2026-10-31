// SVG のロゴを各サイズの PNG に書き出す（同意画面用 120×120 を含む）
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const svg = (size, pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5d616b"/><stop offset="1" stop-color="#26282e"/></linearGradient>
    <linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="100" height="100" rx="${pad ? 0 : 22}" fill="url(#bg)"/>
  <g transform="translate(50 50) scale(${pad ? 0.72 : 1}) translate(-50 -50)">
    <circle cx="50" cy="52" r="27" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="8"/>
    <path d="M50 25 A27 27 0 1 1 26.6 65.5" fill="none" stroke="#f3f4f6" stroke-width="8" stroke-linecap="round"/>
    <circle cx="50" cy="52" r="6" fill="#f3f4f6"/>
  </g>
  <rect width="100" height="52" rx="${pad ? 0 : 22}" fill="url(#gl)"/>
</svg>`;

const targets = [
  ["public/logo-120.png", 120, false],
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/apple-touch-icon.png", 180, true],
  ["public/icons/icon-512.png", 512, true],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, full] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, full)}</body></html>`);
  writeFileSync(file, await page.locator("svg").screenshot({ omitBackground: true }));
  console.log("wrote", file);
}
await browser.close();
