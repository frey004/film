// Renders the app icon (SVG below) to every PNG the web app, Android and iOS
// need. Uses the Playwright Chromium that is available on the machine.
//   node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const glyph = `
  <rect x="190" y="300" width="380" height="110" rx="26" fill="#ffffff"/>
  <rect x="600" y="300" width="234" height="110" rx="26" fill="#ffffff" opacity=".55"/>
  <rect x="300" y="460" width="300" height="110" rx="26" fill="#ffd166"/>
  <rect x="190" y="620" width="530" height="80" rx="26" fill="#7ee0a1"/>
  <rect x="452" y="230" width="20" height="560" rx="10" fill="#ffffff"/>
  <path d="M432 214h60l-30 40z" fill="#ffffff"/>`;
const bg = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#7a3cf0"/></linearGradient></defs>`;

const svg = ({ rounded = true, glyphOnly = false, bgOnly = false, scale = 1 } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${bg}
  ${glyphOnly ? '' : `<rect width="1024" height="1024" rx="${rounded ? 220 : 0}" fill="url(#g)"/>`}
  ${bgOnly ? '' : `<g transform="translate(512 512) scale(${scale}) translate(-512 -500)">${glyph}</g>`}
</svg>`;

const splash = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}
  <rect width="${size}" height="${size}" fill="#101114"/>
  <g transform="translate(${size / 2 - 256} ${size / 2 - 256}) scale(.5)">
    <rect width="1024" height="1024" rx="220" fill="url(#g)"/>
    <g transform="translate(0 12)">${glyph}</g>
  </g>
</svg>`;

const jobs = [
  ['www/icons/icon-192.png', svg(), 192],
  ['www/icons/icon-512.png', svg(), 512],
  ['www/icons/apple-touch-icon.png', svg({ rounded: false }), 180],
  ['www/icons/icon-maskable-512.png', svg({ rounded: false, scale: 0.8 }), 512],
  // Sources for `npx @capacitor/assets generate` (Android + iOS icons/splash).
  ['assets/icon-only.png', svg({ rounded: false }), 1024],
  ['assets/icon-foreground.png', svg({ glyphOnly: true, scale: 0.62 }), 1024],
  ['assets/icon-background.png', svg({ rounded: false, bgOnly: true }), 1024],
  ['assets/splash.png', splash(2732), 2732],
  ['assets/splash-dark.png', splash(2732), 2732],
];

mkdirSync('www/icons', { recursive: true });
mkdirSync('assets', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, markup, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  console.log('wrote', file);
}
await browser.close();
