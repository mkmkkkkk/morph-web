import { test, expect } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'test-token';

test.describe('Morph Smoke Tests', () => {

  test('login and environments load', async ({ page }) => {
    await page.goto('/');

    // Authenticate
    const passInput = page.locator('input[type="password"]');
    if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await passInput.fill(TOKEN);
      await passInput.press('Enter');
      await page.waitForTimeout(2000);
    } else {
      await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
      await page.reload();
    }

    // Verify environments endpoint responds
    const envData = await page.evaluate(async (token) => {
      const res = await fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } });
      return res.json();
    }, TOKEN);
    console.log('[smoke] environments:', JSON.stringify(envData));
    expect(envData.environments).toBeDefined();
    expect(envData.environments.length).toBeGreaterThanOrEqual(1);
  });

  test('session counts correct for both environments', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => {
      localStorage.setItem('morph-auth', token);
      localStorage.removeItem('morph-killed');
      localStorage.removeItem('morph-environments');
    }, TOKEN);
    await page.reload();
    await page.waitForTimeout(10000);

    // Get env group headers from DOM
    const envGroups = await page.evaluate(() => {
      const groups = document.querySelectorAll('[style*="text-transform: uppercase"]');
      return Array.from(groups).map(el => el.textContent);
    });
    console.log('[smoke] env groups:', envGroups);

    // Docker should exist and have sessions
    const dockerGroup = envGroups.find(g => g?.includes('Docker'));
    expect(dockerGroup).toBeTruthy();

    // Mac should exist and have sessions
    const macGroup = envGroups.find(g => g?.includes('Mac'));
    expect(macGroup).toBeTruthy();

    // Extract counts
    const dockerCount = parseInt(dockerGroup!.match(/\((\d+)\)/)?.[1] || '0');
    const macCount = parseInt(macGroup!.match(/\((\d+)\)/)?.[1] || '0');
    console.log(`[smoke] Docker: ${dockerCount} sessions, Mac: ${macCount} sessions`);

    // Both should have at least 1 session
    expect(dockerCount).toBeGreaterThanOrEqual(1);
    expect(macCount).toBeGreaterThanOrEqual(1);

    // Verify session cards are rendered
    const sessionCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('[style*="border-radius: 10px"]');
      return Array.from(cards).map(el => el.textContent?.slice(0, 60));
    });
    console.log('[smoke] session cards:', sessionCards);
    expect(sessionCards.length).toBe(dockerCount + macCount);
  });

  test('API: sessions endpoints respond without errors', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);

    // Fetch environments to get relay URLs
    const envData = await page.evaluate(async (token) => {
      const res = await fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } });
      return res.json();
    }, TOKEN);

    // Check sessions endpoint for each environment
    for (const env of (envData.environments || [])) {
      const result = await page.evaluate(async ({ url, token }) => {
        try {
          const res = await fetch(`${url}/v2/claude/sessions?limit=10`, { headers: { 'Authorization': `Bearer ${token}` } });
          const data = await res.json();
          return { ok: res.ok, status: res.status, count: data.sessions?.length ?? -1, error: null };
        } catch (e: any) {
          return { ok: false, status: 0, count: -1, error: e.message };
        }
      }, { url: env.relayUrl, token: env.token || TOKEN });

      console.log(`[smoke] ${env.label} (${env.relayUrl}): status=${result.status} sessions=${result.count}`);
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.count).toBeGreaterThanOrEqual(0);
    }
  });

  test('terminal: textarea visible and WebSocket connected', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
    await page.reload();
    await page.waitForTimeout(5000);

    // Textarea should be visible
    const textarea = page.locator('textarea').first();
    const isVisible = await textarea.isVisible({ timeout: 5000 }).catch(() => false);
    expect(isVisible).toBe(true);

    // WebSocket should be connected (check connection log)
    const connState = await page.evaluate(() => (window as any).__connLog?.() || 'N/A');
    console.log('[smoke] connection:', connState);
    expect(connState).toContain('connected');

    // No page errors
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.waitForTimeout(2000);
    if (errors.length) console.log('[smoke] page errors:', errors);
    expect(errors.length).toBe(0);
  });

  test('terminal: can type and send message', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
    await page.reload();
    await page.waitForTimeout(5000);

    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // Type a test message
    await textarea.fill('ping');
    await textarea.press('Enter');
    await page.waitForTimeout(3000);

    // Message should appear in body
    const bodyText = await page.textContent('body');
    expect(bodyText).toContain('ping');

    await page.screenshot({ path: '/tmp/morph-smoke.png', fullPage: true });
  });
});
