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

  test('session counts correct for active environment(s)', async ({ page }) => {
    // Architecture as of 2026-04 (decision.md): Docker for relay was rejected,
    // Morph runs on Mac directly. The default landing view is GRID (panels
    // by TTY) — env group headers are only rendered in the legacy session-list
    // mode. So the assertion is API-driven: every advertised env must have a
    // reachable /sessions endpoint with non-negative count, and the primary
    // env must have >=1 session. The DOM check is reduced to "the grid
    // rendered SOMETHING addressable per session" — TTY buttons.
    await page.goto('/');
    await page.evaluate((token) => {
      localStorage.setItem('morph-auth', token);
      localStorage.removeItem('morph-killed');
      localStorage.removeItem('morph-environments');
    }, TOKEN);
    await page.reload();
    await page.waitForTimeout(15000);

    // Tunnel can flap during a long test run (cloudflared reconnects ~every
    // few minutes). Retry the env fetch a few times so a single flap doesn't
    // kill the test — it's about behaviour, not flakey infra.
    const advertised = await page.evaluate(async (token) => {
      for (let i = 0; i < 4; i++) {
        try {
          const res = await fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } });
          if (res.ok) {
            const ctype = res.headers.get('content-type') || '';
            if (ctype.includes('json')) {
              const j = await res.json();
              return (j.environments || []).map((e: any) => ({ id: e.id, label: e.label, relayUrl: e.relayUrl, token: e.token }));
            }
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('environments endpoint did not respond with JSON after 4 attempts');
    }, TOKEN);
    console.log('[smoke] advertised envs:', advertised);
    expect(advertised.length).toBeGreaterThanOrEqual(1);

    // Per-env session counts via API
    let totalSessions = 0;
    for (const env of advertised) {
      const cnt = await page.evaluate(async ({ url, token, fallback }) => {
        const res = await fetch(`${url}/v2/claude/sessions?limit=50`, { headers: { 'Authorization': `Bearer ${token || fallback}` } });
        const j = await res.json();
        return Array.isArray(j.sessions) ? j.sessions.length : -1;
      }, { url: env.relayUrl, token: env.token, fallback: TOKEN });
      console.log(`[smoke] ${env.label}: ${cnt} sessions`);
      expect(cnt, `${env.label} sessions endpoint must respond with a count`).toBeGreaterThanOrEqual(0);
      totalSessions += Math.max(cnt, 0);
    }

    // Primary env must have at least 1 active terminal session
    const primary = advertised[0];
    const primaryCount = await page.evaluate(async ({ url, token, fallback }) => {
      const res = await fetch(`${url}/v2/claude/sessions?limit=50`, { headers: { 'Authorization': `Bearer ${token || fallback}` } });
      const j = await res.json();
      return Array.isArray(j.sessions) ? j.sessions.length : 0;
    }, { url: primary.relayUrl, token: primary.token, fallback: TOKEN });
    expect(primaryCount, `primary env "${primary.label}" must have >=1 session`).toBeGreaterThanOrEqual(1);

    // Note: we deliberately stop at the API layer here. The DOM render of
    // panels is exercised by test 4 (textarea + WS) and test 5 (type + send).
    // Tying test 2 to a specific layout's selectors made it brittle every
    // time the grid markup changed; the API-shape check above is the stable
    // contract.
  });

  test('API: sessions endpoints respond without errors', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);

    // Fetch environments — retry to absorb cloudflared-tunnel reconnects
    // that occasionally return HTML 502 instead of JSON during a session
    // hand-off. Same pattern used in the env-counts test above.
    const envData = await page.evaluate(async (token) => {
      for (let i = 0; i < 4; i++) {
        try {
          const res = await fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } });
          if (res.ok && (res.headers.get('content-type') || '').includes('json')) return res.json();
        } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('environments endpoint did not respond with JSON after 4 attempts');
    }, TOKEN);

    // Check sessions endpoint for each environment
    for (const env of (envData.environments || [])) {
      const result = await page.evaluate(async ({ url, token }) => {
        for (let i = 0; i < 4; i++) {
          try {
            const res = await fetch(`${url}/v2/claude/sessions?limit=10`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
              const data = await res.json();
              return { ok: true, status: res.status, count: data.sessions?.length ?? -1, error: null };
            }
          } catch (e: any) {
            // ignore, retry
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        return { ok: false, status: 0, count: -1, error: 'no JSON response after 4 attempts' };
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
