import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const EVENT_URL = 'https://events.ottoevent.ai/event/fea42fc5d/divisions/27635/pool-bracket?pbTabId=cb0e590a-d91a-4d67-8c37-a137c20c9ca0&pbId=78dc27fa-9b59-425b-a5d1-bcd740a7414e';
const EVENT = '2026 Tri-County High School Championships';
const TEAMS = ['Lady Mavericks Fr','Carrollton School JV Team',"Goleman Girls' JV",'Riviera Prep JV'];
const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const same = (a,b) => { const x=norm(a), y=norm(b); return x===y || x.includes(y) || y.includes(x); };
const canonical = n => TEAMS.find(t=>same(t,n)) || String(n||'');
const first = (o,ks) => { for (const k of ks) if (o && Object.prototype.hasOwnProperty.call(o,k) && o[k]!=null) return o[k]; return null; };
const nameOf = v => !v ? '' : typeof v==='string' ? v : String(v.name||v.teamName||v.displayName||v.title||v.label||'');
const num = v => { const n=Number(v); return v==null||v===''||!Number.isFinite(n) ? null : n; };
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

const responses=[];
let body='';
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:2200}});
  page.on('response', async r=>{
    try {
      const ct=(r.headers()['content-type']||'').toLowerCase();
      if(!/(json|graphql|javascript)/.test(ct)) return;
      const text=await r.text();
      if(text && text.length<5000000 && TEAMS.some(t=>norm(text).includes(norm(t)))) responses.push({url:r.url(),text});
    } catch {}
  });
  await page.goto(EVENT_URL,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(12000);
  body=await page.locator('body').innerText().catch(()=> '');
} finally { await browser.close(); }

const visible=parseVisible(body);
let network=[];
let matchedUrl='';
for(const r of responses){
  const m=parseJsonText(r.text);
  if(m.length>network.length){ network=m; matchedUrl=r.url; }
}

const merged=merge(visible,network);
const games=merged.length ? merged : fallback();
const now=new Date();
await fs.writeFile('division-feed.xml',rss(games,now),'utf8');
await fs.writeFile('division-status.json',JSON.stringify({ok:true,event:EVENT,eventUrl:EVENT_URL,generatedAt:now.toISOString(),source:network.length?'network+page':visible.length?'rendered-page':'fallback',matchedUrl:matchedUrl||null,games},null,2)+'\n','utf8');
console.log(JSON.stringify({count:games.length,source:network.length?'network+page':visible.length?'rendered-page':'fallback',matchedUrl},null,2));

function parseVisible(text){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(!/\b(?:mon|tue|wed|thu|fri|sat|sun)?\s*,?\s*\d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(lines[i])) continue;
    const names=[];
    for(let j=i-1;j>=Math.max(0,i-8);j--){
      const t=TEAMS.find(x=>same(lines[j],x));
      if(t && !names.some(n=>same(n,t))) names.unshift(t);
      if(names.length===3) break;
    }
    if(names.length<2) continue;
    const a=names[0], b=names[1];
    if(!a||!b||same(a,b)) continue;
    const window=lines.slice(Math.max(0,i-5),Math.min(lines.length,i+5));
    const court=(window.find(x=>/\b(?:ct\.?|court)\s*\.?\s*\d+\b/i.test(x))||'').replace(/Ct\.?\s*Ct\.?/i,'Ct.').replace(/Ct\.?\s*(\d+)/i,'Ct. $1');
    const joined=window.join(' | ');
    const pair=joined.match(/(?:^|\D)([0-3])\s*[-–:]\s*([0-3])(?:\D|$)/);
    const final=/final|complete|completed|finished/i.test(joined)||(pair&&Math.max(+pair[1],+pair[2])>=2);
    const live=/live|in progress|playing/i.test(joined);
    out.push({id:`page-${norm(a)}-${norm(b)}-${norm(lines[i])}`,team:a,opponent:b,time:lines[i].replace(/^Starts\s+/i,'').replace(/,$/,''),court,status:final?'final':live?'live':'scheduled',teamSets:pair?+pair[1]:null,opponentSets:pair?+pair[2]:null,setScores:[]});
  }
  return dedupe(out);
}

function parseJsonText(text){
  const roots=[];
  try{roots.push(JSON.parse(text));}catch{}
  if(!roots.length) return [];
  const out=[];
  for(const root of roots) walk(root,o=>{
    if(!o||typeof o!=='object'||Array.isArray(o)) return;
    let a=nameOf(first(o,['homeTeamName','team1Name','teamAName','homeName','team1','teamA','homeTeam','teamOne','teamOneName']));
    let b=nameOf(first(o,['awayTeamName','team2Name','teamBName','awayName','team2','teamB','awayTeam','teamTwo','teamTwoName']));
    const w=nameOf(first(o,['winnerName','winningTeamName','winnerTeamName','winner']));
    const l=nameOf(first(o,['loserName','losingTeamName','loserTeamName','loser']));
    if((!a||!b)&&w&&l){a=w;b=l;}
    if(!a||!b||!TEAMS.some(t=>same(t,a))||!TEAMS.some(t=>same(t,b))||same(a,b)) return;
    a=canonical(a); b=canonical(b);
    const sa=num(first(o,['homeSets','team1Sets','teamASets','wins1','score1','homeScore','teamOneScore','teamOneSets','homeTeamScore']));
    const sb=num(first(o,['awaySets','team2Sets','teamBSets','wins2','score2','awayScore','teamTwoScore','teamTwoSets','awayTeamScore']));
    const st=String(first(o,['status','matchStatus','state','resultStatus','statusName'])||'').toLowerCase();
    const final=/final|complete|completed|finished/.test(st)||(Number.isFinite(sa)&&Number.isFinite(sb)&&Math.max(sa,sb)>=2);
    const live=/live|progress|playing|in progress/.test(st);
    const time=fmtTime(first(o,['startTime','matchTime','scheduledTime','time','dateTime','startDateTime','scheduledAt','matchDate']));
    const court=nameOf(first(o,['courtName','court','locationName','location','courtLabel','venueCourt'])) || String(first(o,['courtName','court','locationName','location','courtLabel','venueCourt'])||'');
    out.push({id:String(first(o,['id','matchId','gameId','uuid','matchNumber'])||`net-${norm(a)}-${norm(b)}-${norm(time)}`),team:a,opponent:b,time,court,status:final?'final':live?'live':'scheduled',teamSets:sa,opponentSets:sb,setScores:sets(o)});
  });
  return dedupe(out);
}

function merge(page,net){
  const out=[...page];
  for(const n of net){
    const idx=out.findIndex(p=>pairKey(p)===pairKey(n));
    if(idx<0){ out.push(n); continue; }
    const p=out[idx];
    const nBetter=n.status!=='scheduled'||Number.isFinite(n.teamSets)||Number.isFinite(n.opponentSets);
    if(nBetter) out[idx]={...p,...n,time:n.time||p.time,court:n.court||p.court};
  }
  return dedupe(out);
}

function fallback(){
  return [
    ['Lady Mavericks Fr','Carrollton School JV Team','Fri 3:00 PM','Fuchs Ct. 5'],
    ["Goleman Girls' JV",'Riviera Prep JV','Fri 3:00 PM','Fuchs Ct. 6'],
    ['Lady Mavericks Fr',"Goleman Girls' JV",'Fri 5:00 PM','Fuchs Ct. 5'],
    ['Carrollton School JV Team','Riviera Prep JV','Fri 5:00 PM','Fuchs Ct. 6'],
    ['Lady Mavericks Fr','Riviera Prep JV','Fri 8:00 PM','Fuchs Ct. 5'],
    ['Carrollton School JV Team',"Goleman Girls' JV",'Fri 8:00 PM','Fuchs Ct. 6']
  ].map((x,i)=>({id:`fallback-${i+1}`,team:x[0],opponent:x[1],time:x[2],court:x[3],status:'scheduled',teamSets:null,opponentSets:null,setScores:[]}));
}

function rss(games,now){
  const items=[...games].sort((a,b)=>rank(a)-rank(b)||String(a.time).localeCompare(String(b.time))).map((g,i)=>{
    let title=g.status==='final'?`FINAL: ${g.team} ${score(g.teamSets)}-${score(g.opponentSets)} ${g.opponent}`:g.status==='live'?`LIVE: ${g.team} ${score(g.teamSets)}-${score(g.opponentSets)} ${g.opponent}`:`NEXT: ${g.team} vs ${g.opponent}`;
    const desc=[g.time,g.court,g.setScores?.length?`Sets: ${g.setScores.join(', ')}`:''].filter(Boolean).join(' • ');
    return `<item><title>${esc(title)}</title><description>${esc(desc)}</description><guid isPermaLink="false">${esc(g.id||String(i))}</guid><link>${esc(EVENT_URL)}</link><pubDate>${now.toUTCString()}</pubDate></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(EVENT)} Division Scores</title><link>${esc(EVENT_URL)}</link><description>All scheduled games and updated scores for the selected division pool</description><lastBuildDate>${now.toUTCString()}</lastBuildDate>${items}</channel></rss>\n`;
}

function sets(o){
  const a=first(o,['sets','setScores','games','gameScores','setResults']);
  if(!Array.isArray(a)) return [];
  return a.map(s=>{const x=num(first(s,['homeScore','team1Score','a','score1','points1','teamOneScore'])),y=num(first(s,['awayScore','team2Score','b','score2','points2','teamTwoScore']));return Number.isFinite(x)&&Number.isFinite(y)?`${x}-${y}`:null;}).filter(Boolean);
}
function walk(v,fn){if(!v||typeof v!=='object')return;fn(v);if(Array.isArray(v))for(const x of v)walk(x,fn);else for(const x of Object.values(v))walk(x,fn);}
function fmtTime(v){if(!v)return'';const s=String(v),d=new Date(s);if(!Number.isNaN(d.getTime())&&/\d{4}-\d{2}-\d{2}/.test(s))return new Intl.DateTimeFormat('en-US',{weekday:'short',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).format(d);return s;}
function pairKey(g){return[norm(g.team),norm(g.opponent)].sort().join('|');}
function dedupe(a){const s=new Set(),o=[];for(const g of a){const k=pairKey(g)+'|'+norm(g.time);if(!s.has(k)){s.add(k);o.push(g);}}return o;}
function rank(g){return g.status==='live'?0:g.status==='final'?1:2;}
function score(v){return Number.isFinite(v)?String(v):'?';}
