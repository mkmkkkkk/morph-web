import { test, expect, devices } from '@playwright/test';

const RELAY = 'http://127.0.0.1:3000';
const TOKEN = 'morph2026';

// Use iPhone-like viewport with touch — but Chromium engine
test.use({
  viewport: { width: 393, height: 852 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

test('mobile: grid pane tap opens session', async ({ page }) => {
  page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));

  // 1. Auth & load
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token) => localStorage.setItem('morph-auth', token), TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Wait for grid
  const gridLabel = page.getByText('GRID', { exact: true });
  await expect(gridLabel).toBeVisible({ timeout: 15000 });

  await page.screenshot({ path: '/tmp/morph-mobile-01-grid.png', fullPage: true });

  // 3. Find a routable pane
  const pane = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator('span') }).first();
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  console.log(`Pane box: ${JSON.stringify(box)}`);

  // 4. Simulate real touch tap (touchstart → touchend → click)
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    console.log(`Tapping at (${x}, ${y})`);

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: '/tmp/morph-mobile-02-after-tap.png', fullPage: true });

  // 5. Check if SessionTerminal appeared
  const backBtn = page.getByRole('button', { name: 'Back' });
  const hasBack = await backBtn.isVisible({ timeout: 3000 }).catch(() => false);
  console.log(`Back button after tap: ${hasBack}`);

  if (!hasBack) {
    // Dump what's visible
    const text = await page.locator('body').innerText();
    console.log('Body after tap:', text.slice(0, 500));

    // Check for touch-blocking elements
    const touchInfo = await page.evaluate(() => {
      const overlay = document.querySelector('[style*="inset: 90px"]') as HTMLElement;
      if (!overlay) return { error: 'no overlay' };
      const cs = getComputedStyle(overlay);
      return {
        overflow: cs.overflow,
        overflowY: cs.overflowY,
        pointerEvents: cs.pointerEvents,
        touchAction: cs.touchAction,
        webkitOverflowScrolling: (cs as any).webkitOverflowScrolling,
        zIndex: cs.zIndex,
        // Check if overlay is actually scrollable
        scrollHeight: overlay.scrollHeight,
        clientHeight: overlay.clientHeight,
        isScrollable: overlay.scrollHeight > overlay.clientHeight,
      };
    });
    console.log('Overlay CSS:', JSON.stringify(touchInfo));

    // Try a different approach — tap directly using JS
    console.log('\nRetrying with manual touch events...');
    await page.evaluate((box) => {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const target = document.elementFromPoint(x, y);
      console.log(`elementFromPoint(${x},${y}) = ${target?.tagName} text="${target?.textContent?.slice(0,30)}"`);

      // Dispatch touch events
      const touch = new Touch({ identifier: 1, target: target!, clientX: x, clientY: y });
      target?.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], bubbles: true }));
      target?.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch], bubbles: true }));
      // Then click
      target?.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
    }, box!);

    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/morph-mobile-03-retry.png', fullPage: true });

    const hasBack2 = await backBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`Back button after manual touch: ${hasBack2}`);
  }

  expect(hasBack).toBe(true);
});
