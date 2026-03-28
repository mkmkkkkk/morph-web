import { test, expect } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'test-token';

test('debug: env rendering and message send', async ({ page }) => {
  // Collect all console output
  const logs: string[] = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.message}`));

  // Pre-auth
  await page.goto('/');
  await page.evaluate((token) => {
    localStorage.setItem('morph-auth', token);
    localStorage.removeItem('morph-killed');
    localStorage.removeItem('morph-environments');
  }, TOKEN);
  await page.reload();

  // Wait for environments to load and poll to trigger
  await page.waitForTimeout(8000);

  // Screenshot
  await page.screenshot({ path: '/tmp/morph-debug-1.png', fullPage: true });

  // Check what's visible
  const bodyText = await page.textContent('body');
  const hasDocker = bodyText?.includes('Docker');
  const hasMac = bodyText?.includes('Mac');
  const hasNoSessions = bodyText?.includes('No sessions');
  console.log(`[debug] Docker visible: ${hasDocker}, Mac visible: ${hasMac}, "No sessions": ${hasNoSessions}`);

  // Check localStorage state
  const storage = await page.evaluate(() => ({
    envs: localStorage.getItem('morph-environments'),
    killed: localStorage.getItem('morph-killed'),
    auth: localStorage.getItem('morph-auth'),
  }));
  console.log('[debug] localStorage envs:', storage.envs);
  console.log('[debug] localStorage killed:', storage.killed);

  // Check connection state
  const connState = await page.evaluate(() => (window as any).__connLog?.() || 'N/A');
  console.log('[debug] conn log:\n', connState);

  // Try to find the main textarea and send
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
    await textarea.fill('ping');
    console.log('[debug] textarea filled with "ping"');

    // Find and click send button, or press Enter
    // Check what buttons are near the textarea
    const sendArea = page.locator('textarea').locator('..');
    const sendAreaHTML = await sendArea.innerHTML();
    console.log('[debug] send area HTML:', sendAreaHTML.slice(0, 500));

    // Try submitting
    await textarea.press('Enter');
    await page.waitForTimeout(3000);

    // Check if message appeared
    const bodyAfter = await page.textContent('body');
    const hasPing = bodyAfter?.includes('ping');
    console.log('[debug] "ping" in body after send:', hasPing);

    await page.screenshot({ path: '/tmp/morph-debug-2.png', fullPage: true });
  } else {
    console.log('[debug] no textarea found');
    // Try to find what's on screen
    const allText = await page.locator('div, span, button').allTextContents();
    console.log('[debug] all visible text:', allText.filter(t => t.trim()).slice(0, 30));
  }

  // Dump relevant console errors
  const errors = logs.filter(l => l.includes('ERROR') || l.includes('error') || l.includes('PAGE_ERROR'));
  if (errors.length) console.log('[debug] errors:\n', errors.join('\n'));
});
