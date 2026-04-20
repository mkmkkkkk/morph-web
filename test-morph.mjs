import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
const TOKEN = 'morph2026';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Set auth token before navigating
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.evaluate((t) => {
    localStorage.setItem('morph-auth', t);
    localStorage.setItem('morph-session-view', 'list');
  }, TOKEN);

  // Reload with auth
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000); // wait for layout data
  await page.screenshot({ path: '/tmp/morph-01-list.png', fullPage: true });
  console.log('Screenshot 1: list view');

  // Count pane rows
  const buttons = await page.locator('[role="button"]').count();
  console.log(`Tappable elements: ${buttons}`);

  // Check all visible text
  const allText = await page.evaluate(() => document.body.innerText);
  console.log('Visible text:\n', allText);

  // Look for specific TTYs
  const html = await page.content();
  for (const tty of ['ttys031', 'ttys034', 'ttys035', 'ttys040', 'ttys041']) {
    console.log(`${tty} in DOM: ${html.includes(tty)}`);
  }

  // Now click on 034 if it exists
  const pane034 = page.locator('text=ttys034').first();
  if (await pane034.count() > 0) {
    console.log('Clicking ttys034...');
    await pane034.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/morph-02-034-clicked.png', fullPage: true });
    console.log('Screenshot 2: after clicking 034');
    const textAfter = await page.evaluate(() => document.body.innerText);
    console.log('After click text (first 1000):', textAfter?.slice(0, 1000));
  } else {
    console.log('ttys034 NOT FOUND in view!');
    // Dump all visible elements for debugging
    const elements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('div, span')).map(e => ({
        tag: e.tagName,
        text: e.innerText?.slice(0, 80),
        role: e.getAttribute('role'),
      })).filter(e => e.text && e.text.length > 0).slice(0, 50);
    });
    console.log('Visible elements:', JSON.stringify(elements, null, 2));
  }

  // Switch to grid view and check
  await page.evaluate(() => localStorage.setItem('morph-session-view', 'grid'));
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/morph-03-grid.png', fullPage: true });
  console.log('Screenshot 3: grid view');

  await browser.close();
})();
