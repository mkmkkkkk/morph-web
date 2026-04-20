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

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.evaluate((t) => {
    localStorage.setItem('morph-auth', t);
    localStorage.setItem('morph-session-view', 'list');
  }, TOKEN);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(4000);

  // Click 034
  await page.locator('text=ttys034').first().click();
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/morph-034-detail2.png', fullPage: true });

  const text = await page.evaluate(() => document.body.innerText);
  // Check if we navigated to detail view
  const hasBack = text.includes('Back');
  const hasTty034 = text.includes('ttys034');
  console.log(`Has Back button: ${hasBack}`);
  console.log(`Has ttys034: ${hasTty034}`);
  console.log('Text (first 500):', text.slice(0, 500));

  await browser.close();
})();
