import { test } from '@playwright/test';

const TOKEN = process.env.MORPH_TOKEN || 'morph2026';

test('perf audit — cold first-load + warm reload', async ({ browser }) => {
  // ── Cold load: fresh context, no auth, no service-worker, no cache ──
  const cold = await browser.newContext({ serviceWorkers: 'block' });
  const page = await cold.newPage();

  const requests: any[] = [];
  page.on('response', async (r) => {
    try {
      const t = r.timing();
      const headers = r.headers();
      requests.push({
        url: r.url(),
        status: r.status(),
        contentType: headers['content-type'] || '',
        contentLength: parseInt(headers['content-length'] || '0') || 0,
        method: r.request().method(),
        timing: t,
        finished: Date.now(),
      });
    } catch {}
  });

  const t0 = Date.now();
  await page.goto('/', { waitUntil: 'load', timeout: 60000 });
  const loadElapsed = Date.now() - t0;

  // After login, navigate again with auth — measure full app paint
  await page.evaluate((tok) => localStorage.setItem('morph-auth', tok), TOKEN);

  const t1 = Date.now();
  await page.reload({ waitUntil: 'load' });
  const reloadElapsed = Date.now() - t1;

  // Wait for app to settle a bit so post-mount API calls complete
  await page.waitForTimeout(8000);

  // Pull Performance API metrics
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as any;
    const paints = performance.getEntriesByType('paint');
    const resources = performance.getEntriesByType('resource') as any[];
    return {
      navigation: nav ? {
        domContentLoadedEnd: nav.domContentLoadedEventEnd,
        loadEventEnd: nav.loadEventEnd,
        responseStart: nav.responseStart,
        responseEnd: nav.responseEnd,
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
      } : null,
      paints: paints.map((p: any) => ({ name: p.name, startTime: Math.round(p.startTime) })),
      resourceCount: resources.length,
      // largest resources
      heavyResources: resources
        .map((r: any) => ({ url: r.name, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, duration: Math.round(r.duration), startTime: Math.round(r.startTime) }))
        .filter((r: any) => r.transferSize > 5000)
        .sort((a: any, b: any) => b.transferSize - a.transferSize)
        .slice(0, 15),
      // API calls fired
      apiCalls: resources
        .filter((r: any) => /\/v[12]\//.test(r.name) || /\/api\//.test(r.name))
        .map((r: any) => ({ url: r.name, startTime: Math.round(r.startTime), duration: Math.round(r.duration), transferSize: r.transferSize })),
    };
  });

  console.log('=====PERF=====');
  console.log(JSON.stringify({
    coldLoadMs: loadElapsed,
    warmReloadMs: reloadElapsed,
    perf,
  }, null, 2));

  // Capture WebSocket activity
  const wsLogs = await page.evaluate(() => ((window as any).__connLog?.() || 'N/A'));
  console.log('=====WS=====', wsLogs);

  await cold.close();
});
