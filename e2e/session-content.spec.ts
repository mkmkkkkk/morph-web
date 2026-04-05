import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3001';
const TOKEN = process.env.MORPH_TOKEN || 'morph2026';

test.use({
  viewport: { width: 393, height: 852 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
});

/**
 * THE ONLY ACCEPTANCE CRITERION:
 *
 * For each pane position in Ghostty, the Morph web app must show the
 * session content from THAT SAME terminal. If Ghostty position (x,y)
 * has terminal showing "Installing Ollama", then tapping that pane in
 * Morph must show the Ollama session — not something else.
 *
 * Ground truth = Ghostty AX helper (what's actually on each terminal screen).
 * Test path = open Morph → tap pane → read overlay → compare with AX text.
 */
test('every pane position: Morph shows same session as Ghostty terminal', async ({ page }) => {
  page.on('console', msg => {
    if (msg.type() !== 'debug') console.log(`[page:${msg.type()}] ${msg.text()}`);
  });

  // ── 1. Read Ghostty ground truth via AX helper ──
  const ghosttyPid = execSync('pgrep -a ghostty', { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0]?.split(/\s+/)[0];
  expect(ghosttyPid, 'Ghostty not running').toBeTruthy();

  const axHelperBin = `${process.env.HOME}/.local/bin/ghostty_ax_helper`;
  const axOut = execSync(`${axHelperBin} ${ghosttyPid}`, { encoding: 'utf-8', timeout: 10000 }).trim();
  const axData = JSON.parse(axOut);
  const axPanes = axData[0].panes;
  console.log(`\nGhostty AX: ${axPanes.length} panes`);

  // Extract distinctive phrases from each AX pane's screen text.
  // These are the "fingerprints" — if the Morph overlay contains these,
  // the session matches. If not, it's showing the wrong session.
  type GroundTruth = { x: number; y: number; axText: string; fingerprints: string[] };
  const groundTruth: GroundTruth[] = [];

  for (const ax of axPanes) {
    const text = ax.text || '';
    // Extract 3+ word phrases (10+ chars) that are distinctive.
    // Skip VERIFY markers (test artifacts), common shell prompts, and UI chrome.
    const lines = text.split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) =>
        l.length >= 10 &&
        !l.startsWith('>>>') &&      // VERIFY markers
        !l.startsWith('❯') &&        // shell prompt
        !/^⏵/.test(l) &&             // bypass permissions line
        !/shift\+tab|esc to/i.test(l) &&
        !/^[─━]+$/.test(l) &&        // horizontal lines
        !l.startsWith('michaelyang@') // shell PS1
      );

    // Take up to 5 distinctive lines as fingerprints
    const fingerprints = lines.slice(0, 5).map((l: string) =>
      l.length > 80 ? l.slice(0, 80) : l
    );

    groundTruth.push({ x: ax.x, y: ax.y, axText: text, fingerprints });
    console.log(`  AX (${ax.x.toFixed(2)}, ${ax.y.toFixed(2)}): ${fingerprints.length} fingerprints`);
    for (const fp of fingerprints) {
      console.log(`    "${fp.slice(0, 70)}"`);
    }
  }

  // ── 2. Get Morph layout to map positions → pane labels ──
  const layoutRes = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  expect(layoutRes.ok()).toBe(true);
  const layout = await layoutRes.json();
  const morphPanes = layout.windows[0].panes;

  // Match each Morph pane to its AX ground truth by position
  type PaneTest = {
    tty: string; sessionId: string | null;
    morphX: number; morphY: number;
    truth: GroundTruth;
    routable: boolean;
  };
  const tests: PaneTest[] = [];

  for (const mp of morphPanes) {
    if (!mp.routable || !mp.sessionId) continue;

    // Find closest AX pane
    let bestAx: GroundTruth | null = null;
    let bestDist = Infinity;
    for (const gt of groundTruth) {
      const dist = Math.abs(mp.x - gt.x) + Math.abs(mp.y - gt.y);
      if (dist < bestDist) { bestDist = dist; bestAx = gt; }
    }
    if (!bestAx || bestDist > 0.05) {
      console.log(`  ${mp.tty}: no AX match (best dist=${bestDist.toFixed(3)})`);
      continue;
    }

    tests.push({
      tty: mp.tty, sessionId: mp.sessionId,
      morphX: mp.x, morphY: mp.y,
      truth: bestAx, routable: mp.routable,
    });
  }

  console.log(`\n=== Testing ${tests.length} routable panes ===`);

  // ── 3. For each pane: open Morph → tap → read overlay → compare with AX ──
  const results: { tty: string; status: string; detail: string }[] = [];

  for (const t of tests) {
    console.log(`\n━━━ ${t.tty} session=${(t.sessionId || '').slice(0, 8)} at (${t.morphX.toFixed(2)}, ${t.morphY.toFixed(2)}) ━━━`);

    if (t.truth.fingerprints.length === 0) {
      console.log(`  SKIP: no distinctive AX text to compare`);
      results.push({ tty: t.tty, status: 'SKIP', detail: 'no AX fingerprints' });
      continue;
    }

    // Fresh page load
    await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate((token) => {
      localStorage.setItem('morph-auth', token);
      sessionStorage.removeItem('morph-selected-session');
    }, TOKEN);
    await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(page.getByText('GRID', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    // Find and tap pane label
    const label = page.locator(`span:text-is("${t.tty}")`).first();
    const visible = await label.isVisible().catch(() => false);
    if (!visible) {
      results.push({ tty: t.tty, status: 'SKIP', detail: 'label not visible' });
      continue;
    }
    const box = await label.boundingBox();
    if (!box) {
      results.push({ tty: t.tty, status: 'SKIP', detail: 'no bounding box' });
      continue;
    }
    const parentBox = await label.locator('..').boundingBox();
    const tapBox = parentBox || box;
    await page.touchscreen.tap(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2);
    await page.waitForTimeout(4000);

    // Read overlay
    const overlayText = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        const s = getComputedStyle(div);
        if (s.position === 'fixed' && parseInt(s.zIndex) >= 50 && div.offsetHeight > 400) {
          return div.innerText;
        }
      }
      return null;
    });

    await page.screenshot({ path: `/tmp/morph-verify-${t.tty}.png`, fullPage: true });

    if (!overlayText) {
      console.log(`  FAIL: overlay not found`);
      results.push({ tty: t.tty, status: 'FAIL', detail: 'overlay not opened' });
      continue;
    }

    // ── 4. COMPARE: do AX fingerprints appear in Morph overlay? ──
    // The overlay shows session history. The AX text shows what's on screen.
    // If this is the RIGHT session, recent AX content should appear in the history.
    let hits = 0;
    const missed: string[] = [];
    for (const fp of t.truth.fingerprints) {
      // Normalize whitespace for comparison
      const fpNorm = fp.replace(/\s+/g, ' ').trim();
      const overlayNorm = overlayText.replace(/\s+/g, ' ');
      if (overlayNorm.includes(fpNorm)) {
        hits++;
      } else {
        // Try partial match (first 30 chars)
        const partial = fpNorm.slice(0, 30);
        if (partial.length >= 10 && overlayNorm.includes(partial)) {
          hits++;
        } else {
          missed.push(fpNorm.slice(0, 50));
        }
      }
    }

    const pct = Math.round(hits / t.truth.fingerprints.length * 100);
    console.log(`  Fingerprint match: ${hits}/${t.truth.fingerprints.length} (${pct}%)`);
    if (missed.length > 0) {
      console.log(`  Missed:`);
      for (const m of missed) console.log(`    "${m}"`);
    }
    console.log(`  Overlay preview: "${overlayText.slice(0, 200)}"`);

    // Verdict: at least 1 fingerprint must match (generous threshold)
    if (hits > 0) {
      results.push({ tty: t.tty, status: 'OK', detail: `${hits}/${t.truth.fingerprints.length} fingerprints matched` });
    } else {
      // Zero matches = WRONG SESSION at this position
      console.log(`  WRONG SESSION! None of the terminal's screen content appears in Morph overlay.`);
      console.log(`  Terminal shows: "${t.truth.fingerprints[0]?.slice(0, 60)}"`);
      console.log(`  Overlay shows: "${overlayText.slice(0, 200)}"`);
      results.push({ tty: t.tty, status: 'BUG', detail: `0/${t.truth.fingerprints.length} fingerprints — wrong session` });
    }
  }

  // ── 5. Report ──
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║        GHOSTTY ↔ MORPH POSITION VERIFICATION              ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  for (const r of results) {
    const icon = { OK: ' OK ', BUG: 'BUG!', FAIL: 'FAIL', SKIP: 'SKIP' }[r.status] || '????';
    console.log(`║ [${icon}] ${r.tty}: ${r.detail.padEnd(47)} ║`);
  }
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  const bugs = results.filter(r => r.status === 'BUG');
  const fails = results.filter(r => r.status === 'FAIL');
  expect(bugs.length, `WRONG SESSION:\n${bugs.map(b => `  ${b.tty}: ${b.detail}`).join('\n')}`).toBe(0);
  expect(fails.length, `UI FAILURES:\n${fails.map(f => `  ${f.tty}: ${f.detail}`).join('\n')}`).toBe(0);
});
