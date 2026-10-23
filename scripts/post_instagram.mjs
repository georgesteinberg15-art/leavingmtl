// Posts tonight's video from the site's /tonight/ page to Instagram as a Reel.
//
//   node scripts/post_instagram.mjs --date 2026-10-21 [--dry-run]
//
// Env: IG_TOKEN (Instagram API with Instagram Login), SITE (the GitHub Pages address).
// Exit codes: 0 = posted (or dry run OK, or nothing ready yet), 1 = something went wrong.

const GRAPH = 'https://graph.instagram.com/v21.0';
const SITE = process.env.SITE || 'https://georgesteinberg15-art.github.io/leavingmtl';
const TOKEN = process.env.IG_TOKEN;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const mtlToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const date = arg('date', mtlToday);
const dryRun = process.argv.includes('--dry-run');
const log = (...a) => console.log(`[post ${date}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ig(method, path, params = {}) {
  const url = new URL(GRAPH + path);
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  else opts.body = new URLSearchParams(params);
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`${method} ${path}: ${JSON.stringify(j.error || j)}`);
  return j;
}

if (!TOKEN) throw new Error('IG_TOKEN is not set');

// --- safety checks: only post a finished, voiced video for the right night ---
const meta = await fetch(`${SITE}/tonight/meta.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
if (!meta || meta.date !== date) {
  log(`no video for ${date} on the site yet (site has ${meta?.date ?? 'nothing'}); not posting`);
  process.exit(0);
}
if (!meta.voiced) throw new Error('tonight\'s video has no voiceover (ElevenLabs failed or out of credits); not posting');
const caption = (await fetch(`${SITE}/tonight/caption.txt`, { cache: 'no-store' }).then((r) => r.text())).trim();
if (!caption.includes(meta.dayName)) throw new Error('caption does not match tonight\'s date; not posting');
const videoUrl = `${SITE}/tonight/${meta.video}`;
const head = await fetch(videoUrl, { method: 'HEAD' });
if (!head.ok) throw new Error(`video not reachable: ${head.status}`);

const me = await ig('GET', '/me', { fields: 'user_id,username' });
log(`account @${me.username}, video ${videoUrl} (${(+head.headers.get('content-length') / 1e6).toFixed(1)} MB)`);

// Never post the same night twice (scheduled runs can start late and overlap a manual one).
const recent = await ig('GET', `/${me.user_id}/media`, { fields: 'caption,permalink', limit: '10' });
const dup = (recent.data || []).find((m) => (m.caption || '').includes(meta.dayName));
if (dup) {
  log(`already posted for ${meta.dayName}: ${dup.permalink}`);
  console.log('posted:', dup.permalink); // lets the workflow record it as done
  process.exit(0);
}
log('caption:\n' + caption);

if (dryRun) {
  log('dry run — everything checks out, nothing posted');
  process.exit(0);
}

// --- post: create the Reel, wait for Instagram to process it, publish ---
const container = await ig('POST', `/${me.user_id}/media`, {
  media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true',
});
log('uploaded, Instagram is processing', container.id);
for (let i = 0; ; i++) {
  const s = await ig('GET', `/${container.id}`, { fields: 'status_code,status' });
  if (s.status_code === 'FINISHED') break;
  if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`processing failed: ${s.status}`);
  if (i > 60) throw new Error('Instagram took more than 10 minutes to process the video');
  await sleep(10_000);
}
const published = await ig('POST', `/${me.user_id}/media_publish`, { creation_id: container.id });
const post = await ig('GET', `/${published.id}`, { fields: 'permalink' });
log('posted:', post.permalink);
