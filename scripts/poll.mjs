// Takes one reading of every way off the island from TomTom's Traffic Flow API and adds it to
// today's file (days/YYYY-MM-DD.json on the repo's `data` branch). The site and the nightly
// video read those files; the browser never sees the TomTom key.
//
//   TOMTOM_KEY=... node scripts/poll.mjs --data <data-branch checkout>
//   TOMTOM_KEY=... node scripts/poll.mjs --check     (print what each probe hits; writes nothing)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const TZ = 'America/Toronto';
const KEEP_DAYS = 14;
const KEY = process.env.TOMTOM_KEY;
if (!KEY) throw new Error('TOMTOM_KEY is not set');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const CHECK = process.argv.includes('--check');
const dataDir = resolve(arg('data', 'data'));
const siteDir = resolve(new URL('..', import.meta.url).pathname);
const { crossings } = JSON.parse(await readFile(join(siteDir, 'crossings.json'), 'utf8'));

const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date()).map((x) => [x.type, x.value]));
const date = `${p.year}-${p.month}-${p.day}`;
const time = `${p.hour}:${p.minute}`;

async function flow(lat, lon) {
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}&unit=KMPH&key=${KEY}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`TomTom ${r.status} ${(await r.text()).slice(0, 120)}`);
      return (await r.json()).flowSegmentData;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

const km = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const probes = crossings.flatMap((c) => c.probes.map((pr) => ({ ...pr, crossing: c })));
const results = {};
for (const pr of probes) {
  try {
    const f = await flow(pr.lat, pr.lon);
    const coords = f.coordinates.coordinate.map((q) => [+q.longitude.toFixed(5), +q.latitude.toFixed(5)]);
    results[pr.id] = { f, coords };
    if (CHECK) {
      const len = coords.slice(1).reduce((s, q, i) => s + km(coords[i], q), 0);
      const a = coords[0], b = coords[coords.length - 1];
      console.log(`${pr.id.padEnd(16)} ${f.frc} ${len.toFixed(2)} km  from ${a[1]},${a[0]} to ${b[1]},${b[0]}  ` +
        `now ${f.currentSpeed} km/h (${f.currentTravelTime}s), free ${f.freeFlowSpeed} (${f.freeFlowTravelTime}s), ` +
        `conf ${f.confidence}${f.roadClosure ? ' CLOSED' : ''}`);
    }
  } catch (e) {
    console.error(`${pr.id}: ${e.message}`);
  }
}
if (CHECK) process.exit(0);

const ok = Object.keys(results).length;
console.log(`${date} ${time}: ${ok}/${probes.length} probes read`);
if (!ok) process.exit(1);

// --- add to today's file ---
const dayDir = join(dataDir, 'days');
await mkdir(dayDir, { recursive: true });
const file = join(dayDir, `${date}.json`);
let day;
try { day = JSON.parse(await readFile(file, 'utf8')); } catch { day = { date, segs: {}, readings: [] }; }

const v = {};
for (const [id, { f, coords }] of Object.entries(results)) {
  // shape and free-flow numbers: keep the latest (they rarely change)
  day.segs[id] = { coords, ff: f.freeFlowSpeed, fftt: f.freeFlowTravelTime, frc: f.frc };
  v[id] = [f.currentSpeed, f.currentTravelTime, f.roadClosure ? 1 : 0, +f.confidence.toFixed(2)];
}
day.readings = day.readings.filter((r) => r.t !== time);
day.readings.push({ t: time, v });
day.readings.sort((a, b) => a.t.localeCompare(b.t));
await writeFile(file, JSON.stringify(day));

// --- drop old days ---
const cutoff = new Date(Date.parse(date + 'T12:00:00Z') - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
for (const f of await readdir(dayDir)) {
  if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) await unlink(join(dayDir, f));
}
