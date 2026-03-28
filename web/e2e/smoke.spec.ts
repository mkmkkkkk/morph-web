import { test, expect } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'test-token';

test.describe('Morph Web Smoke Tests', () => {

  test('login and page loads', async ({ page }) => {
    await page.goto('/');
    // Should see login or app
    const body = await page.textContent('body');
    console.log('[smoke] page body preview:', body?.slice(0, 200));

    // If login screen, authenticate
    const passInput = page.locator('input[type="password"]');
    if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[smoke] login screen detected, authenticating...');
      await passInput.fill(TOKEN);
      await passInput.press('Enter');
      await page.waitForTimeout(2000);
    }

    console.log('[smoke] page URL:', page.url());
    console.log('[smoke] localStorage morph-auth:', await page.evaluate(() => localStorage.getItem('morph-auth')));
  });

  test('environments load and sessions visible', async ({ page }) => {
    // Pre-set auth to skip login
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
    await page.reload();
    await page.waitForTimeout(3000);

    // Check environments endpoint directly from browser context
    const envData = await page.evaluate(async (token) => {
      const res = await fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } });
      return res.json();
    }, TOKEN);
    console.log('[smoke] environments:', JSON.stringify(envData));

    // Check sessions for each environment
    for (const env of (envData.environments || [])) {
      const sessData = await page.evaluate(async ({ url, token }) => {
        try {
          const res = await fetch(`${url}/v2/claude/sessions?limit=10`, { headers: { 'Authorization': `Bearer ${token}` } });
          return { ok: true, data: await res.json() };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      }, { url: env.relayUrl, token: env.token || TOKEN });
      console.log(`[smoke] sessions for ${env.label} (${env.relayUrl}):`, JSON.stringify(sessData));
    }

    // Check what's in localStorage
    const stored = await page.evaluate(() => ({
      environments: localStorage.getItem('morph-environments'),
      killed: localStorage.getItem('morph-killed'),
    }));
    console.log('[smoke] stored environments:', stored.environments);
    console.log('[smoke] stored killed:', stored.killed);

    // Check visible session cards in DOM
    const bodyText = await page.textContent('body');
    console.log('[smoke] body includes "Docker":', bodyText?.includes('Docker'));
    console.log('[smoke] body includes "Mac":', bodyText?.includes('Mac'));
    console.log('[smoke] body includes "No sessions":', bodyText?.includes('No sessions'));

    // Check for any console errors
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(2000);
    if (errors.length) console.log('[smoke] console errors:', errors);
  });

  test('can send message in main terminal', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
    await page.reload();
    await page.waitForTimeout(3000);

    // Find textarea / input for sending messages
    const textarea = page.locator('textarea').first();
    const isVisible = await textarea.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('[smoke] textarea visible:', isVisible);

    if (!isVisible) {
      // Maybe need to tap into main chat tab first
      const allButtons = await page.locator('button, [role="button"], div[onClick]').allTextContents();
      console.log('[smoke] available buttons:', allButtons.slice(0, 10));

      // Screenshot for debugging
      await page.screenshot({ path: '/tmp/morph-debug.png', fullPage: true });
      console.log('[smoke] screenshot saved to /tmp/morph-debug.png');
    }

    // Check WebSocket connection state
    const connState = await page.evaluate(() => {
      return (window as any).__connLog?.() || 'no connLog';
    });
    console.log('[smoke] connection log:\n', connState);
  });
});
