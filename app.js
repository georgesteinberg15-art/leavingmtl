// Leaving MTL — la circulation en direct sur les sorties de l'île de Montréal.
// Data: TomTom Traffic Flow, read every 15 minutes in the afternoon/evening by a GitHub Action
// (scripts/poll.mjs) and saved as one file per day on the repo's `data` branch. The browser only
// reads those files, so the TomTom key never reaches the site.

const BRAND = 'Leaving MTL';
const HANDLE = '@leavingmtl';
const REPO = 'georgesteinberg15-art/leavingmtl';
const TZ = 'America/Toronto';
const SLOT_MIN = 15;                 // history resolution (= how often the readings are taken)
const SLOTS = (24 * 60) / SLOT_MIN;
const EVENING = [15 * 60, 20 * 60];  // window the nightly bulletin talks about
const SPARK = [14 * 60, 21 * 60];    // stretch of the day the little bar charts show
const REFRESH_MS = 5 * 60 * 1000;

const PARAMS = new URLSearchParams(location.search);
// ?date=YYYY-MM-DD shows a finished past day (used by the nightly video job, handy for re-runs).
const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/.test(PARAMS.get('date') || '') ? PARAMS.get('date') : null;
// ?data=local reads days/ next to the page (the nightly job checks the data branch out there).
const DATA_BASE = PARAMS.get('data') === 'local' ? 'data/days/' : `https://raw.githubusercontent.com/${REPO}/data/days/`;

// The Instagram buttons are only for the account owner: add ?studio to the address to see them.
// (Just hidden, not secret — anyone could add ?studio, but nothing they make gets posted.)
const STUDIO = PARAMS.has('studio');

const MTL_BOUNDS = [[-74.02, 45.38], [-73.45, 45.72]];
const GROUPS = ['sud', 'nord', 'ouest'];

// Filled from crossings.json: { group, name, say, to, mode, links: [probe ids] }
let CROSSINGS = [];

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function mtlParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// 17 h 30, 18 h
function fmtTime(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}
function fmtDelay(sec) {
  if (sec == null) return '—';
  if (sec >= 45 * 60) return '45+ min';
  const m = Math.round(sec / 60);
  return m <= 0 ? 'fluide' : `+${m} min`;
}
function dayNameOf(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function colorFor(ratio) {
  if (ratio == null) return getVar('--na');
  if (ratio >= 0.75) return getVar('--g');
  if (ratio >= 0.5) return getVar('--y');
  if (ratio >= 0.25) return getVar('--r');
  return getVar('--rr');
}
const varCache = {};
function getVar(name) {
  return varCache[name] ??= getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- state ----------
const state = {
  today: null,
  firstSlot: 0,
  nowSlot: 0,
  slot: 0,
  live: true,
  lastReading: null,    // minutes of the newest reading
  links: new Map(),     // probe id -> { name, coords }
  baseline: new Map(),  // probe id -> { speed, tt } with no traffic (TomTom free-flow)
  history: new Map(),   // probe id -> Array(SLOTS) of { speed, tt, closed } | null
};

// ---------- data loading ----------
async function loadCrossings() {
  const { crossings } = await fetch('crossings.json').then((r) => r.json());
  CROSSINGS = crossings.map((c) => ({ ...c, links: c.probes.map((p) => p.id) }));
}

async function fetchDay(date) {
  const r = await fetch(DATA_BASE + date + '.json', { cache: 'no-cache' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`données ${r.status}`);
  return r.json();
}

function useDay(day) {
  const nameOf = new Map(CROSSINGS.flatMap((c) => c.links.map((id) => [id, c.name])));
  state.links = new Map();
  state.baseline = new Map();
  for (const [id, s] of Object.entries(day.segs)) {
    if (!nameOf.has(id)) continue;
    state.links.set(id, { name: nameOf.get(id), coords: s.coords });
    state.baseline.set(id, { speed: s.ff, tt: s.fftt });
  }
  const hist = new Map();
  let first = SLOTS, last = 0;
  for (const r of day.readings) {
    const min = +r.t.slice(0, 2) * 60 + +r.t.slice(3, 5);
    const slot = Math.floor(min / SLOT_MIN);
    first = Math.min(first, slot);
    last = Math.max(last, slot);
    state.lastReading = min;
    for (const [id, [speed, tt, closed]] of Object.entries(r.v)) {
      if (!hist.has(id)) hist.set(id, new Array(SLOTS).fill(null));
      hist.get(id)[slot] = { speed, tt, closed: !!closed }; // readings are in time order: latest in a slot wins
    }
  }
  // Fill short gaps (a missed reading) by carrying the last one forward up to 30 min.
  for (const arr of hist.values()) {
    let prev = null, age = 0;
    for (let i = first; i <= last; i++) {
      if (arr[i]) { prev = arr[i]; age = 0; }
      else if (prev && ++age <= 2) arr[i] = prev;
    }
  }
  state.history = hist;
  state.firstSlot = first < SLOTS ? first : 0;
  state.nowSlot = last;
}

// ---------- derived numbers ----------
// Under 3 km/h, or TomTom saying so, means a closure rather than traffic.
const CLOSED_KMH = 3;
function linkAt(id, slot) {
  const v = state.history.get(id)?.[slot];
  const b = state.baseline.get(id);
  if (!v || !b) return null;
  if (v.closed || v.speed < CLOSED_KMH) return { ratio: 0, delay: 0, closed: true, speed: v.speed, normal: b.speed };
  return { ratio: Math.min(1, v.speed / b.speed), delay: Math.max(0, v.tt - b.tt), speed: v.speed, normal: b.speed };
}
function crossingAt(c, slot) {
  const parts = c.links.map((id) => linkAt(id, slot)).filter(Boolean);
  if (!parts.length) return null;
  if (parts.every((p) => p.closed)) return { ratio: 0, delay: 0, closed: true };
  const open = parts.filter((p) => !p.closed);
  const ratio = Math.min(...open.map((p) => p.ratio));
  const delays = open.map((p) => p.delay);
  const delay = c.mode === 'avg' ? delays.reduce((a, b) => a + b, 0) / delays.length : delays.reduce((a, b) => a + b, 0);
  // speed shown to people: the slowest stretch of the route right now vs. its usual speed
  const slowest = open.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return { ratio, delay, speed: slowest.speed, normal: slowest.normal };
}
function peakOf(c, fromMin, toMin) {
  let best = null;
  for (let s = Math.floor(fromMin / SLOT_MIN); s <= Math.min(state.nowSlot, Math.floor(toMin / SLOT_MIN)); s++) {
    const v = crossingAt(c, s);
    if (v && !v.closed && (!best || v.delay > best.delay)) best = { ...v, slot: s };
  }
  return best;
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  bounds: MTL_BOUNDS,
  fitBoundsOptions: { padding: { top: 20, bottom: 20, left: innerWidth > 700 ? 380 : 20, right: 20 } },
  attributionControl: { compact: true, customAttribution: 'Circulation © TomTom' },
  preserveDrawingBuffer: true, // lets us snapshot the map for the Instagram card
});

function roadsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [...state.links].map(([id, l]) => {
      const v = linkAt(id, state.slot);
      return {
        type: 'Feature',
        properties: {
          id, name: l.name, color: colorFor(v?.ratio), crossing: true, closed: !!v?.closed,
          ratio: v ? Math.round(v.ratio * 100) : null, delay: v ? Math.round(v.delay / 60) : null,
          kmh: v ? Math.round(v.speed) : null, usual: v ? Math.round(v.normal) : null,
        },
        geometry: { type: 'LineString', coordinates: l.coords },
      };
    }),
  };
}

function addRoadLayers() {
  map.addSource('roads', { type: 'geojson', data: roadsGeoJSON() });
  map.addLayer({ id: 'roads-glow', type: 'line', source: 'roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 16, 'line-opacity': 0.22, 'line-blur': 4 } });
  map.addLayer({ id: 'roads', type: 'line', source: 'roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 9] } });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on('mousemove', 'roads', (e) => {
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = 'pointer';
    const info = p.closed ? 'presque immobile — probablement fermé'
      : p.ratio == null || p.ratio === 'null' ? 'pas de mesure' : `${p.kmh} km/h · normalement ${p.usual} · ${fmtDelay(p.delay * 60)}`;
    popup.setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br>${info}`).addTo(map);
  });
  map.on('mouseleave', 'roads', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
}

// ---------- UI ----------
function renderCrossings() {
  for (const group of GROUPS) {
    const ul = $(group);
    ul.innerHTML = '';
    for (const c of CROSSINGS.filter((x) => x.group === group)) {
      const v = crossingAt(c, state.slot);
      const peak = peakOf(c, EVENING[0], EVENING[1]);
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="dot" style="background:${colorFor(v?.ratio)}"></div>
        <div><div class="name">${c.name}</div><div class="to">${c.to}</div>${v && !v.closed ? `<div class="kmh">${Math.round(v.speed)} km/h ${state.live ? 'maintenant' : 'à ' + fmtTime(state.slot * SLOT_MIN)} · normalement ${Math.round(v.normal)}</div>` : ''}</div>
        <div class="delay">${!v ? '<small>pas de mesure</small>' : v.closed ? 'fermé ?' : fmtDelay(v.delay)}<small>${peak && peak.delay > 60 ? 'pointe ' + fmtDelay(peak.delay) + ' à ' + fmtTime(peak.slot * SLOT_MIN) : ''}</small></div>
        <canvas width="600" height="36"></canvas>`;
      li.onclick = () => flyTo(c);
      ul.appendChild(li);
      drawSpark(li.querySelector('canvas'), c);
    }
  }
}

function drawSpark(canvas, c) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const s0 = SPARK[0] / SLOT_MIN, s1 = SPARK[1] / SLOT_MIN;
  const w = W / (s1 - s0);
  for (let s = s0; s <= Math.min(state.nowSlot, s1 - 1); s++) {
    const v = crossingAt(c, s);
    if (!v) continue;
    const h = Math.max(3, Math.min(1, v.delay / 900) * H); // full height = 15 min delay
    ctx.fillStyle = colorFor(v.ratio);
    ctx.globalAlpha = s === state.slot ? 1 : 0.65;
    ctx.fillRect((s - s0) * w, H - h, Math.max(1, w - 1), h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  if (state.slot >= s0 && state.slot < s1) ctx.fillRect((state.slot - s0) * w, 0, 2, H);
}

function flyTo(c) {
  const pts = c.links.flatMap((id) => state.links.get(id)?.coords ?? []);
  if (!pts.length) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: { top: 80, bottom: 80, left: innerWidth > 700 ? 440 : 40, right: 80 }, maxZoom: 14 });
}

function renderTime() {
  $('slider').min = state.firstSlot;
  $('slider').max = state.nowSlot;
  $('slider').value = state.slot;
  $('live').classList.toggle('on', state.live);
  $('timeLabel').textContent = state.live && state.lastReading != null
    ? `Dernière mesure · ${fmtTime(state.lastReading)}` : fmtTime(state.slot * SLOT_MIN);
}

function render() {
  renderTime();
  renderCrossings();
  map.getSource('roads')?.setData(roadsGeoJSON());
}

// ---------- bulletin ----------
// A quick nod to what else was on in the city (home games, rain, snow). The nightly job sets
// window.CITY_EVENTS from scripts/events.mjs; the live site has none and skips this.
// "Pas étonnant" only when the game's crowd shares one of the three slowest routes around its
// start time; otherwise it just gets a mention.
function eventNod(rows) {
  const { events = [], weather = null } = window.CITY_EVENTS || {};
  if (!rows.length) return null;
  const bad = rows[0].peak.delay >= 180;
  const rain = bad && weather ? { caption: `La ${weather} n'a pas aidé.`, spoken: `Et la ${weather} n'a pas aidé.` } : null;
  const fits = (e, r) => e.near.includes(r.c.name)
    && (e.kind !== 'game' || (r.peak.slot * SLOT_MIN >= e.start - 150 && r.peak.slot * SLOT_MIN <= e.start + 210));
  for (const r of rows.slice(0, 3).filter((r) => r.peak.delay >= 180)) {
    const e = events.find((e) => fits(e, r));
    if (!e) continue;
    if (r === rows[0]) return { onWorst: true, caption: `Pas étonnant : ${lower(e.caption)}.`, spoken: `Pas étonnant, avec ${e.spoken}.`, rain };
    return { onWorst: false, caption: `Pas étonnant pour ${r.c.name} : ${lower(e.caption)}.`, spoken: `Pas étonnant pour ${r.c.say}, avec ${e.spoken}.`, rain };
  }
  if (!events.length) return rain && { onWorst: true, rain };
  // Otherwise mention the game whose nearby routes had the roughest evening.
  const hit = (e) => Math.max(0, ...rows.filter((r) => e.near.includes(r.c.name)).map((r) => r.peak.delay));
  const e = [...events].sort((a, b) => hit(b) - hit(a))[0];
  return bad
    ? { onWorst: true, caption: `Aussi ce soir : ${lower(e.caption)}.`, spoken: `Aussi ce soir : ${e.spoken}.`, rain }
    : { onWorst: true, caption: `Même avec ${lower(e.caption)}.`, spoken: `Même avec ${e.spoken}.`, rain };
}
const lower = (t) => t[0].toLowerCase() + t.slice(1);

function buildBulletin() {
  const evening = state.nowSlot * SLOT_MIN >= EVENING[0];
  const [from, to] = evening ? EVENING : [0, 24 * 60];
  const label = evening ? 'ce soir' : "jusqu'ici";
  const rows = CROSSINGS.map((c) => ({ c, peak: peakOf(c, from, to), now: crossingAt(c, state.nowSlot) }))
    .filter((r) => r.peak);
  rows.sort((a, b) => b.peak.delay - a.peak.delay);
  const dayName = dayNameOf(state.today);

  if (!rows.length) return { html: "<p>Pas encore de mesures aujourd'hui.</p>", lines: [], text: '', dayName, rows };
  const worst = rows[0], best = rows[rows.length - 1];
  const jammedNow = rows.filter((r) => r.now && !r.now.closed && r.now.delay >= 300);

  const lines = [];
  if (worst.peak.delay >= 120) {
    lines.push(`Pire sortie ${label} : <b>${worst.c.name}</b>, ${fmtDelay(worst.peak.delay)} à ${fmtTime(worst.peak.slot * SLOT_MIN)}.`);
  } else {
    lines.push(worst.peak.delay >= 60
      ? `Ça roule bien ${label} : jamais plus ${Math.round(worst.peak.delay / 60) === 1 ? "d'une minute" : `de ${fmtDelay(worst.peak.delay).slice(1)}`} de retard pour quitter l'île.`
      : `Ça roule bien ${label} : aucun retard notable pour quitter l'île.`);
  }
  if (rows.length > 1 && worst.peak.delay >= 120) {
    const runners = rows.slice(1, 3).filter((r) => r.peak.delay >= 120);
    if (runners.length) lines.push('Difficile aussi : ' + runners.map((r) => `${r.c.name} (${fmtDelay(r.peak.delay)} à ${fmtTime(r.peak.slot * SLOT_MIN)})`).join(', ') + '.');
    lines.push(best.peak.delay >= 60
      ? `Le plus fluide : <b>${best.c.name}</b>, jamais plus de ${fmtDelay(best.peak.delay).slice(1)}.`
      : `Le plus fluide : <b>${best.c.name}</b>, aucun retard.`);
  }
  // only while the readings are fresh
  if (!DATE_PARAM && state.live && state.today === mtlParts().date && mtlParts().minutes - state.lastReading <= 40) {
    const t = fmtTime(state.lastReading);
    lines.push(jammedNow.length
      ? `En ce moment (${t}) : encore lent sur ${jammedNow.map((r) => `${r.c.name} ${fmtDelay(r.now.delay)}`).join(', ')}.`
      : `En ce moment (${t}) : toutes les sorties roulent.`);
  }

  const nod = eventNod(rows);
  if (nod?.rain) lines[0] += ' ' + nod.rain.caption;
  if (nod?.caption) lines[nod.onWorst ? 0 : 1] += ' ' + nod.caption;

  // Caption: the news goes first, since the feed only shows ~125 characters before "plus".
  const plain = lines.map((l) => l.replace(/<\/?b>/g, ''));
  const caption = `${plain.join('\n\n')}\n\nEt vous, par où êtes-vous sortis ce soir ?\n\n`
    + `${BRAND} · ${dayName} · carte en direct : lien dans la bio\n#montreal #mtl #traficmtl #circulation #pontchamplain #rivesud #laval`;
  return { html: lines.map((l) => `<p>${l}</p>`).join(''), lines: plain, caption, dayName, rows };
}

// Voiceover text for the nightly video (read by ElevenLabs, in French).
function spokenScript() {
  const b = buildBulletin();
  const weekday = new Date(state.today + 'T12:00:00Z').toLocaleDateString('fr-CA', { weekday: 'long', timeZone: 'UTC' });
  const mins = (sec) => Math.round(sec / 60);
  const when = (slot) => {
    const m = slot * SLOT_MIN, h = Math.floor(m / 60), mm = m % 60;
    return mm === 0 ? `${h} heures` : `${h} heures ${mm}`;
  };
  const rows = b.rows || [];
  const nod = eventNod(rows);
  const out = [`Quitter Montréal, ce ${weekday} soir.`];
  if (!rows.length || mins(rows[0].peak.delay) < 3) {
    const n = Math.max(1, mins(rows[0]?.peak.delay || 0));
    out.push(`Une soirée tranquille : jamais plus ${n === 1 ? "d'une minute" : `de ${n} minutes`} de retard pour quitter l'île.`);
    if (nod?.spoken) out.push(nod.spoken);
  } else {
    const [w, ...rest] = rows;
    out.push(`La pire sortie : ${w.c.say}, avec ${mins(w.peak.delay)} minutes de plus vers ${when(w.peak.slot)}.`);
    if (nod?.rain) out.push(nod.rain.spoken);
    if (nod?.onWorst && nod.spoken) out.push(nod.spoken);
    const rough = rest.filter((r) => mins(r.peak.delay) >= 3).slice(0, 2);
    if (rough.length === 2) {
      out.push(`${cap(rough[0].c.say)} a atteint ${mins(rough[0].peak.delay)} minutes vers ${when(rough[0].peak.slot)}, et ${rough[1].c.say}, ${mins(rough[1].peak.delay)}.`);
    } else if (rough.length === 1) {
      out.push(`${cap(rough[0].c.say)} a atteint ${mins(rough[0].peak.delay)} minutes vers ${when(rough[0].peak.slot)}.`);
    }
    if (nod && !nod.onWorst) out.push(nod.spoken);
    const best = rows[rows.length - 1];
    if (best !== w) out.push(`Le plus fluide ? ${cap(best.c.say)}.`);
  }
  out.push('Bonne route.');
  return out.join(' ');
}
const cap = (t) => t[0].toUpperCase() + t.slice(1);

// ---------- Instagram card + video (1080 x 1350) ----------
const POST_W = 1080, POST_H = 1350, MAP_H = 760;
const VIDEO_FPS = 30;
const VIDEO_SLOT_MS = 600;  // screen time per 15 minutes of traffic
const VIDEO_END_HOLD_MS = 2500;

// Colour the map for one time slot and grab a copy of it once it has drawn.
async function snapMap(slot) {
  state.slot = slot;
  const drawn = new Promise((res) => { map.once('idle', res); setTimeout(res, 4000); });
  map.getSource('roads').setData(roadsGeoJSON());
  map.triggerRepaint();
  await drawn;
  return createImageBitmap(map.getCanvas());
}

// Frame the whole city for the snapshot; returns a function that puts the camera back.
function frameCity() {
  const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  map.fitBounds(MTL_BOUNDS, { padding: 20, animate: false });
  return () => map.jumpTo(cam);
}

function drawMapLayer(ctx, img, alpha = 1) {
  const scale = Math.max(POST_W / img.width, MAP_H / img.height);
  const sw = POST_W / scale, sh = MAP_H / scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, POST_W, MAP_H);
  ctx.globalAlpha = 1;
}

// One full card. `rows` = [{ name, color, delay (sec), note, bar (0–1, optional) }]
function drawCard(ctx, { maps, subtitle, heading, rows, clock, progress }) {
  const W = POST_W, H = POST_H;
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, W, H);
  for (const [img, alpha] of maps) drawMapLayer(ctx, img, alpha);

  const bottom = ctx.createLinearGradient(0, MAP_H - 200, 0, MAP_H);
  bottom.addColorStop(0, 'rgba(11,13,16,0)');
  bottom.addColorStop(1, 'rgba(11,13,16,1)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, MAP_H - 200, W, 200);
  const top = ctx.createLinearGradient(0, 0, 0, 260);
  top.addColorStop(0, 'rgba(11,13,16,0.92)');
  top.addColorStop(1, 'rgba(11,13,16,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 260);

  // title block over the map
  ctx.fillStyle = '#f2f2ee';
  ctx.font = '800 76px Inter, sans-serif';
  ctx.fillText('LEAVING', 56, 120);
  ctx.fillStyle = getVar('--accent');
  ctx.fillText('MTL', 56 + ctx.measureText('LEAVING ').width, 120);
  ctx.fillStyle = '#c9ccd1';
  ctx.font = '600 32px Inter, sans-serif';
  ctx.fillText(subtitle, 58, 168);

  if (clock) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f2f2ee';
    ctx.font = '800 64px Inter, sans-serif';
    ctx.fillText(clock, W - 56, 120);
    ctx.textAlign = 'left';
  }
  if (progress != null) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    roundRect(ctx, 56, MAP_H - 30, W - 112, 6, 3);
    ctx.fillStyle = getVar('--accent');
    roundRect(ctx, 56, MAP_H - 30, Math.max(6, (W - 112) * progress), 6, 3);
  }

  let y = MAP_H + 30;
  ctx.font = '600 22px Inter, sans-serif';
  ctx.fillStyle = '#8b9098';
  ctx.fillText(heading, 56, y);
  y += 22;
  for (const r of rows) {
    y += 58;
    ctx.fillStyle = r.color;
    roundRect(ctx, 56, y - 36, 10, 44, 5);
    if (r.bar != null) {
      ctx.globalAlpha = 0.18;
      roundRect(ctx, 76, y - 38, Math.max(0, (W - 132) * Math.min(1, r.bar)), 48, 6);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#f2f2ee';
    ctx.font = '700 38px Inter, sans-serif';
    ctx.fillText(r.name, 86, y);
    ctx.textAlign = 'right';
    ctx.font = '800 38px Inter, sans-serif';
    ctx.fillText(r.text ?? fmtDelay(r.delay), W - 56, y);
    if (r.note) {
      ctx.fillStyle = '#8b9098';
      ctx.font = '500 26px Inter, sans-serif';
      ctx.fillText(r.note, W - 260, y);
    }
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#8b9098';
  ctx.font = '500 24px Inter, sans-serif';
  ctx.fillText(`${HANDLE} · circulation © TomTom`, 56, H - 44);
}

function showPost({ imgSrc, videoSrc, filename, caption }) {
  $('postImg').hidden = !imgSrc;
  $('postVideo').hidden = !videoSrc;
  if (imgSrc) $('postImg').src = imgSrc;
  if (videoSrc) { $('postVideo').src = videoSrc; $('postVideo').play().catch(() => {}); }
  $('postDownload').href = imgSrc || videoSrc;
  $('postDownload').download = filename;
  $('postDownload').textContent = videoSrc ? 'Télécharger la vidéo' : "Télécharger l'image";
  $('copyCaption').onclick = async () => {
    await navigator.clipboard.writeText(caption);
    $('copyCaption').textContent = 'Copié ✓';
  };
  $('copyCaption').textContent = 'Copier la légende';
  $('postModal').hidden = false;
}

async function makePost() {
  await document.fonts.ready;
  const b = buildBulletin();
  const wasSlot = state.slot;
  // the still shows the evening peak of the worst crossing
  const slot = b.rows?.[0] ? b.rows[0].peak.slot : state.nowSlot;
  const restore = frameCity();
  const img = await snapMap(slot);
  restore();
  state.slot = wasSlot;
  render();

  const cv = Object.assign(document.createElement('canvas'), { width: POST_W, height: POST_H });
  drawCard(cv.getContext('2d'), {
    maps: [[img, 1]],
    subtitle: `${b.dayName} · carte à ${fmtTime(slot * SLOT_MIN)}`,
    heading: 'PIRE RETARD POUR SORTIR',
    rows: (b.rows || []).slice(0, 6).map((r) => ({
      name: r.c.name, color: colorFor(r.peak.ratio), delay: r.peak.delay, note: fmtTime(r.peak.slot * SLOT_MIN),
    })),
  });
  showPost({ imgSrc: cv.toDataURL('image/png'), filename: `leaving-mtl-${state.today}.png`, caption: b.caption });
}

// Sets up the evening-rush animation (15 h – 20 h, or as much of it as has happened).
// Returns { canvas, totalMs, drawAt(ms), close() }: drawAt paints the frame for that moment.
// The site records it live (makeVideo); the nightly job steps through it frame by frame.
async function prepareVideo(onProgress = () => {}) {
  await document.fonts.ready;
  let from = Math.floor(EVENING[0] / SLOT_MIN);
  const to = Math.min(state.nowSlot, Math.floor(EVENING[1] / SLOT_MIN));
  if (to - from < 6) from = to - 20; // before rush hour: show the last 5 hours instead
  from = Math.max(from, state.firstSlot);
  const slots = [];
  for (let s = from; s <= to; s++) slots.push(s);

  // Ways out that had any data in the window, ranked by their worst moment.
  const ranked = CROSSINGS.map((c) => ({ c, peak: peakOf(c, from * SLOT_MIN, to * SLOT_MIN) }))
    .filter((r) => r.peak).sort((a, b) => b.peak.delay - a.peak.delay).slice(0, 6);
  const scaleMax = Math.max(600, ...ranked.map((r) => r.peak.delay));

  // 1. Draw the map once per 15-minute slot.
  const wasSlot = state.slot;
  const restore = frameCity();
  const frames = [];
  for (const [i, s] of slots.entries()) {
    onProgress(`Carte ${i + 1}/${slots.length}…`);
    frames.push(await snapMap(s));
  }
  restore();
  state.slot = wasSlot;
  render();

  const cv = Object.assign(document.createElement('canvas'), { width: POST_W, height: POST_H });
  const ctx = cv.getContext('2d');
  const dayName = buildBulletin().dayName;
  const valueAt = (c, s) => crossingAt(c, s);
  const drawSlots = (t) => {
    // t = position in slots (fractional), 0 … slots.length - 1
    const i = Math.min(slots.length - 1, Math.floor(t));
    const f = i < slots.length - 1 ? t - i : 0;
    const fade = Math.max(0, (f - 0.5) / 0.5); // hold each map, then cross-fade into the next
    const maps = [[frames[i], 1]];
    if (fade > 0) maps.push([frames[i + 1], fade]);
    const minutes = Math.round((slots[0] + t) * SLOT_MIN);
    drawCard(ctx, {
      maps,
      subtitle: dayName,
      clock: fmtTime(Math.floor(minutes / SLOT_MIN) * SLOT_MIN),
      progress: slots.length > 1 ? t / (slots.length - 1) : 1,
      heading: 'RETARD POUR SORTIR',
      rows: ranked.map(({ c }) => {
        const a = valueAt(c, slots[i]);
        const b = f ? valueAt(c, slots[i + 1]) : a;
        const closed = (a ?? b)?.closed;
        const d0 = a && !a.closed ? a.delay : null, d1 = b && !b.closed ? b.delay : null;
        const delay = d0 != null && d1 != null ? d0 + (d1 - d0) * f : d0 ?? d1;
        const now = fade > 0.5 ? b : a;
        return {
          name: c.name, color: colorFor(now?.ratio), delay, bar: delay != null ? delay / scaleMax : 0,
          text: closed ? 'fermé ?' : delay == null ? '—' : undefined,
        };
      }),
    });
  };
  const totalMs = (slots.length - 1) * VIDEO_SLOT_MS + VIDEO_END_HOLD_MS;
  return {
    canvas: cv,
    totalMs,
    drawAt: (ms) => drawSlots(Math.min(slots.length - 1, ms / VIDEO_SLOT_MS)),
    close: () => frames.forEach((f) => f.close()),
  };
}

// Records the animation live in the browser (the "Make Instagram video" button).
async function makeVideo(onProgress = () => {}) {
  const vid = await prepareVideo(onProgress);
  const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('ce navigateur ne peut pas enregistrer de vidéo');
  const rec = new MediaRecorder(vid.canvas.captureStream(VIDEO_FPS), { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  vid.drawAt(0);
  rec.start();
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      const el = performance.now() - t0;
      vid.drawAt(el);
      onProgress(`Enregistrement ${Math.min(100, Math.round((el / vid.totalMs) * 100))}%…`);
      if (el >= vid.totalMs) return res();
      setTimeout(tick, 1000 / VIDEO_FPS); // not rAF: keeps going if the tab is in the background
    };
    tick();
  });
  rec.stop();
  await stopped;
  vid.close();

  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  showPost({
    videoSrc: URL.createObjectURL(blob),
    filename: `leaving-mtl-${state.today}.${ext}`,
    caption: buildBulletin().caption,
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

// ---------- wiring ----------
$('slider').oninput = (e) => { state.slot = +e.target.value; state.live = state.slot === state.nowSlot; render(); };
$('live').onclick = () => { state.live = true; state.slot = state.nowSlot; render(); };
let playing = null;
$('play').onclick = () => {
  if (playing) { clearInterval(playing); playing = null; $('play').textContent = '▶'; return; }
  state.live = false;
  state.slot = state.firstSlot;
  $('play').textContent = '❚❚';
  playing = setInterval(() => {
    state.slot++;
    if (state.slot >= state.nowSlot) { clearInterval(playing); playing = null; $('play').textContent = '▶'; state.live = true; state.slot = state.nowSlot; }
    render();
  }, 250);
};
if (STUDIO) $('makePost').onclick = () => makePost().catch((e) => alert("Impossible de faire l'image : " + e.message));
if (STUDIO) $('makeVideo').onclick = async () => {
  const btn = $('makeVideo');
  btn.disabled = true;
  try { await makeVideo((msg) => { btn.textContent = msg; }); }
  catch (e) { alert('Impossible de faire la vidéo : ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Faire la vidéo Instagram'; }
};
$('closeModal').onclick = () => { $('postModal').hidden = true; $('postVideo').pause(); };

// Loads today's readings; before the first one of the day (~2:30pm), shows yesterday evening.
async function refresh() {
  let date = DATE_PARAM || mtlParts().date;
  let day = await fetchDay(date);
  if (!day && !DATE_PARAM) { date = shiftDate(date, -1); day = await fetchDay(date); }
  if (!day) throw new Error(`aucune mesure pour le ${date}`);
  const wasLatest = state.live;
  state.today = date;
  useDay(day);
  if (wasLatest) state.slot = state.nowSlot;
  const b = buildBulletin();
  $('bulletin').innerHTML = b.html;
  const isToday = DATE_PARAM || date === mtlParts().date;
  $('dateline').textContent = `${isToday ? '' : 'Hier · '}${b.dayName} · ${state.links.size} tronçons`;
  render();
}

(async function init() {
  if (!STUDIO) { $('makeVideo').remove(); $('makePost').remove(); }
  try {
    const mapReady = new Promise((res) => map.on('load', res));
    await loadCrossings();
    await refresh();
    await mapReady;
    addRoadLayers();
    if (!DATE_PARAM) setInterval(() => refresh().catch(console.error), REFRESH_MS);
    window.leavingReady = true; // signal for the nightly video job
  } catch (e) {
    console.error(e);
    $('dateline').textContent = 'Impossible de charger la circulation : ' + e.message;
  }
})();
