import { test, expect } from '@playwright/test';

const RELAY = 'http://127.0.0.1:3000';
const TOKEN = 'morph2026';

test('spatial grid: click routable pane opens SessionTerminal', async ({ page }) => {
  page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

  // 1. Set auth and load
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Wait for grid to render
  const gridLabel = page.getByText('GRID', { exact: true });
  await expect(gridLabel).toBeVisible({ timeout: 15000 });
  console.log('Grid visible');

  await page.screenshot({ path: '/tmp/morph-grid-01-before.png', fullPage: true });

  // 3. Click a routable pane (cursor:pointer div containing a span)
  const pane = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator('span') }).first();
  await expect(pane).toBeVisible();
  const paneText = await pane.innerText();
  console.log(`Clicking pane: "${paneText.trim()}"`);
  await pane.click();

  // 4. Wait for SessionTerminal to slide in — it has a "Back" button
  const backBtn = page.getByRole('button', { name: 'Back' });
  const hasBack = await backBtn.isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`Back button visible: ${hasBack}`);

  await page.screenshot({ path: '/tmp/morph-grid-02-after-click.png', fullPage: true });

  if (!hasBack) {
    // Dump all text on page to see what's there
    const allText = await page.locator('body').innerText();
    console.log('All text after click:', allText.slice(0, 500));

    // Check if SessionTerminal div exists in DOM (even if not visible)
    const sessionTerminalExists = await page.evaluate(() => {
      const fixed = document.querySelectorAll('div[style*="position: fixed"][style*="z-index: 50"]');
      return { count: fixed.length, html: fixed[0]?.outerHTML?.slice(0, 500) || 'none' };
    });
    console.log('SessionTerminal in DOM:', JSON.stringify(sessionTerminalExists));
  }

  expect(hasBack).toBe(true);

  // 5. Verify textarea exists for sending messages in SessionTerminal
  const textarea = page.getByPlaceholder('Message this session...');
  await expect(textarea).toBeVisible({ timeout: 3000 });
  console.log('SessionTerminal textarea visible');

  // 6. Verify the session display shows the pane name
  const header = page.locator('text=Workspace');
  const hasHeader = await header.first().isVisible({ timeout: 2000 }).catch(() => false);
  console.log(`Session header "Workspace": ${hasHeader}`);

  // 7. Click Back to return to grid
  await backBtn.click();
  await page.waitForTimeout(1000);
  const gridAfterBack = page.getByText('GRID', { exact: true });
  await expect(gridAfterBack).toBeVisible({ timeout: 3000 });
  console.log('Returned to grid view');

  await page.screenshot({ path: '/tmp/morph-grid-03-back.png', fullPage: true });
});
