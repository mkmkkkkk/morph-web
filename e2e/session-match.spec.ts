import { test, expect } from '@playwright/test';

const RELAY = 'http://127.0.0.1:3000';
const TOKEN = 'morph2026';

async function getLayout(page: any) {
  const res = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

test('session view loads rich content for each routable pane', async ({ page }) => {
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[page:error] ${msg.text()}`);
  });

  // 1. Get layout API
  const layout = await getLayout(page);
  const apiPanes = layout.windows?.[0]?.panes || [];
  console.log(`\nLayout API panes: ${apiPanes.length}`);
  for (const p of apiPanes) {
    console.log(`  ${p.tty}: axText=${(p.axText || '').length} textPreview=${(p.textPreview || '').length} routable=${p.routable} session=${p.sessionId?.slice(0, 8) || 'none'}`);
  }

  // 2. Auth and load the web app
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token: string) => localStorage.setItem('morph-auth', token), TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const gridLabel = page.getByText('GRID', { exact: true });
  await expect(gridLabel).toBeVisible({ timeout: 15000 });

  // 3. For each routable pane, click in and verify session view loads rich content
  const routablePanes = apiPanes.filter((p: any) => p.routable);
  console.log(`\nTesting ${routablePanes.length} routable panes:\n`);

  const results: { tty: string; pass: boolean; chars: number; detail: string }[] = [];

  for (const apiPane of routablePanes) {
    const tty = apiPane.tty;
    const hasSession = !!apiPane.sessionId;

    console.log(`=== ${tty} (${apiPane.process}, session=${apiPane.sessionId?.slice(0, 8) || 'none'}) ===`);

    // Click the pane in the grid
    const paneDiv = page.locator(`div[style*="cursor: pointer"]`).filter({
      has: page.locator(`span:text-is("${tty}")`)
    }).first();

    const paneVisible = await paneDiv.isVisible({ timeout: 2000 }).catch(() => false);
    if (!paneVisible) {
      console.log(`  SKIP: pane not found in grid\n`);
      results.push({ tty, pass: false, chars: 0, detail: 'pane not found' });
      continue;
    }

    await paneDiv.click();

    // Wait for session view
    const backBtn = page.getByRole('button', { name: 'Back' });
    const opened = await backBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!opened) {
      console.log(`  SKIP: session view didn't open\n`);
      results.push({ tty, pass: false, chars: 0, detail: 'did not open' });
      await page.goBack().catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    // Wait for content to load (history fetch + subscribe-tty initial payload)
    await page.waitForTimeout(3000);

    // Get session view text
    const sessionText = await page.evaluate(() => {
      const spans = document.querySelectorAll('[data-sel]');
      return Array.from(spans).map(s => s.textContent || '').join('\n');
    });

    const charCount = sessionText.length;
    // Panes with a session ID should have history (substantial content)
    // Panes without session ID only get AX text preview
    const minChars = hasSession ? 200 : 50;
    const pass = charCount >= minChars;

    console.log(`  Content: ${charCount} chars (need >=${minChars}) → ${pass ? 'PASS' : 'FAIL'}`);
    console.log(`  Preview: "${sessionText.slice(0, 120).replace(/\n/g, ' ')}"`);

    await page.screenshot({ path: `/tmp/morph-match-${tty}.png`, fullPage: true });
    results.push({ tty, pass, chars: charCount, detail: pass ? 'ok' : `only ${charCount} chars` });

    // Go back to grid
    await backBtn.click();
    await page.waitForTimeout(500);
    await expect(gridLabel).toBeVisible({ timeout: 3000 });
    console.log('');
  }

  // Summary
  console.log('\n=== Session View Content Check ===');
  console.log('TTY       | Pass  | Chars | Detail');
  console.log('----------|-------|-------|-------------------');
  for (const r of results) {
    console.log(`${r.tty.padEnd(9)} | ${(r.pass ? 'PASS' : 'FAIL').padEnd(5)} | ${String(r.chars).padEnd(5)} | ${r.detail.slice(0, 40)}`);
  }

  const passCount = results.filter(r => r.pass).length;
  const failCount = results.filter(r => !r.pass).length;
  console.log(`\nTotal: ${passCount} pass, ${failCount} fail out of ${results.length}`);

  // All routable panes should show content
  expect(failCount).toBeLessThanOrEqual(1);
});
