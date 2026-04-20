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

  // Capture console logs from the page
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'warn' || msg.type() === 'error') {
      console.log(`[browser ${msg.type()}]`, msg.text());
    }
  });

  // Set auth + list mode
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.evaluate((t) => {
    localStorage.setItem('morph-auth', t);
    localStorage.setItem('morph-session-view', 'list');
  }, TOKEN);

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(4000);

  // Click on 034
  console.log('--- Clicking ttys034 ---');
  const pane034 = page.locator('text=ttys034').first();
  await pane034.click();

  // Wait for data
  await page.waitForTimeout(8000);
  await page.screenshot({ path: '/tmp/morph-034-detail.png', fullPage: true });

  // Check what messages arrived
  const msgCount = await page.evaluate(() => {
    // Check if there are message elements
    const msgs = document.querySelectorAll('[data-message-id], [class*="message"], [class*="Message"]');
    return msgs.length;
  });
  console.log(`Message elements found: ${msgCount}`);

  // Get all text on page
  const text = await page.evaluate(() => document.body.innerText);
  console.log('Page text (first 2000):', text?.slice(0, 2000));

  // Check network requests
  const responses = [];
  page.on('response', r => responses.push({ url: r.url(), status: r.status() }));

  await browser.close();
})();
