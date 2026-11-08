// Deterministic review raster export. Run from the repository root with Node.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve('src/renderer/src/assets/pocket-office');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  for (const [name, width, height] of [['review-vignette', 192, 144], ['review-delivery-strip', 256, 64]]) {
    const svg = await readFile(resolve(dir, `${name}.svg`), 'utf8');
    const page = await browser.newPage({ viewport: { width: width * 4, height: height * 4 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0} svg{width:${width * 4}px;height:${height * 4}px;image-rendering:pixelated}</style>${svg}`);
    await page.screenshot({ path: resolve(dir, `${name}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
