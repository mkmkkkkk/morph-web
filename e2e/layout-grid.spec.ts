import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:3001';
const TOKEN = process.env.MORPH_TOKEN || 'morph2026';

test('spatial grid: pane-TTY mapping matches actual Ghostty layout', async ({ page }) => {
  // 1. Get Ghostty PID and enumerate TTYs (fdNum order = creation order)
  const ghosttyPid = execSync('pgrep -a ghostty', { encoding: 'utf-8' }).trim().split('\n')[0]?.split(/\s+/)[0];
  const lsofOut = execSync(`lsof -p ${ghosttyPid} 2>/dev/null | grep /dev/ptmx`, { encoding: 'utf-8', timeout: 5000 });
  const ttys = lsofOut.trim().split('\n').filter(Boolean).map(line => {
    const cols = line.split(/\s+/);
    const devCol = cols.find(c => /^\d+,\d+$/.test(c));
    const fdCol = cols.find(c => /^\d+[urw]$/.test(c));
    if (!devCol) return null;
    const minor = parseInt(devCol.split(',')[1]);
    const fdNum = fdCol ? parseInt(fdCol) : 0;
    return { name: `ttys${String(minor).padStart(3, '0')}`, fdNum };
  }).filter(Boolean) as { name: string; fdNum: number }[];
  ttys.sort((a, b) => a.fdNum - b.fdNum);

  // Only take Ghostty panes (not subprocesses) — count via AppleScript UUIDs
  const uuidOut = execSync(`osascript -e 'tell application "Ghostty" to get id of every terminal of every window'`, { encoding: 'utf-8', timeout: 3000 }).trim();
  const paneCount = uuidOut.split(', ').filter(s => /^[0-9A-F]{8}-/i.test(s)).length;
  const ttyList = ttys.slice(0, paneCount);
  console.log(`Discovered ${ttyList.length} TTYs (fdNum order): ${ttyList.map(t => t.name).join(', ')}`);

  // 2. Read AX panes directly (spatial order: x asc, y asc)
  const axHelperBin = `${process.env.HOME}/.local/bin/ghostty_ax_helper`;
  const axOut = execSync(
    `${axHelperBin} ${ghosttyPid}`,
    { encoding: 'utf-8', timeout: 10000 }
  ).trim();
  const axData = JSON.parse(axOut);
  const axPanes = axData[0].panes;
  console.log(`AX helper returned ${axPanes.length} panes`);

  // 3. Ground truth: fdNum order = AX spatial order (verified invariant)
  //    axPanes[i] corresponds to ttyList[i]
  const groundTruth: Record<string, string> = {};
  console.log('\n=== Ground Truth (fdNum→AX spatial zip) ===');
  for (let i = 0; i < Math.min(ttyList.length, axPanes.length); i++) {
    const key = `${axPanes[i].x.toFixed(2)},${axPanes[i].y.toFixed(2)}`;
    groundTruth[key] = ttyList[i].name;
    console.log(`  ${key} → ${ttyList[i].name} (fd${ttyList[i].fdNum})`);
  }

  // 4. Fetch layout API
  const layoutRes = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  expect(layoutRes.ok()).toBe(true);
  const layout = await layoutRes.json();
  const panes = layout.windows[0].panes;

  // 5. Compare layout API TTY assignments vs ground truth
  console.log('\n=== Layout API vs Ground Truth ===');
  let correct = 0, wrong = 0, unknown = 0;
  for (const p of panes) {
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    const truth = groundTruth[key];
    if (!truth) {
      console.log(`  ${key}: api=${p.tty} truth=UNKNOWN`);
      unknown++;
      continue;
    }
    const match = p.tty === truth;
    if (match) correct++;
    else wrong++;
    console.log(`  ${key}: api=${p.tty} truth=${truth} ${match ? 'CORRECT' : 'WRONG <<<'}`);
  }

  console.log(`\nResult: ${correct} correct, ${wrong} wrong, ${unknown} unknown out of ${panes.length}`);

  // 6. Render visual grid with correctness indicators
  await page.setContent(`<!DOCTYPE html><html><head><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0a0a0a; font-family:monospace; padding:20px; }
    h1 { color:#fff; font-size:18px; margin-bottom:12px; }
    .grid { position:relative; width:900px; height:600px; background:#111; border-radius:8px; border:1px solid #333; }
    .pane { position:absolute; border-radius:4px; padding:8px; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; }
    .correct { border:2px solid #0f0; }
    .wrong { border:3px solid #f00; }
    .unknown { border:2px dashed #ff0; }
    .label { color:#fff; font-weight:700; font-size:14px; }
    .sub { color:rgba(255,255,255,0.5); font-size:11px; }
    .status { font-size:20px; position:absolute; top:4px; right:8px; }
  </style></head><body>
    <h1>Layout Verification: API mapping vs Ground Truth</h1>
    <div class="grid" id="grid"></div>
  </body></html>`);

  const COLORS = ['#1a3a5c','#3c1a5c','#1a5c3a','#5c3a1a','#5c1a3a','#1a5c5c','#5c5c1a','#3a1a5c','#1a3c5c'];
  await page.evaluate(({ panes, groundTruth, COLORS }) => {
    const grid = document.getElementById('grid')!;
    panes.forEach((p: any, i: number) => {
      const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      const truth = (groundTruth as any)[key];
      const isCorrect = truth && p.tty === truth;
      const isWrong = truth && p.tty !== truth;
      const cls = isCorrect ? 'correct' : isWrong ? 'wrong' : 'unknown';
      const statusIcon = isCorrect ? 'OK' : isWrong ? 'WRONG' : '?';

      const div = document.createElement('div');
      div.className = `pane ${cls}`;
      div.style.cssText = `left:${p.x*900}px;top:${p.y*600}px;width:${p.w*900}px;height:${p.h*600}px;background:${COLORS[i%9]}`;
      div.innerHTML = `
        <div>
          <div class="label">${p.tty.replace('ttys','s')}</div>
          <div class="sub">${p.process} | ${p.rows}r x ${p.cols}c</div>
          ${truth && !isCorrect ? `<div class="sub" style="color:#f66">should be: ${truth}</div>` : ''}
        </div>
        <div class="status" style="color:${isCorrect?'#0f0':isWrong?'#f00':'#ff0'}">${statusIcon}</div>
      `;
      grid.appendChild(div);
    });
  }, { panes, groundTruth, COLORS });

  await page.screenshot({ path: '/tmp/morph-layout-verify.png', fullPage: true });
  console.log('\nScreenshot: /tmp/morph-layout-verify.png');

  // 7. Assertions
  expect(wrong).toBe(0);
  expect(correct).toBeGreaterThanOrEqual(7); // at least 7 of 9 verified
});

test('routing: message reaches correct wrapper via TTY', async ({ page }) => {
  // Pick a test target
  const layoutRes = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  const layout = await layoutRes.json();
  const panes = layout.windows[0].panes;
  const target = panes.find((p: any) => p.process === 'claude' && !p.focused);
  if (!target) { console.log('No suitable pane'); return; }

  const testMsg = `ROUTE_VERIFY_${Date.now()}`;
  console.log(`Sending "${testMsg}" → ${target.tty} at (${target.x.toFixed(2)},${target.y.toFixed(2)})`);

  // Connect via Socket.IO and send
  await page.goto('about:blank');
  await page.addScriptTag({ url: 'https://cdn.socket.io/4.7.5/socket.io.min.js' });

  const result = await page.evaluate(async ({ relay, token, tty, msg }) => {
    return new Promise<string>((resolve) => {
      const socket = (window as any).io(relay, {
        path: '/v1/updates',
        transports: ['websocket'],
        auth: { token },
      });
      socket.on('connect', () => {
        socket.emit('direct-send', { tty, message: msg });
        setTimeout(() => { socket.disconnect(); resolve('sent'); }, 1500);
      });
      socket.on('connect_error', (e: any) => resolve('err:' + e.message));
      setTimeout(() => resolve('timeout'), 5000);
    });
  }, { relay: RELAY, token: TOKEN, tty: target.tty, msg: testMsg });

  expect(result).toBe('sent');

  // Verify in relay log
  const relayLog = execSync('tail -20 /tmp/morph-relay.log', { encoding: 'utf-8' });
  console.log('Relay routing log:');
  const routeLine = relayLog.split('\n').find(l => l.includes('routing message') && l.includes(target.tty));
  console.log(`  ${routeLine || 'NOT FOUND'}`);
  expect(routeLine).toBeTruthy();

  // Verify wrapper received
  const wrapperLog = execSync(`grep "${testMsg}" /tmp/morph-wrapper.log 2>/dev/null || echo "NOT_IN_LOG"`, { encoding: 'utf-8' }).trim();
  console.log(`Wrapper received: ${wrapperLog}`);
  expect(wrapperLog).toContain(testMsg);
});
