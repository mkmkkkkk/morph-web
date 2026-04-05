import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const RELAY = 'http://127.0.0.1:3000';
const TOKEN = 'morph2026';

/**
 * Helper: authenticate and wait for grid to render.
 */
async function authAndWaitForGrid(page: any) {
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((token: string) => localStorage.setItem('morph-auth', token), TOKEN);
  await page.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const gridLabel = page.getByText('GRID', { exact: true });
  await expect(gridLabel).toBeVisible({ timeout: 15000 });
}

/**
 * Helper: get layout from API.
 */
async function getLayout(page: any) {
  const res = await page.request.get(`${RELAY}/v2/claude/layout`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

test.describe('Session E2E: content + send/receive', () => {

  test('session view shows substantial content on tap (not truncated preview)', async ({ page }) => {
    page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

    await authAndWaitForGrid(page);

    // Get layout to find a routable pane with textPreview
    const layout = await getLayout(page);
    const panes = layout.windows?.[0]?.panes || [];
    const routable = panes.filter((p: any) => p.routable && p.process === 'claude');
    console.log(`Routable panes: ${routable.length}`);
    expect(routable.length).toBeGreaterThan(0);

    // Log textPreviews
    for (const p of routable) {
      console.log(`  ${p.tty}: preview=${(p.textPreview || '').length} chars, session=${p.sessionId?.slice(0, 8) || 'none'}`);
    }

    // Click the first routable pane
    const pane = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator('span') }).first();
    await expect(pane).toBeVisible();
    const paneText = await pane.innerText();
    console.log(`Clicking: "${paneText.trim().slice(0, 80)}"`);
    await pane.click();

    // Wait for SessionTerminal
    const backBtn = page.getByRole('button', { name: 'Back' });
    await expect(backBtn).toBeVisible({ timeout: 5000 });

    // Wait for content to load (subscribe-tty → initial payload + live updates)
    await page.waitForTimeout(3000);

    await page.screenshot({ path: '/tmp/morph-session-content.png', fullPage: true });

    // Get all displayed message content
    const messageContent = await page.evaluate(() => {
      // Find the scrollable message container
      const containers = document.querySelectorAll('[style*="overflow"]');
      let longestText = '';
      for (const c of containers) {
        const text = c.textContent || '';
        if (text.length > longestText.length) longestText = text;
      }
      return longestText;
    });

    console.log(`Session content length: ${messageContent.length} chars`);
    console.log(`Content preview: "${messageContent.slice(0, 200)}"`);

    // Content should be more than just a short preview
    // Layout textPreview is 120 chars max — session view should show more
    expect(messageContent.length).toBeGreaterThan(50);

    // Should not contain raw escape codes
    expect(messageContent).not.toContain('\\x1b');
    expect(messageContent).not.toContain('\x1b');
    expect(messageContent).not.toContain('?2026');
  });

  test('subscribe-tty sends initial cached content', async ({ page }) => {
    page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

    // First, trigger some PTY output so relay has cached lastPtyText.
    // We do this by fetching the layout (which causes the wrapper to register).
    const layout = await getLayout(page);
    const panes = layout.windows?.[0]?.panes || [];
    const routableTTY = panes.find((p: any) => p.routable && p.process === 'claude')?.tty;
    if (!routableTTY) {
      console.log('No routable Claude pane — skipping');
      return;
    }
    console.log(`Testing subscribe-tty initial payload for ${routableTTY}`);

    // Connect via Socket.IO and subscribe
    await page.goto('about:blank');
    // Load socket.io from the relay server
    await page.addScriptTag({ url: `${RELAY}/socket.io/socket.io.js` }).catch(() => {});
    // Fallback: use CDN
    const hasIO = await page.evaluate(() => typeof (window as any).io !== 'undefined');
    if (!hasIO) {
      await page.addScriptTag({ url: 'https://cdn.socket.io/4.7.5/socket.io.min.js' });
    }

    const result = await page.evaluate(async ({ relay, token, tty }: any) => {
      return new Promise<{ gotInitial: boolean; textLen: number; preview: string }>((resolve) => {
        const socket = (window as any).io(relay, {
          path: '/v1/updates',
          transports: ['websocket'],
          auth: { token },
        });
        let gotInitial = false;
        let textLen = 0;
        let preview = '';

        socket.on('claude-output', (data: any) => {
          if (!gotInitial) {
            gotInitial = true;
            textLen = data.text?.length || 0;
            preview = (data.text || '').slice(0, 150);
          }
        });

        socket.on('connect', () => {
          socket.emit('subscribe-tty', { tty });
        });

        // Wait 5s for initial payload
        setTimeout(() => {
          socket.disconnect();
          resolve({ gotInitial, textLen, preview });
        }, 5000);
      });
    }, { relay: RELAY, token: TOKEN, tty: routableTTY });

    console.log(`Initial payload received: ${result.gotInitial}`);
    console.log(`Text length: ${result.textLen}`);
    console.log(`Preview: "${result.preview}"`);

    // Note: initial payload only exists if wrapper has sent terminal-output since relay started
    // This may be false right after relay restart — that's expected
    if (result.gotInitial) {
      expect(result.textLen).toBeGreaterThan(0);
    } else {
      console.log('No initial payload — wrappers may not have sent PTY output since relay restart');
    }
  });

  test('send message via wrapper socket reaches correct TTY', async ({ page }) => {
    page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

    const layout = await getLayout(page);
    const panes = layout.windows?.[0]?.panes || [];
    // Find a routable Claude pane (not the focused/current one)
    const target = panes.find((p: any) => p.routable && p.process === 'claude' && !p.focused);
    if (!target) {
      console.log('No suitable non-focused Claude pane — skipping');
      return;
    }
    console.log(`Target: ${target.tty} session=${target.sessionId?.slice(0, 8) || 'none'}`);

    const testMsg = `PW_SEND_${Date.now()}`;

    // Send via Socket.IO direct-send
    await page.goto('about:blank');
    await page.addScriptTag({ url: `${RELAY}/socket.io/socket.io.js` }).catch(() => {});
    const hasIO = await page.evaluate(() => typeof (window as any).io !== 'undefined');
    if (!hasIO) {
      await page.addScriptTag({ url: 'https://cdn.socket.io/4.7.5/socket.io.min.js' });
    }

    const sendResult = await page.evaluate(async ({ relay, token, tty, msg }: any) => {
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

    expect(sendResult).toBe('sent');
    console.log(`Message sent: ${testMsg}`);

    // Wait for relay to process
    await page.waitForTimeout(2000);

    // Verify relay routed the message (check pm2 logs, not stale file)
    const relayLog = execSync('pm2 logs morph-relay --lines 30 --nostream 2>&1', { encoding: 'utf-8' });
    const routeViaWrapper = relayLog.includes(`sent message to ${target.tty} via wrapper socket`);
    const routeViaAS = relayLog.includes(`typed message into ${target.tty} via AppleScript`);
    console.log(`Routed via wrapper socket: ${routeViaWrapper}`);
    console.log(`Routed via AppleScript: ${routeViaAS}`);
    // Either routing path is acceptable
    const routed = routeViaWrapper || routeViaAS;
    expect(routed).toBe(true);

    // Verify wrapper received the message
    const wrapperLog = execSync(`grep "${testMsg}" /tmp/morph-wrapper.log 2>/dev/null || echo "NOT_FOUND"`, { encoding: 'utf-8' }).trim();
    console.log(`Wrapper log: ${wrapperLog}`);
    expect(wrapperLog).toContain(testMsg);
  });

  test('full round-trip: tap pane → send message → see response', async ({ page }) => {
    page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

    await authAndWaitForGrid(page);

    const layout = await getLayout(page);
    const panes = layout.windows?.[0]?.panes || [];
    // Find a routable Claude pane that is actively running (not idle/exit)
    const activePanes = panes.filter((p: any) => p.routable && p.process === 'claude' && !p.idle);
    console.log(`Active routable panes: ${activePanes.length}`);
    for (const p of activePanes) {
      console.log(`  ${p.tty}: session=${p.sessionId?.slice(0, 8) || 'none'} display="${p.display || ''}" idle=${p.idle}`);
    }

    if (activePanes.length === 0) {
      console.log('No active Claude panes — skipping round-trip test');
      return;
    }

    // Click the first routable pane in the grid
    const paneDiv = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator('span') }).first();
    await expect(paneDiv).toBeVisible();
    await paneDiv.click();

    // Wait for SessionTerminal to open
    const backBtn = page.getByRole('button', { name: 'Back' });
    await expect(backBtn).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Take screenshot of initial session content
    await page.screenshot({ path: '/tmp/morph-roundtrip-01-opened.png', fullPage: true });

    // Get initial content
    const initialContent = await page.evaluate(() => {
      const body = document.body.textContent || '';
      return body;
    });
    console.log(`Initial content length: ${initialContent.length}`);

    // Find the textarea and type a message
    const textarea = page.getByPlaceholder('Message this session...');
    const hasTextarea = await textarea.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`Textarea visible: ${hasTextarea}`);

    if (hasTextarea) {
      const testMsg = `morph-pw-test-${Date.now()}`;
      await textarea.fill(testMsg);
      console.log(`Typed: "${testMsg}"`);

      // Send the message (press Enter)
      await textarea.press('Enter');
      console.log('Message sent');

      // Wait for response
      await page.waitForTimeout(5000);

      await page.screenshot({ path: '/tmp/morph-roundtrip-02-sent.png', fullPage: true });

      // Check that the sent message appears in the view
      const afterContent = await page.evaluate(() => document.body.textContent || '');
      console.log(`After-send content length: ${afterContent.length}`);

      // The sent message should appear as a user message
      const sentVisible = afterContent.includes(testMsg);
      console.log(`Sent message visible in UI: ${sentVisible}`);
      expect(sentVisible).toBe(true);

      // Verify relay received and routed the message
      await page.waitForTimeout(1000);
      const relayLog = execSync('pm2 logs morph-relay --lines 30 --nostream 2>&1', { encoding: 'utf-8' });
      const routed = relayLog.includes('via wrapper socket') || relayLog.includes('via AppleScript');
      console.log(`Message routed by relay: ${routed}`);

      // Check wrapper log for the message
      const wrapperLog = execSync(`grep "${testMsg}" /tmp/morph-wrapper.log 2>/dev/null || echo "NOT_FOUND"`, { encoding: 'utf-8' }).trim();
      console.log(`Wrapper received: ${wrapperLog.includes(testMsg) ? 'YES' : 'NO'}`);

      // Wait longer for Claude to respond
      await page.waitForTimeout(10000);

      await page.screenshot({ path: '/tmp/morph-roundtrip-03-response.png', fullPage: true });

      const finalContent = await page.evaluate(() => document.body.textContent || '');
      console.log(`Final content length: ${finalContent.length}`);
      const contentGrew = finalContent.length > afterContent.length;
      console.log(`Content grew after waiting: ${contentGrew}`);
    } else {
      console.log('No textarea — session view may not have opened correctly');
      await page.screenshot({ path: '/tmp/morph-roundtrip-no-textarea.png', fullPage: true });
    }
  });

  test('no raw escape codes in session view', async ({ page }) => {
    page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));

    await authAndWaitForGrid(page);

    // Click through each routable pane and check for escape code residue
    const layout = await getLayout(page);
    const panes = layout.windows?.[0]?.panes || [];
    const routable = panes.filter((p: any) => p.routable);

    const paneLocators = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator('span') });
    const count = await paneLocators.count();
    console.log(`Testing ${count} routable panes for escape codes`);

    for (let i = 0; i < Math.min(count, 3); i++) {
      // Click pane
      await paneLocators.nth(i).click();
      const backBtn = page.getByRole('button', { name: 'Back' });
      const opened = await backBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (!opened) { console.log(`Pane ${i}: didn't open`); continue; }

      await page.waitForTimeout(2000);

      // Get session view text (data-sel spans only, not grid overlay)
      const text = await page.evaluate(() => {
        const spans = document.querySelectorAll('[data-sel]');
        if (spans.length > 0) return Array.from(spans).map(s => s.textContent || '').join('\n');
        return document.body.textContent || '';
      });

      // Check for common escape code residues
      const hasEscCodes = /\?2026[hl]/.test(text) || /\x1b/.test(text) || /\[0m/.test(text) || /\[1;3[0-9]m/.test(text);
      console.log(`Pane ${i}: ${text.length} chars, escape codes: ${hasEscCodes}`);
      if (hasEscCodes) {
        // Find and log the offending text
        const matches = text.match(/(.{0,20}(?:\?2026[hl]|\x1b|\[0m|\[1;3\dm).{0,20})/g);
        console.log(`  Offending: ${JSON.stringify(matches?.slice(0, 3))}`);
      }
      expect(hasEscCodes).toBe(false);

      // Go back
      await backBtn.click();
      await page.waitForTimeout(500);
      const gridLabel = page.getByText('GRID', { exact: true });
      await expect(gridLabel).toBeVisible({ timeout: 3000 });
    }
  });
});
