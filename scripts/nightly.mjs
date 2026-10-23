// Makes the nightly Instagram video: draws the site's 3–8pm (15 h – 20 h) replay frame by frame in a headless
// browser (live recording drops frames on machines without a graphics card), gets the
// voiceover from ElevenLabs, and encodes both with ffmpeg.
//
//   node scripts/nightly.mjs --date 2026-10-20 --out _site/tonight
//
// Env: ELEVENLABS_API_KEY (optional — without it the video is made silent).
// Expects the data branch checked out at ./data (the page is opened with ?data=local).
// Writes into --out: <name>.mp4, caption.txt, script.txt, meta.json.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const VOICE_ID = process.env.VOICE_ID || '93nuHbke4dTER9x2pDwE'; // Adam, warm and friendly (Québec French)
const VOICE_LEAD = 0.4, VOICE_TAIL = 0.8; // seconds of quiet before / after the voice
const FPS = 30, BATCH = 15;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const mtlToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const date = arg('date', mtlToday);
const outDir = resolve(arg('out', 'tonight'));
const siteDir = resolve(new URL('..', import.meta.url).pathname);
const log = (...a) => console.log(`[nightly ${date}]`, ...a);
const duration = (f) => parseFloat(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// --- serve the site locally so the page runs this checkout's code ---
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(siteDir, p);
    if (!file.startsWith(siteDir)) throw new Error('bad path');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// --- open the page ---
log('opening site');
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const name = `leavingmtl-${date}.mp4`;
let info, voicePath = null;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && log('page error:', m.text()));
  await page.goto(`http://127.0.0.1:${port}/?date=${date}&data=local`);
  await page.waitForFunction(() => window.leavingReady === true, null, { timeout: 120_000 });
  info = await page.evaluate(() => {
    const b = buildBulletin();
    return { script: spokenScript(), caption: b.caption, dayName: b.dayName, ways: (b.rows || []).length };
  });
  // Safety check: a night with no traffic readings (feed outage) gets no video.
  if (info.ways < 3) throw new Error(`only ${info.ways} ways out had traffic data for ${date}; not making a video`);
  await writeFile(join(outDir, 'script.txt'), info.script + '\n');
  await writeFile(join(outDir, 'caption.txt'), info.caption + '\n');
  log('script:', info.script);

  // --- voiceover ---
  if (process.env.ELEVENLABS_API_KEY) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: info.script,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
      }),
    });
    if (r.ok) {
      voicePath = join(outDir, 'voice.mp3');
      await writeFile(voicePath, Buffer.from(await r.arrayBuffer()));
      log('voice ok');
    } else {
      log('voice failed, making a silent video:', r.status, (await r.text()).slice(0, 200));
    }
  } else {
    log('no ELEVENLABS_API_KEY, making a silent video');
  }

  // --- draw every frame and encode ---
  log('drawing maps');
  const animMs = await page.evaluate(async () => { window.__vid = await prepareVideo(); return window.__vid.totalMs; });
  const total = Math.max(animMs / 1000, voicePath ? VOICE_LEAD + duration(voicePath) + VOICE_TAIL : 0);
  const speed = animMs / (total * 1000); // < 1 slows the replay to the narrator's pace
  const nFrames = Math.round(total * FPS);

  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-'];
  if (voicePath) args.push('-i', voicePath, '-filter_complex', `[1:a]adelay=${VOICE_LEAD * 1000}:all=1,apad[a]`, '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-t', total.toFixed(2), '-movflags', '+faststart', join(outDir, name));
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))));

  log(`encoding ${nFrames} frames (${total.toFixed(1)}s)`);
  for (let start = 0; start < nFrames; start += BATCH) {
    const jpgs = await page.evaluate(({ start, n, speed, fps }) => {
      const out = [];
      for (let i = start; i < start + n; i++) {
        window.__vid.drawAt((i / fps) * 1000 * speed);
        out.push(window.__vid.canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
      }
      return out;
    }, { start, n: Math.min(BATCH, nFrames - start), speed, fps: FPS });
    for (const j of jpgs) {
      if (!ff.stdin.write(Buffer.from(j, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    }
  }
  ff.stdin.end();
  await ffDone;
  log(`video ${name}: ${duration(join(outDir, name)).toFixed(1)}s`);
} finally {
  await browser.close();
  server.close();
}

await writeFile(join(outDir, 'meta.json'), JSON.stringify({
  date, dayName: info.dayName, video: name, voiced: !!voicePath, made: new Date().toISOString(),
}, null, 2));
log('done');
