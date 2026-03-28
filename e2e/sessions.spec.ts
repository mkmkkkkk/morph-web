import { test, expect } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'test-token';

test('debug: intercept session fetch requests', async ({ page }) => {
  // Track all fetch requests to sessions endpoint
  const sessionRequests: { url: string; status: number; body: string }[] = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/v2/claude/sessions')) {
      const body = await response.text().catch(() => 'FAILED_TO_READ');
      sessionRequests.push({ url, status: response.status(), body: body.slice(0, 500) });
      console.log(`[fetch] ${response.status()} ${url} → ${body.slice(0, 200)}`);
    }
  });

  page.on('requestfailed', (request) => {
    if (request.url().includes('/v2/claude/sessions') || request.url().includes('tr.mkyang')) {
      console.log(`[fetch-FAIL] ${request.url()} → ${request.failure()?.errorText}`);
    }
  });

  // Pre-auth, clear stale data
  await page.goto('/');
  await page.evaluate((token) => {
    localStorage.setItem('morph-auth', token);
    localStorage.removeItem('morph-killed');
    localStorage.removeItem('morph-environments');
  }, TOKEN);
  await page.reload();

  // Wait for everything to settle
  await page.waitForTimeout(12000);

  console.log('\n=== All session requests ===');
  for (const r of sessionRequests) {
    console.log(`  ${r.status} ${r.url}`);
    console.log(`  body: ${r.body.slice(0, 300)}`);
  }
  console.log(`Total requests: ${sessionRequests.length}`);

  // Check what the EnvironmentGroup components actually rendered
  const envGroups = await page.evaluate(() => {
    const groups = document.querySelectorAll('[style*="text-transform: uppercase"]');
    return Array.from(groups).map(el => el.textContent);
  });
  console.log('[debug] env group headers:', envGroups);

  // Count session cards (the ones with borderRadius: 10)
  const sessionCards = await page.evaluate(() => {
    const cards = document.querySelectorAll('[style*="border-radius: 10px"]');
    return Array.from(cards).map(el => el.textContent?.slice(0, 50));
  });
  console.log('[debug] session cards:', sessionCards);

  await page.screenshot({ path: '/tmp/morph-sessions.png', fullPage: true });
});
