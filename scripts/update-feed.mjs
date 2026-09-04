import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const EVENT_URL = process.env.OTTO_PUBLIC_URL || 'https://events.ottoevent.ai/event/fea42fc5d/divisions/27635/pool-bracket?pbTabId=cb0e590a-d91a-4d67-8c37-a137c20c9ca0&pbId=78dc27fa-9b59-425b-a5d1-bcd740a7414e';
const TEAM = process.env.TEAM_NAME || 'Lady Mavericks Fr';
const EVENT = process.env.EVENT_NAME || '2026 Tri-County High School Championships';
const TZ = 'America/New_York';

const seeded = [
  { id:'seed-1', status:'scheduled', opponent:'Carrollton School JV Team', time:'Fri 3:00 PM', court:'Fuchs Ct. 5', teamSets:null, opponentSets:null, setScores:[] },
  { id:'seed-2', status:'scheduled', opponent:"Goleman Girls\' JV", time:'Fri 5:00 PM', court:'Fuchs Ct. 5', teamSets:null, opponentSets:null, setScores:[] },
  { id:'seed-3', status:'scheduled', opponent:'Riviera Prep JV', time:'Fri 8:00 PM', court:'Fuchs Ct. 5', teamSets:null, opponentSets:null, setScores:[] }
];

const teamNorm = normalize(TEAM);
const candidates = [];
let bodyText = '';
let sourceNote = '';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/(json|javascript|text|graphql)/.test(ct)) return;
      const text = await resp.text();
      if (!text || text.length > 5_000_000) return;
      if (normalize(text).includes(teamNorm)) {
        candidates.push({ url: resp.url(), contentType: ct, text });
      }
    } catch {}
  });

  await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
  bodyText = await page.locator('body').innerText().catch(() => '');
} finally {
  await browser.close();
}

let matches = [];
let dataSource = 'seed';
let matchedUrl = '';
for (const c of candidates) {
  const parsed = parseCandidate(c.text);
  if (parsed.length > matches.length) {
    matches = parsed;
    dataSource = 'network';
    matchedUrl = c.url;
  }
}

if (!matches.length && bodyText) {
  const parsed = parseVisibleText(bodyText);
  if (parsed.length) {
    matches = parsed;
    dataSource = 'rendered-page';
  }
}

if (!matches.length) {
  matches = seeded;
  sourceNote = 'No live OTTO match payload was detected; using the seeded schedule.';
} else {
  sourceNote = `Parsed ${matches.length} Lady Mavericks match(es) from ${dataSource}.`;
}

matches = dedupe(matches).slice(0, 12);
const now = new Date();
const feed = makeRss(matches, now);
const status = {
  ok: true,
  event: EVENT,
  team: TEAM,
  eventUrl: EVENT_URL,
  source: dataSource,
  matchedUrl: matchedUrl || null,
  note: sourceNote,
  generatedAt: now.toISOString(),
  matches
};

await fs.writeFile('feed.xml', feed, 'utf8');
await fs.writeFile('status.json', JSON.stringify(status, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(status, null, 2));

function parseCandidate(text) {
  const out = [];
  const parsedObjects = [];
  try { parsedObjects.push(JSON.parse(text)); } catch {}
  const brace = text.match(/^[\s\S]*?({[\s\S]*})[\s\S]*$/);
  if (!parsedObjects.length && brace) {
    try { parsedObjects.push(JSON.parse(brace[1])); } catch {}
  }
  for (const data of parsedObjects) out.push(...normalizeJson(data));
  return dedupe(out);
}

function normalizeJson(data) {
  const out = [];
  walk(data, obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    let s='';
    try { s = JSON.stringify(obj); } catch { return; }
    if (!normalize(s).includes(teamNorm)) return;

    const home = asName(first(obj, ['homeTeamName','team1Name','teamAName','homeName','team1','teamA','homeTeam','teamOne','teamOneName']));
    const away = asName(first(obj, ['awayTeamName','team2Name','teamBName','awayName','team2','teamB','awayTeam','teamTwo','teamTwoName']));
    const winner = asName(first(obj, ['winnerName','winningTeamName','winnerTeamName','winner']));
    const loser = asName(first(obj, ['loserName','losingTeamName','loserTeamName','loser']));

    let a = home, b = away;
    if ((!a || !b) && winner && loser) { a = winner; b = loser; }
    if (!a || !b) return;
    const aIsTeam = same(a, TEAM), bIsTeam = same(b, TEAM);
    if (!aIsTeam && !bIsTeam) return;

    const aScore = numberish(first(obj, ['homeSets','team1Sets','teamASets','wins1','score1','homeScore','teamOneScore','teamOneSets','homeTeamScore']));
    const bScore = numberish(first(obj, ['awaySets','team2Sets','teamBSets','wins2','score2','awayScore','teamTwoScore','teamTwoSets','awayTeamScore']));
    const rawStatus = String(first(obj, ['status','matchStatus','state','resultStatus','statusName']) || '').toLowerCase();
    const final = /final|complete|completed|finished/.test(rawStatus) || (Number.isFinite(aScore) && Number.isFinite(bScore) && Math.max(aScore,bScore) >= 2);
    const live = /live|progress|playing|in progress/.test(rawStatus);
    const teamIsA = aIsTeam;

    out.push({
      id: String(first(obj, ['id','matchId','gameId','uuid','matchNumber']) || `${a}-${b}-${out.length}`),
      status: final ? 'final' : live ? 'live' : 'scheduled',
      opponent: teamIsA ? b : a,
      time: humanTime(first(obj, ['startTime','matchTime','scheduledTime','time','dateTime','startDateTime','scheduledAt','matchDate'])),
      court: cleanCourt(first(obj, ['courtName','court','locationName','location','courtLabel','venueCourt'])),
      teamSets: teamIsA ? aScore : bScore,
      opponentSets: teamIsA ? bScore : aScore,
      setScores: extractSets(obj, teamIsA)
    });
  });
  return dedupe(out);
}

function parseVisibleText(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const out = [];
  const knownOpponents = ['Carrollton School JV Team', "Goleman Girls' JV", 'Riviera Prep JV'];
  for (const opponent of knownOpponents) {
    const idxs = lines.map((x,i)=>same(x,opponent)?i:-1).filter(i=>i>=0);
    for (const i of idxs) {
      const window = lines.slice(Math.max(0,i-5), Math.min(lines.length,i+8));
      if (!window.some(x => normalize(x).includes(teamNorm))) continue;
      const joined = window.join(' | ');
      const scorePair = joined.match(/(?:^|\D)([0-3])\s*[-–:]\s*([0-3])(?:\D|$)/);
      const time = window.find(x => /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(x)) || '';
      const court = window.find(x => /\b(?:ct\.?|court)\s*\d+\b/i.test(x)) || '';
      const finalish = /final|complete|completed/i.test(joined) || (scorePair && Math.max(Number(scorePair[1]), Number(scorePair[2])) >= 2);
      out.push({
        id: `text-${normalize(opponent)}-${i}`,
        status: finalish ? 'final' : 'scheduled',
        opponent,
        time,
        court,
        teamSets: scorePair ? Number(scorePair[1]) : null,
        opponentSets: scorePair ? Number(scorePair[2]) : null,
        setScores: []
      });
    }
  }
  return dedupe(out);
}

function extractSets(obj, teamIsA) {
  const arr = first(obj, ['sets','setScores','games','gameScores','setResults']);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => {
    const a = numberish(first(s, ['homeScore','team1Score','a','score1','points1','teamOneScore']));
    const b = numberish(first(s, ['awayScore','team2Score','b','score2','points2','teamTwoScore']));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return teamIsA ? `${a}-${b}` : `${b}-${a}`;
  }).filter(Boolean);
}

function makeRss(matches, now) {
  const items = [...matches]
    .sort((a,b) => rank(a.status)-rank(b.status))
    .map((m, i) => {
      let title;
      if (m.status === 'final') title = `FINAL: ${TEAM} ${fmtScore(m.teamSets)}-${fmtScore(m.opponentSets)} ${m.opponent}`;
      else if (m.status === 'live') title = `LIVE: ${TEAM} ${fmtScore(m.teamSets)}-${fmtScore(m.opponentSets)} ${m.opponent}`;
      else title = `NEXT: ${TEAM} vs ${m.opponent}`;
      const desc = [m.time, m.court, m.setScores?.length ? `Sets: ${m.setScores.join(', ')}` : ''].filter(Boolean).join(' • ');
      return `<item><title>${xml(title)}</title><description>${xml(desc)}</description><guid isPermaLink="false">${xml(m.id || `${i}-${title}`)}</guid><link>${xml(EVENT_URL)}</link><pubDate>${now.toUTCString()}</pubDate></item>`;
    }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${xml(TEAM)} Tournament Feed</title><link>${xml(EVENT_URL)}</link><description>${xml(EVENT)}</description><lastBuildDate>${now.toUTCString()}</lastBuildDate>${items}</channel></rss>\n`;
}

function rank(s) { return s === 'live' ? 0 : s === 'final' ? 1 : 2; }
function fmtScore(v) { return Number.isFinite(v) ? String(v) : '?'; }
function first(obj, keys) { for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj,k) && obj[k] != null) return obj[k]; return null; }
function asName(v) { if (!v) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return String(v.name || v.teamName || v.displayName || v.title || v.label || ''); return String(v); }
function normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g,''); }
function same(a,b) { const x=normalize(a), y=normalize(b); return x===y || x.includes(y) || y.includes(x); }
function numberish(v) { if (v == null || v === '') return null; const n=Number(v); return Number.isFinite(n) ? n : null; }
function cleanCourt(v) { if (!v) return ''; if (typeof v === 'object') return String(v.name || v.label || v.title || ''); return String(v); }
function humanTime(v) { if (!v) return ''; const s=String(v); const d=new Date(s); if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(s)) return new Intl.DateTimeFormat('en-US',{weekday:'short',hour:'numeric',minute:'2-digit',timeZone:TZ}).format(d); return s; }
function walk(v, fn) { if (!v || typeof v !== 'object') return; fn(v); if (Array.isArray(v)) for (const x of v) walk(x,fn); else for (const x of Object.values(v)) walk(x,fn); }
function xml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function dedupe(arr) { const seen=new Set(), out=[]; for (const m of arr) { const key=[normalize(m.opponent),m.time,m.court,m.teamSets,m.opponentSets].join('|'); if (!seen.has(key)) { seen.add(key); out.push(m); } } return out; }
