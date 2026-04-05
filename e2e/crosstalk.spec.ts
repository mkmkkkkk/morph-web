import { test, expect } from '@playwright/test';

const RELAY = 'http://127.0.0.1:3000';
const TOKEN = 'morph2026';

async function getLayout(page: any) {
  const res = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  return res.json();
}

test('crosstalk check: each pane shows its OWN session content', async ({ page }) => {
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[err] ${msg.text()}`);
  });

  const layout = await getLayout(page);
  const panes = layout.windows?.[0]?.panes || [];
  const routable = panes.filter((p: any) => p.routable);

  // Build expected: each pane's session ID → its history
  const sessionHistories: Record<string, { sessionId: string; firstMsg: string }> = {};
  for (const p of routable) {
    if (!p.sessionId) continue;
    const res = await page.request.get(`${RELAY}/v2/claude/history/${p.sessionId}?limit=5`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    const d = await res.json();
    const msgs = d.messages || [];
    const first = msgs.find((m: any) => m.role === 'user' && m.content?.length > 5);
    sessionHistories[p.tty] = {
      sessionId: p.sessionId,
      firstMsg: first?.content?.slice(0, 80) || '(no user msg)',
    };
  }

  console.log('\n=== Expected content per TTY ===');
  for (const [tty, info] of Object.entries(sessionHistories)) {
    console.log(`  ${tty} → session=${info.sessionId.slice(0, 8)} firstMsg="${info.firstMsg}"`);
  }

  // Auth and load
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((t: string) => localStorage.setItem('morph-auth', t), TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await expect(page.getByText('GRID', { exact: true })).toBeVisible({ timeout: 15000 });

  const results: { tty: string; sessionId: string; expectedMsg: string; foundInView: boolean; viewPreview: string; wrongSession: string | null }[] = [];

  for (const p of routable) {
    const tty = p.tty;
    const expected = sessionHistories[tty];

    // Click pane
    const paneDiv = page.locator(`div[style*="cursor: pointer"]`).filter({
      has: page.locator(`span:text-is("${tty}")`)
    }).first();
    const vis = await paneDiv.isVisible({ timeout: 2000 }).catch(() => false);
    if (!vis) { console.log(`SKIP: ${tty} not visible`); continue; }

    await paneDiv.click();
    const backBtn = page.getByRole('button', { name: 'Back' });
    const opened = await backBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!opened) {
      console.log(`SKIP: ${tty} didn't open`);
      await page.goBack().catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    await page.waitForTimeout(3000);

    // Get all visible text
    const viewText = await page.evaluate(() => {
      const spans = document.querySelectorAll('[data-sel]');
      return Array.from(spans).map(s => s.textContent || '').join('\n');
    });

    // Check if expected first user message appears
    let foundExpected = false;
    let wrongSession: string | null = null;

    if (expected) {
      foundExpected = viewText.includes(expected.firstMsg.slice(0, 30));
    }

    // Check if content from OTHER sessions appears (crosstalk)
    for (const [otherTTY, otherInfo] of Object.entries(sessionHistories)) {
      if (otherTTY === tty) continue;
      if (otherInfo.sessionId === expected?.sessionId) continue; // same session is OK
      const otherSnippet = otherInfo.firstMsg.slice(0, 30);
      if (otherSnippet.length > 10 && viewText.includes(otherSnippet)) {
        wrongSession = `${otherTTY}(${otherInfo.sessionId.slice(0, 8)})`;
        break;
      }
    }

    console.log(`\n${tty}: session=${p.sessionId?.slice(0, 8) || 'none'} viewChars=${viewText.length}`);
    console.log(`  expected="${expected?.firstMsg?.slice(0, 60) || 'N/A'}"`);
    console.log(`  found=${foundExpected} wrongSession=${wrongSession || 'none'}`);
    console.log(`  viewPreview="${viewText.slice(0, 120).replace(/\n/g, ' ')}"`);

    results.push({
      tty,
      sessionId: p.sessionId || 'none',
      expectedMsg: expected?.firstMsg?.slice(0, 60) || 'N/A',
      foundInView: foundExpected,
      viewPreview: viewText.slice(0, 100).replace(/\n/g, ' '),
      wrongSession,
    });

    await backBtn.click();
    await page.waitForTimeout(500);
    await expect(page.getByText('GRID', { exact: true })).toBeVisible({ timeout: 3000 });
  }

  // Summary
  console.log('\n\n=== CROSSTALK REPORT ===');
  for (const r of results) {
    const status = r.wrongSession ? `CROSSTALK from ${r.wrongSession}` : r.foundInView ? 'OK' : 'MISSING';
    console.log(`${r.tty} [${r.sessionId.slice(0, 8)}]: ${status}`);
  }

  const crosstalks = results.filter(r => r.wrongSession);
  if (crosstalks.length > 0) {
    console.log(`\n${crosstalks.length} panes have crosstalk!`);
  }
});
