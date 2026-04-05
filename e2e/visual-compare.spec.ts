import { test, expect } from '@playwright/test';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3001';
const TOKEN = process.env.MORPH_TOKEN || 'morph2026';

test.use({
  viewport: { width: 393, height: 852 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
});

/**
 * Visual comparison: Panel (PTY) vs Terminal (JSONL)
 *
 * Goal: Both views should look visually similar:
 * - User messages: green with ">" prefix
 * - Claude text: white, pre-wrap
 * - Tool calls: collapsible blocks with ▸/▾ toggles
 * - Thinking: collapsible
 */
test('screenshot Panel (PTY) view for visual comparison', async ({ page }) => {
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warn') {
      console.log(`[page:${msg.type()}] ${msg.text()}`);
    }
  });

  // Authenticate
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token) => {
    localStorage.setItem('morph-auth', token);
    sessionStorage.removeItem('morph-selected-session');
  }, TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Wait for grid to load
  await expect(page.getByText('GRID', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(3000);

  // Take screenshot of grid view
  await page.screenshot({ path: '/tmp/morph-visual-grid.png', fullPage: true });
  console.log('Grid screenshot saved to /tmp/morph-visual-grid.png');

  // Find any TTY pane (Panel) and tap it
  const ttyLabels = await page.locator('span').filter({ hasText: /^ttys\d{3}$/ }).all();
  console.log(`Found ${ttyLabels.length} TTY labels`);

  if (ttyLabels.length > 0) {
    // Pick ttys000 (this session) — has rich content with tool calls
    // If ttys000 not found, try ttys007
    let label = ttyLabels[0];
    const target = process.env.TEST_TTY || 'ttys000';
    for (const l of ttyLabels) {
      const t = await l.textContent();
      if (t === target) { label = l; break; }
    }
    const labelText = await label.textContent();
    console.log(`Tapping TTY pane: ${labelText}`);

    const box = await label.boundingBox();
    if (box) {
      // Tap the parent container (the pane cell)
      const parent = label.locator('..');
      const parentBox = await parent.boundingBox();
      const tapBox = parentBox || box;
      await page.touchscreen.tap(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2);
      await page.waitForTimeout(5000); // Wait for PTY data to load

      // Take Panel screenshot
      await page.screenshot({ path: '/tmp/morph-visual-panel.png', fullPage: true });
      console.log('Panel (PTY) screenshot saved to /tmp/morph-visual-panel.png');

      // Dump the visible text content of the overlay for debugging
      const overlayText = await page.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const s = getComputedStyle(div);
          if (s.position === 'fixed' && parseInt(s.zIndex) >= 50 && div.offsetHeight > 400) {
            return div.innerText;
          }
        }
        return 'NO OVERLAY FOUND';
      });
      console.log(`\n=== Panel (PTY) content preview ===\n${overlayText.slice(0, 1500)}\n===\n`);

      // Debug: check rendered DOM structure for "Tip:" text
      const tipDebug = await page.evaluate(() => {
        const allSpans = document.querySelectorAll('[data-sel]');
        const tips: string[] = [];
        for (const span of allSpans) {
          const t = span.textContent || '';
          if (t.includes('Tip')) tips.push(`SPAN: "${t.slice(0, 80)}" parent=${span.parentElement?.tagName}`);
        }
        // Also check all divs
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const t = div.textContent || '';
          if (t.includes('Tip:') && !t.includes('Tab') && t.length < 200) {
            tips.push(`DIV: "${t.slice(0, 100)}" style=${div.getAttribute('style')?.slice(0, 80)}`);
          }
        }
        return tips;
      });
      for (const td of tipDebug) console.log(`TIP DEBUG: ${td}`);

      // Check that basic structure exists:
      // 1. User messages (green, "> prefix")
      const userMsgs = await page.locator('span:has-text(">")').filter({ hasText: /^>/ }).count();
      console.log(`User messages (> prefix): ${userMsgs}`);

      // 2. Collapsible tool blocks (▸ label)
      const toolBlocks = await page.locator('span:has-text("▸")').count();
      console.log(`Collapsible tool blocks (▸): ${toolBlocks}`);

      // 3. Text blocks exist
      const textBlocks = await page.evaluate(() => {
        const spans = document.querySelectorAll('[data-sel]');
        return spans.length;
      });
      console.log(`Selectable text spans: ${textBlocks}`);

      // Go back to grid
      // Look for back button or navigate back
      const backBtn = page.locator('button, div[role="button"]').filter({ hasText: /←|back|close/i }).first();
      if (await backBtn.isVisible().catch(() => false)) {
        await backBtn.click();
      } else {
        await page.goBack();
      }
      await page.waitForTimeout(1000);
    }
  }

  // Now navigate to Terminal (JSONL) view for comparison
  // Go back to main screen first
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token) => {
    localStorage.setItem('morph-auth', token);
  }, TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Toggle GRID off to show session list
  const gridToggle = page.getByText('GRID', { exact: true });
  if (await gridToggle.isVisible().catch(() => false)) {
    await gridToggle.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/morph-visual-terminal-list.png', fullPage: true });
    console.log('Terminal list screenshot saved to /tmp/morph-visual-terminal-list.png');

    // Click the first session card
    const sessionCards = await page.locator('[style*="border-radius: 10px"]').all();
    console.log(`Found ${sessionCards.length} session cards`);
    if (sessionCards.length > 0) {
      await sessionCards[0].click();
      await page.waitForTimeout(5000);

      await page.screenshot({ path: '/tmp/morph-visual-terminal.png', fullPage: true });
      console.log('Terminal (JSONL) screenshot saved to /tmp/morph-visual-terminal.png');

      const termText = await page.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const s = getComputedStyle(div);
          if (s.position === 'fixed' && parseInt(s.zIndex) >= 50 && div.offsetHeight > 400) {
            return div.innerText;
          }
        }
        return 'NO OVERLAY FOUND';
      });
      console.log(`\n=== Terminal (JSONL) content preview ===\n${termText.slice(0, 1500)}\n===\n`);
    }
  }
});
