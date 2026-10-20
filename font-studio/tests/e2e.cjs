// End-to-end test of the built app in Chromium (Playwright).
//   npx vite build && npx vite preview --port 4173 &   then:   node tests/e2e.cjs <out-dir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || 'e2e-out';
fs.mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const step = (msg) => console.log('•', msg);

  await page.goto(process.env.STUDIO_URL || 'http://localhost:4173/');
  await shot(page, '01-welcome');
  step('welcome screen');

  await page.getByRole('button', { name: 'Melad Display' }).click();
  await page.waitForSelector('.grid-scroll .cell');
  await page.waitForFunction(() => window.studio?.shaper);
  step(`opened sample: ${await page.locator('.topbar .muted').innerText()}`);
  await shot(page, '02-opened');

  await page.fill('.grid-tools input', 'ب');
  await page.locator('.grid-scroll .cell').first().click();
  await page.waitForTimeout(300);
  step(`selected: ${await page.locator('.glyph-title').innerText()}`);
  await shot(page, '03-beh');

  // forms tab
  await page.getByRole('button', { name: 'Forms' }).click();
  await page.waitForTimeout(300);
  step(`forms: ${await page.locator('.form-cell').count()} joining cells, ${await page.locator('.section').count()} sections`);
  await shot(page, '04-forms');
  // jump to the medial form
  await page.locator('.form-cell').nth(2).locator('.thumb').click();
  await page.waitForTimeout(300);
  step(`medial form: ${await page.locator('.glyph-title').innerText()}`);

  // anchors tab
  await page.getByRole('button', { name: 'Anchors & kerning' }).click();
  await page.waitForTimeout(300);
  await shot(page, '05-anchors');
  step(`anchor rows: ${await page.locator('.inspector .table').first().locator('tr').count()}`);

  // decompose if composite, then drag a point
  await page.getByRole('button', { name: 'Glyph', exact: true }).click();
  const decomp = page.getByRole('button', { name: 'Decompose to edit points' });
  if (await decomp.count()) { await decomp.click(); step('decomposed composite'); }
  await page.waitForTimeout(200);
  const pt = page.locator('svg .pt.on').first();
  const box = await pt.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const undoTitle = await page.getByRole('button', { name: 'Undo' }).getAttribute('title');
  step(`dragged a point; undo says: ${undoTitle}`);
  await shot(page, '06-dragged');

  // marquee select + nudge with arrows
  const svg = await page.locator('.canvas-wrap svg').boundingBox();
  await page.mouse.move(svg.x + 20, svg.y + 20);
  await page.mouse.down();
  await page.mouse.move(svg.x + svg.width - 20, svg.y + svg.height - 40, { steps: 5 });
  await page.mouse.up();
  const selCount = await page.locator('svg .pt.sel').count();
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(300);
  step(`marquee selected ${selCount} points and nudged them up 10`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  step('undo works');

  // preview with ss02
  await page.locator('.preview textarea').fill('يهتم مسلم سلمى حسن في');
  await page.locator('.feat', { hasText: 'ss02' }).click();
  await page.waitForTimeout(800);
  step(`preview glyph run: ${await page.locator('.glyph-run .thumb').count()} glyphs`);
  await shot(page, '07-preview-ss02');

  // font tab
  await page.getByRole('button', { name: 'Font', exact: true }).click();
  await page.waitForTimeout(200);
  await shot(page, '08-font');

  // save: TTF + WOFF2
  await page.getByRole('button', { name: 'Save font…' }).click();
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Validate and save' }).click();
  await page.waitForSelector('.checks li', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.modal-actions button.primary')?.textContent?.includes('checking'), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const checks = await page.locator('.checks li').allInnerTexts();
  checks.forEach((c) => step(`check: ${c}`));
  await shot(page, '09-saved');
  for (const d of downloads) {
    const f = path.join(out, d.suggestedFilename());
    await d.saveAs(f);
    step(`downloaded ${d.suggestedFilename()} (${fs.statSync(f).size} bytes)`);
  }

  // new font flow
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'New font…' }).click();
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(500);
  await page.keyboard.press('r');
  const svg2 = await page.locator('.canvas-wrap svg').boundingBox();
  await page.mouse.move(svg2.x + svg2.width * 0.4, svg2.y + svg2.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(svg2.x + svg2.width * 0.6, svg2.y + svg2.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  step(`new font: drew a rectangle into ${await page.locator('.glyph-title').innerText()}`);
  await shot(page, '10-new-font');

  console.log(errors.length ? `\nERRORS:\n${errors.join('\n')}` : '\nno page errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
