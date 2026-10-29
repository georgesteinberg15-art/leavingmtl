// What else was going on in the city that evening, for a quick nod in the bulletin:
// home games at Montreal venues (ESPN's public scoreboard) and rain or snow (Open-Meteo).
// Both free, no keys. Every lookup is best-effort: if a source is down the bulletin just goes
// without it. (No free source for Montreal parades/festivals yet.)
//
//   import { eventsFor } from './events.mjs';  await eventsFor('2026-10-20')
//
// Returns { events: [{ kind, caption, spoken, start (minutes after midnight Montreal), near: [crossing names] }],
//           weather: null | 'pluie' | 'neige' }

const TZ = 'America/Toronto';
const DOWNTOWN = ['Pont Champlain', 'Pont Jacques-Cartier', 'Pont Victoria', 'Pont Médéric-Martin'];

// Venue (as ESPN names it) → how to say it, and which ways out its crowds share.
const VENUES = {
  'Bell Centre': { at: 'au Centre Bell', near: DOWNTOWN },
  'Stade Saputo': { at: 'au stade Saputo', near: ['Tunnel La Fontaine', 'Pont Jacques-Cartier', 'Pont Pie-IX', 'Pont Papineau-Leblanc'] },
};
// ESPN team names → French. Home teams only need Montreal's own; visitors keep ESPN's city name.
const TEAM = { Canadiens: 'les Canadiens', 'CF Montréal': 'le CF Montréal' };
const LEAGUES = ['hockey/nhl', 'soccer/usa.1'];
// Games starting in this window put crowds on the roads during the 3–8pm replay.
const GAME_FROM = 13 * 60, GAME_TO = 21 * 60 + 30;

const mtlMinutes = (iso) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(iso));
  return +p.find((x) => x.type === 'hour').value * 60 + +p.find((x) => x.type === 'minute').value;
};
const mtlDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const clock = (m) => {
  const h = Math.floor(m / 60), mm = m % 60;
  return { written: mm ? `${h} h ${String(mm).padStart(2, '0')}` : `${h} h`, spoken: mm ? `${h} heures ${mm}` : `${h} heures` };
};

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function games(date) {
  const out = [];
  for (const league of LEAGUES) {
    const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${date.replaceAll('-', '')}`);
    for (const e of d?.events ?? []) {
      const c = e.competitions?.[0];
      const venue = VENUES[c?.venue?.fullName];
      if (!venue || mtlDate(e.date) !== date) continue;
      const start = mtlMinutes(e.date);
      if (start < GAME_FROM || start > GAME_TO) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home')?.team;
      const away = c.competitors.find((t) => t.homeAway === 'away')?.team;
      if (!home || !away) continue;
      const homeName = TEAM[home.shortDisplayName] || home.shortDisplayName;
      const awayName = league.startsWith('soccer') ? away.shortDisplayName : away.location; // 'Nashville', 'San Jose'
      const t = clock(start);
      out.push({
        kind: 'game', start, near: venue.near,
        caption: `${cap(homeName)} contre ${awayName} ${venue.at}, ${t.written}`,
        spoken: `${homeName} contre ${awayName} ${venue.at}`,
      });
    }
  }
  return out;
}
const cap = (t) => t[0].toUpperCase() + t.slice(1);

async function weather(date) {
  const d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=45.50&longitude=-73.57&hourly=precipitation,snowfall&timezone=${TZ}&start_date=${date}&end_date=${date}`);
  if (!d?.hourly) return null;
  let rain = 0, snow = 0;
  d.hourly.time.forEach((t, i) => {
    const h = +t.slice(11, 13);
    if (h >= 15 && h < 20) { rain += d.hourly.precipitation[i] || 0; snow += d.hourly.snowfall[i] || 0; }
  });
  return snow >= 0.5 ? 'neige' : rain >= 2 ? 'pluie' : null;
}

export async function eventsFor(date) {
  const [g, w] = await Promise.all([games(date), weather(date)]);
  return { events: g.sort((a, b) => a.start - b.start), weather: w };
}

// node scripts/events.mjs 2026-10-20
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await eventsFor(process.argv[2]), null, 2));
}
