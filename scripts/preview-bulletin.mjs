// Prints the caption and voiceover a given night would get, without making the video.
//   node scripts/preview-bulletin.mjs 2026-10-26 [2026-10-25 ...]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { eventsFor } from './events.mjs';

const siteDir = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(siteDir, p));
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  ...(process.env.CHROME ? { channel: 'chrome' } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  for (const date of process.argv.slice(2)) {
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log('page error:', m.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}/?date=${date}`);
    await page.waitForFunction(() => window.leavingReady === true, null, { timeout: 120_000 });
    await page.evaluate((c) => { window.CITY_EVENTS = c; }, await eventsFor(date));
    const out = await page.evaluate(() => ({ caption: buildBulletin().caption, script: spokenScript() }));
    console.log(`\n===== ${date}\n--- caption\n${out.caption}\n--- voiceover\n${out.script}`);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
