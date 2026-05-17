#!/usr/bin/env node
/**
 * Cloudflare cache purge — post-build deploy step.
 *
 * Latch 2 of the 3 cold-start safety latches (2026-05-18). HTML page rule
 * caches `morph.mkyang.ai/` for 7200s at CF edge (free-plan minimum). This
 * script purges that one URL after every build so visitors get the new
 * index.html immediately instead of waiting up to 2 hours for natural expiry.
 *
 * Fail-loud: any failure exits non-zero so `npm run build` fails and the
 * deploy is not silently stale.
 *
 * Skip-on-CI flag: set MORPH_SKIP_CF_PURGE=1 to bypass (useful for offline
 * dev rebuilds that aren't being deployed).
 */
import https from 'node:https';
import process from 'node:process';

const ZONE = 'e576503d5db78b4aaf0c9e852bd3f9f7';  // mkyang.ai zone
const FILES = [
  'https://morph.mkyang.ai/',
  'https://morph.mkyang.ai/index.html',
  'https://morph.mkyang.ai/manifest.json',
  'https://morph.mkyang.ai/sw.js',
];

if (process.env.MORPH_SKIP_CF_PURGE === '1') {
  console.log('[cf-purge] skipped via MORPH_SKIP_CF_PURGE=1');
  process.exit(0);
}

const email = process.env.CLOUDFLARE_EMAIL;
const key = process.env.CLOUDFLARE_API_TOKEN;
if (!email || !key) {
  console.error('[cf-purge] FATAL: CLOUDFLARE_EMAIL or CLOUDFLARE_API_TOKEN missing from env. Source ~/.zshrc before deploy.');
  process.exit(1);
}

// Strip proxy env so we hit api.cloudflare.com directly. The HK mihomo +
// LibreSSL combo trips SSL EOF when proxying CF API calls (see nerve memory
// feedback_xops_per_text_approval / morph_secrets). Direct works.
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];

const body = JSON.stringify({ files: FILES });

const req = https.request({
  hostname: 'api.cloudflare.com',
  path: `/client/v4/zones/${ZONE}/purge_cache`,
  method: 'POST',
  headers: {
    'x-auth-email': email,
    'x-auth-key': key,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
  timeout: 15000,
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    let j;
    try { j = JSON.parse(data); }
    catch (e) {
      console.error(`[cf-purge] FAIL — non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`);
      process.exit(1);
    }
    if (res.statusCode === 200 && j.success) {
      console.log(`[cf-purge] OK — purged ${FILES.length} URLs at zone ${ZONE.slice(0, 8)}… id=${j.result?.id?.slice(0, 12) || 'n/a'}`);
      process.exit(0);
    }
    console.error(`[cf-purge] FAIL — http=${res.statusCode} errors=${JSON.stringify(j.errors || j)}`);
    process.exit(1);
  });
});

req.on('error', (e) => {
  console.error(`[cf-purge] FAIL — network: ${e.message}`);
  process.exit(1);
});
req.on('timeout', () => {
  req.destroy();
  console.error('[cf-purge] FAIL — timeout after 15s');
  process.exit(1);
});

req.write(body);
req.end();
