// Deterministic review raster export. Run from the repository root with Node.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve('src/renderer/src/assets/pocket-office');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  for (const [name, width, height, scale] of [['review-vignette', 192, 144, 4], ['review-delivery-strip', 256, 64, 4], ['review-color-building', 960, 600, 1]]) {
    const svg = await readFile(resolve(dir, `${name}.svg`), 'utf8');
    const page = await browser.newPage({ viewport: { width: width * scale, height: height * scale }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0} svg{width:${width * scale}px;height:${height * scale}px;image-rendering:pixelated}</style>${svg}`);
    await page.screenshot({ path: resolve(dir, `${name}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
