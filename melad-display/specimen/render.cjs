// Render specimen.html to PNG in Chromium (Playwright): node specimen/render.cjs
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2160, height: 1350 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'specimen.html'));
  await page.evaluate(() => document.fonts.ready);
  console.log(await page.evaluate(() => [...document.fonts].map(f => `${f.family}: ${f.status}`).join('\n')));
  await page.screenshot({ path: path.join(__dirname, 'melad-display-specimen.png'), fullPage: true });
  await browser.close();
})();
