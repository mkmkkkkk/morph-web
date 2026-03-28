import { test, expect } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'test-token';

test('verify: Docker sessions now visible', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((token) => {
    localStorage.setItem('morph-auth', token);
    localStorage.removeItem('morph-killed');
    localStorage.removeItem('morph-environments');
  }, TOKEN);
  await page.reload();
  await page.waitForTimeout(8000);

  // Check env group headers
  const envGroups = await page.evaluate(() => {
    const groups = document.querySelectorAll('[style*="text-transform: uppercase"]');
    return Array.from(groups).map(el => el.textContent);
  });
  console.log('[verify] env groups:', envGroups);

  // Count session cards
  const sessionCards = await page.evaluate(() => {
    const cards = document.querySelectorAll('[style*="border-radius: 10px"]');
    return Array.from(cards).map(el => el.textContent?.slice(0, 60));
  });
  console.log('[verify] session cards:', sessionCards);

  await page.screenshot({ path: '/tmp/morph-verify.png', fullPage: true });

  // Docker should have at least 1 visible session now
  const dockerGroup = envGroups.find(g => g?.includes('Docker'));
  expect(dockerGroup).toBeTruthy();
  expect(dockerGroup).not.toContain('(0)');
  console.log('[verify] PASS: Docker has sessions');
});
