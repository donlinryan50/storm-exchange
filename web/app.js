const START_CASH = 25000;
// Market depth: ≈1% price move per depth/100 gold bars traded, the same for every player. It's set per season
// (meta/season.depth) and grows with the number of traders, so a bigger crowd doesn't just pump everything.
const depthNow = () => (SIM.on && SIM.depth) || (curSeason && curSeason.depth) || 250000;
const MAX_POS = 0.4;            // no single player can be more than 40% of your net worth when you buy in
const MAX_ORDER = 500;
const LOG_CAP = 3000;           // trades per season (the server enforces the same limit)
const DC_INVITE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/;
let curSeason = null;           // seasons row: {n, name, start, end, depth, ipo:{pid:open}, past:[{n, name, end, top:[{tag, discord, nw}]}]}
let sb = null;                  // Supabase client (web/config.js holds the project URL and the public anon key)

const S = {
  uid:null, profile:null, admin:false,
  mode:"loading",           // loading | db | offline
  players:[], portfolios:{}, me:fresh(), saving:false, net:{},
  tab:"home", heat:"ipo", tierOf:{}, evRegion:(()=>{ try{ return localStorage.getItem("stormex-evregion")||"All"; }catch(_){ return "All"; } })(), region:"All", sort:"price", range:"all",
  ticket:null,              // {id, side, qty, msg}
  showLogin:false, authView:"login", authMsg:"", market:{}, board:[], discord:null, shocks:null, simskill:null
};

function fresh(){ return curSeason ? {cash:START_CASH, pos:{}, log:[], season:curSeason.n} : {cash:START_CASH, pos:{}, log:[]}; }

/* ---------- seasons: everyone restarts at START_CASH; only this season's portfolios move prices or rank ---------- */
const seasonOver = () => !!(curSeason && Date.now() > Date.parse(curSeason.end));
const inSeason = pf => !curSeason || pf.season === curSeason.n;
function seasonMe(d){   // a portfolio from an earlier season starts over, keeping the trader's profile
  if(!d || inSeason(d)) return d;
  const me = fresh(); for(const k of ["tag","discord","pfp"]) if(d[k]) me[k] = d[k];
  return me;
}
function daysLeft(){
  const ms = Date.parse(curSeason.end) - Date.now(), d = Math.ceil(ms/864e5);
  return d > 1 ? d+" days left" : ms > 36e5 ? Math.ceil(ms/36e5)+" hours left" : "final hour";
}
function esc(s){ return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
const fmt = n => Math.round(n).toLocaleString("en-US");
const pct = n => (n>0?"+":"") + (n*100).toFixed(1) + "%";
const cls = n => n>0.0005 ? "up" : n<-0.0005 ? "down" : "flat";
let PMAP = null, PMAP_SRC = null;   // id -> player, rebuilt whenever the players list is replaced
const byId = id => { if(PMAP_SRC !== S.players){ PMAP = new Map(S.players.map(p=>[p.id, p])); PMAP_SRC = S.players; } return PMAP.get(id); };
const today = () => new Date().toLocaleDateString("en-CA");
const dLabel = ms => new Date(ms).toLocaleDateString("en-US", {month:"short", day:"numeric"});
const dtLabel = ms => { const d=new Date(ms); return dLabel(ms)+" "+d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); };

/* ---------- market maker ----------
   Impact is measured in gold bars, not shares, so every player moves the same amount for the same money:
   the price rises by a factor of e for every DEPTH bars bought (≈1% per 2,500 bars).
   In shares that works out to price = IPO / (1 − N·IPO/DEPTH), where N = long shares − short shares across everyone.
   The Storm Rating never touches the price. */
const priceAt = (p, N, m = p.m ?? 1) => m * p.open / Math.max(1e-6, 1 - N*p.open/depthNow());
const fill = (p, N, n, m = p.m ?? 1) => { const D = depthNow(), a = p.open/D, hi = 1 - (N+n)*a;   // bars to move net shares from N to N+n
  return hi <= 0 ? Infinity : m * D * Math.log((1 - N*a) / hi); };

/* Div Cup result shocks (meta/shocks, written by the refresh task): each one multiplies a player's market value
   from its timestamp on. Placement in a Division 1 Week Final:
     Tier 1: top 5 ×1.035, 6–10 no change, 11+ ×0.975
     Tier 2: top 15 ×1.10, 16–30 no change, 31+ ×0.995
     Tier 3: top 20 ×1.10, otherwise no change
   Played that week's Division 1 session but missed the Final: Tier 1 ×0.95, Tier 2 ×0.9875, Tier 3 ×0.9965.
   Percentages tuned by simulating seasons against a year of real Div Cup results so every heatmap stays mixed. */
const MISS_F = {1:.95, 2:.9875, 3:.9965};
function finalF(t, rk){   // null = no change
  if(t===1) return rk <= 5 ? 1.035 : rk <= 10 ? null : .975;
  if(t===2) return rk <= 15 ? 1.10 : rk <= 30 ? null : .995;
  return rk <= 20 ? 1.10 : null;
}
function seasonShocks(){ return S.shocks && curSeason && S.shocks.season===curSeason.n ? (S.shocks.list||[]) : []; }
function multAt(pid, t){ let m = 1; for(const s of seasonShocks()) if(s.pid===pid && s.ts<=t) m *= s.f; return m; }

/* Every trader's portfolio, built from the server's portfolios / positions / trades tables (read-only for
   browsers; trades only change through the server's trade() function). In a test run, the bots live here. */
function allPortfolios(){
  const all = {};
  for(const [id,pf] of Object.entries(S.portfolios)) if(inSeason(pf)) all[id] = pf;
  if(S.uid || SIM.on) all[S.uid || "__me"] = S.me;
  return all;
}
let TB = null;   // trades grouped by player, rebuilt lazily after each derive()
function tradeIndex(){
  if(TB) return TB;
  TB = {};
  for(const pf of Object.values(allPortfolios())) for(const l of (pf.log||[])) if(l.ts) (TB[l.pid] = TB[l.pid] || []).push(l);
  return TB;
}
function derive(){
  if(!SIM.on) TB = null;   // the simulator updates the index trade by trade
  const net = {};
  if(SIM.on){   // the test run prices from its bots' holdings
    for(const pf of Object.values(allPortfolios()))
      for(const [pid,pos] of Object.entries(pf.pos||{})) net[pid] = (net[pid]||0) + (pos.side==="long" ? pos.sh : -pos.sh);
  } else for(const [pid, m] of Object.entries(S.market)) net[pid] = m.net;   // live: the server's market table
  S.net = net;
  for(const p of S.players){   // each season re-IPOs every player at their Storm Rating ÷ 100 from the season start
    if(p.base === undefined) p.base = p.open;
    p.open = (curSeason && curSeason.ipo && curSeason.ipo[p.id]) || p.base;
    p.m = SIM.on ? multAt(p.id, Date.now()) : (S.market[p.id]?.mult ?? 1);
    p.price = priceAt(p, net[p.id]||0);
  }
  // latest tournament stats and Storm Rating snapshots written by the refresh task override what's stored on player docs
  const snaps = S.prSnaps || [];
  for(const p of S.players){
    if(!SIM.on || p._realForm === undefined) p._realForm = p.form;
    if(SIM.on && SIM.form[p.id]) p.form = {src:"Simulation", ev:[...SIM.form[p.id], ...((p._realForm && p._realForm.ev) || [])]};
    if(!snaps.length) continue;
    if(p._prh === undefined){ p._prh = p.prHistory || []; p._note = p.note; }
    const byDay = {}; for(const h of p._prh) byDay[h.t] = h.pr;
    let latest = null, note = null;
    for(const s of snaps){ const v = s.pr?.[p.id]; if(v == null) continue; byDay[s.at.slice(0,10)] = v; latest = v; if(s.note?.[p.id]) note = s.note[p.id]; }
    p.prHistory = Object.entries(byDay).sort().map(([t,pr])=>({t, pr}));
    if(latest != null) p.pr = latest;
    if(note) p.note = note;
  }
  // tiers by Storm Rating rank within each region: T1 top 30, T2 top 100, T3 the rest
  const byRegion = {};
  for(const p of S.players) (byRegion[p.region] = byRegion[p.region] || []).push(p);
  S.tierOf = {};
  for(const list of Object.values(byRegion)) list.sort((a,b)=>(b.pr||0)-(a.pr||0)).forEach((p,i)=>{ S.tierOf[p.id] = i<30 ? 1 : i<100 ? 2 : 3; });
  formTiers();
}
/* Form tiers: on top of the rating tier, recent Div Cup Finals can move a pro one tier.
   Down: a bad result (missed the Final or placed in the down band) in all of the region's last 4 Finals (T1→T2, T2→T3).
   Up: an up-band finish in 3 of the last 4 (T3→T2, T2→T1). Weeks a pro sat out don't count against them.
   Same rule as build.py's form_tiers, and tested against simulated seasons for heatmap balance. */
function formTiers(){
  S.tierMove = {};
  const list = seasonShocks().filter(s=>s.w && s.r && s.k); if(!list.length) return;
  const at = {};   // window -> time, per region
  for(const s of list) (at[s.r] = at[s.r] || {})[s.w] = Math.min(at[s.r][s.w] ?? Infinity, s.ts);
  const last4 = {}; for(const r in at) last4[r] = new Set(Object.entries(at[r]).sort((a,b)=>b[1]-a[1]).slice(0, 4).map(e=>e[0]));
  const seen = {};
  for(const s of list){ if(!last4[s.r].has(s.w)) continue; const o = seen[s.pid] = seen[s.pid] || {top:new Set(), bad:new Set()}; o[s.k].add(s.w); }
  for(const [pid, o] of Object.entries(seen)){
    const base = S.tierOf[pid]; if(!base) continue;
    const t = base < 3 && o.bad.size >= 4 ? base + 1 : base > 1 && o.top.size >= 3 ? base - 1 : base;
    if(t !== base){ S.tierOf[pid] = t; S.tierMove[pid] = {from:base, why: t > base ? "a bad result in each of the last 4 Div Cup Finals" : `an up finish in ${o.top.size} of the last 4 Div Cup Finals`}; }
  }
}
function tierArrow(id){ const m = S.tierMove && S.tierMove[id]; return m ? (S.tierOf[id] > m.from ? "↓" : "↑") : ""; }
function tierTitle(p){
  const t = S.tierOf[p.id], m = S.tierMove && S.tierMove[p.id];
  return m ? `Tier ${t} in ${p.region}: moved ${t > m.from ? "down" : "up"} from Tier ${m.from} after ${m.why}` : `Tier ${t} in ${p.region} by Storm Rating`;
}
const dir = a => (a==="buy"||a==="cover") ? 1 : -1;
const dayMs = t => /^\d{4}-\d{2}-\d{2}$/.test(t) ? Date.parse(t+"T00:00:00") : Date.parse(t);
function listedAt(p){ return curSeason ? Math.max(dayMs(p.listed), Date.parse(curSeason.start)) : dayMs(p.listed); }
function marketSeries(p){
  const trades = (tradeIndex()[p.id] || []).slice();
  for(const s of seasonShocks()) if(s.pid===p.id) trades.push({ts:s.ts, a:"buy", n:0});   // result shocks are steps in the line
  trades.sort((a,b)=>a.ts-b.ts);
  let N = 0; const pts = [{x:listedAt(p), y:p.open}];
  for(const l of trades){ N += dir(l.a)*l.n; pts.push({x:Math.max(l.ts, pts[pts.length-1].x), y:priceAt(p, N, multAt(p.id, l.ts))}); }
  pts.push({x:Math.max(Date.now(), pts[pts.length-1].x), y:p.price});
  return pts;
}
function prSeries(p){
  const pts = (p.prHistory||[]).map(h=>({x:dayMs(h.t), y:h.pr})).sort((a,b)=>a.x-b.x);
  if(pts.length) pts.push({x:Math.max(Date.now(), pts[pts.length-1].x), y:pts[pts.length-1].y});
  return pts;
}
// would opening n more shares keep this player at or under 40% of net worth?
function capOK(p, side, n){
  const cur = S.me.pos[p.id], q = quote(side==="long"?"buy":"short", p, n);
  const sh = (cur?cur.sh:0) + n, avg = ((cur?cur.sh*cur.avg:0) + q.total)/sh;
  const N = S.net[p.id]||0, after = N + (side==="long" ? n : -n);
  const val = liqValue({side, sh, avg}, p, after);
  const nw = netWorth(S.me) - q.total + val - liqValue(cur, p, N);
  return val <= MAX_POS*nw + 1e-6;
}
function maxOpen(p, side){
  const D = depthNow(), N = S.net[p.id]||0, x = 1 - N*p.open/D, a = p.open/D, c = S.me.cash/(D*(p.m ?? 1));
  let n = Math.floor((side==="long" ? x*(1-Math.exp(-c)) : x*(Math.exp(c)-1)) / a + 1e-9);
  n = Math.max(0, Math.min(MAX_ORDER, n));
  if(n && !capOK(p, side, n)){ let lo = 0, hi = n; while(lo < hi){ const m = Math.ceil((lo+hi)/2); if(capOK(p, side, m)) lo = m; else hi = m-1; } n = lo; }
  return n;
}

/* ---------- money ---------- */
const cost0 = ps => ps.sh*ps.avg;
function posValue(pos, price){
  if(!pos || !pos.sh) return 0;
  return pos.side==="long" ? pos.sh*price : pos.sh*Math.max(0, 2*pos.avg - price);
}
// What a position is really worth: the gold bars you'd get by closing it right now (same as the server's
// liq_value). Valuing at the last price would let traders inflate their net worth just by buying.
function liqValue(pos, p, N = S.net[p.id]||0){
  if(!pos || !pos.sh) return 0;
  if(pos.side==="long"){ const v = fill(p, N - pos.sh, pos.sh); return isFinite(v) ? v : 0; }
  const cover = fill(p, N, pos.sh);
  return Math.max(0, 2*pos.avg*pos.sh - (isFinite(cover) ? cover : 2*pos.avg*pos.sh));
}
function netWorth(pf){
  let v = pf.cash || 0;
  for(const [pid,pos] of Object.entries(pf.pos||{})){
    const p = byId(pid); v += p ? liqValue(pos, p) : pos.sh*pos.avg;
  }
  return v;
}

/* ---------- trading ---------- */
async function persist(){ TB = null; derive(); render(); }   // only the test run changes S.me in the browser
function quote(action, p, n){
  const N = S.net[p.id]||0;
  return dir(action)>0 ? {total: fill(p,N,n), after: priceAt(p,N+n)} : {total: fill(p,N-n,n), after: priceAt(p,N-n)};
}
// Checks an order with the same rules the server uses and returns the portfolio it would produce.
// Live trades only use this for instant feedback: the server's trade() makes the real decision.
function localTrade(action, pid, n){
  derive();
  if(seasonOver()) return curSeason.name+" has ended. Trading reopens when the next season starts.";
  if((S.me.log||[]).length >= LOG_CAP) return "You've hit this season's limit of "+fmt(LOG_CAP)+" trades.";
  const p = byId(pid); if(!p) return "That player is no longer listed.";
  n = Math.floor(n); if(!(n>0)) return "Enter at least 1 share.";
  if(n > MAX_ORDER) return "The most you can trade at once is "+MAX_ORDER+" shares.";
  const me = structuredClone(S.me), cur = me.pos[pid], q = quote(action, p, n);
  let px;
  if(action==="buy" || action==="short"){
    const side = action==="buy" ? "long" : "short";
    if(cur && cur.side!==side) return side==="long" ? "Cover your short on "+p.name+" before betting up." : "Sell your shares of "+p.name+" before betting down.";
    if(q.total > me.cash + 1e-9) return "Not enough gold bars. You have "+fmt(me.cash)+".";
    if(!capOK(p, side, n)){ const m = maxOpen(p, side); return `That would put more than 40% of your net worth into ${p.name}. ${m ? `You can add up to ${m} more share${m===1?"":"s"}.` : "Sell some first or grow your other positions."}`; }
    me.cash -= q.total;
    const sh = (cur?cur.sh:0) + n;
    me.pos[pid] = {side, sh, avg: ((cur?cur.sh*cur.avg:0) + q.total)/sh};
    px = q.total/n;
  } else {
    if(!cur) return "You don't hold a position in "+p.name+".";
    if(n > cur.sh) return "You only hold "+cur.sh+" shares.";
    me.cash += cur.side==="long" ? q.total : Math.max(0, 2*cur.avg*n - q.total);
    px = q.total/n;
    cur.sh -= n; if(cur.sh===0) delete me.pos[pid];
  }
  me.log = [{ts:Date.now(), pid, a:action, n, px}, ...(me.log||[])];
  if(curSeason) me.season = curSeason.n;
  return {me};
}
async function execute(action, pid, n){
  if(SIM.on){ const r = localTrade(action, pid, n); if(typeof r==="string") return r; S.me = r.me; persist(); return null; }
  if(!S.uid){ showAuth("login"); return "Log in or create an account to trade."; }
  const r = localTrade(action, pid, n); if(typeof r==="string") return r;
  const {error} = await sb.rpc("trade", {p_player:pid, p_action:action, p_shares:Math.floor(n)});
  if(error) return niceErr(error);
  await refreshMarket(); derive(); render();
  return null;
}
async function runTrade(action, n){
  const t = S.ticket; if(!t || t.busy) return;
  const pid = t.id; t.busy = true; if(!SIM.on){ t.msg = "Placing your trade…"; renderTicket(); }
  const err = await execute(action, pid, n);
  if(S.ticket !== t) return;
  t.busy = false;
  if(err){ t.msg = err; renderTicket(); return; }
  const p = byId(pid), names = {buy:"Bet up on", short:"Bet down on", sell:"Sold", cover:"Covered"};
  toast(`${names[action]} ${n} × ${p.name}. Price now ${fmt(p.price)}.`); t.qty = 1; t.msg = ""; renderTicket();
}
// Server errors come back as Postgres messages; show the human part.
function niceErr(e){
  const m = String(e && (e.message || e.error_description || e) || "");
  if(/fetch|network/i.test(m)) return "Couldn't reach the market. Check your connection and try again.";
  return m.replace(/^.*?ERROR:\s*/, "").slice(0, 200) || "Something went wrong. Try again.";
}

/* ---------- charts ---------- */
function spark(pts, w, h, stroke){
  const ys = pts.map(p=>p.y);
  if(!ys.length) return "";
  if(ys.length===1) ys.push(ys[0]);
  const min=Math.min(...ys), max=Math.max(...ys), span=(max-min)||1, pad=3;
  const xy = ys.map((v,i)=>[pad+i*(w-2*pad)/(ys.length-1), max===min ? h/2 : pad+(h-2*pad)*(1-(v-min)/span)]);
  const d = xy.map((q,i)=>(i?"L":"M")+q[0].toFixed(1)+" "+q[1].toFixed(1)).join(" ");
  const last = xy[xy.length-1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="max-width:100%;display:block">
    <path d="${d} L${last[0].toFixed(1)} ${h} L${xy[0][0].toFixed(1)} ${h} Z" fill="${stroke}" fill-opacity=".14"/>
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${stroke}"/></svg>`;
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const tone = c => c>0.0005?cssVar("--up"):c<-0.0005?cssVar("--down"):cssVar("--flat");

const CH = {};
function clip(pts, range){
  if(range==="all" || !pts.length) return pts;
  const start = Date.now() - {"1d":864e5,"1w":7*864e5,"1m":30*864e5}[range];
  const before = pts.filter(p=>p.x<=start).pop(), after = pts.filter(p=>p.x>start);
  const out = before ? [{x:start,y:before.y}, ...after] : after;
  return out.length>1 ? out : [{x:start,y:pts[pts.length-1].y},{x:Date.now(),y:pts[pts.length-1].y}];
}
function chart(id, pts, {fmtY, color, h=210, label}){
  if(!pts.length) return "";
  const W=560, H=h, L=58, R=14, T=14, B=28;
  let lo=Math.min(...pts.map(p=>p.y)), hi=Math.max(...pts.map(p=>p.y));
  if(hi===lo){ const d=Math.max(1,Math.abs(hi)*0.04); lo-=d; hi+=d; } else { const d=(hi-lo)*0.15; lo-=d; hi+=d; }
  const x0=pts[0].x; let x1=pts[pts.length-1].x; if(x1<=x0) x1=x0+3600e3;
  const X=x=>L+(x-x0)/(x1-x0)*(W-L-R), Y=y=>T+(1-(y-lo)/(hi-lo))*(H-T-B);
  let d=""; pts.forEach((p,i)=>{ d += i ? ` L${X(p.x).toFixed(1)} ${Y(pts[i-1].y).toFixed(1)} L${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}` : `M${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`; });
  const last=pts[pts.length-1], base=(H-B).toFixed(1);
  let grid="";
  for(let i=0;i<4;i++){ const v=lo+(hi-lo)*(i+0.5)/4, y=Y(v).toFixed(1);
    grid += `<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${L-8}" y="${y}" class="ch-y" dy="4" text-anchor="end">${fmtY(v)}</text>`; }
  const short = (x1-x0) < 2*864e5;
  [0,0.5,1].forEach(f=>{ const x=x0+(x1-x0)*f; grid += `<text x="${X(x).toFixed(1)}" y="${H-8}" class="ch-y" text-anchor="${f===0?"start":f===1?"end":"middle"}">${short?dtLabel(x):dLabel(x)}</text>`; });
  CH[id] = {pts, X, Y, fmtY, W, L, R, x0, x1, H, B, T};
  return `<svg class="chart" data-chart="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${grid}
    <path d="${d} L${X(last.x).toFixed(1)} ${base} L${X(pts[0].x).toFixed(1)} ${base} Z" fill="${color}" fill-opacity=".18"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${X(last.x).toFixed(1)}" cy="${Y(last.y).toFixed(1)}" r="4.5" fill="${color}" stroke="#fff" stroke-width="2"/>
    <g class="hv" style="display:none"><line class="hv-l" y1="${T}" y2="${H-B}"/><circle class="hv-c" r="5" fill="${color}" stroke="#fff" stroke-width="2"/>
      <rect class="hv-bg" height="22" rx="3"/><text class="hv-t" dy="15"></text></g>
    <rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent"/>
  </svg>`;
}
document.addEventListener("pointermove", e=>{
  const svg = e.target.closest && e.target.closest("svg[data-chart]");
  document.querySelectorAll("svg[data-chart] .hv").forEach(g=>{ if(!svg || g.ownerSVGElement!==svg) g.style.display="none"; });
  if(!svg) return;
  const c = CH[svg.dataset.chart]; if(!c) return;
  const r = svg.getBoundingClientRect();
  const vx = Math.min(Math.max((e.clientX-r.left)/r.width*c.W, c.L), c.W-c.R);
  const t = c.x0 + (vx-c.L)/(c.W-c.L-c.R)*(c.x1-c.x0);
  let p = c.pts[0]; for(const q of c.pts) if(q.x<=t) p=q;
  const g = svg.querySelector(".hv"); g.style.display="";
  const y = c.Y(p.y);
  const ln = g.querySelector(".hv-l"); ln.setAttribute("x1",vx); ln.setAttribute("x2",vx);
  const ci = g.querySelector(".hv-c"); ci.setAttribute("cx",vx); ci.setAttribute("cy",y);
  const tx = g.querySelector(".hv-t"); tx.textContent = c.fmtY(p.y)+" · "+((c.x1-c.x0)<2*864e5?dtLabel(t):dLabel(t));
  const w = tx.getComputedTextLength()+14, bx = Math.min(Math.max(vx-w/2, c.L), c.W-c.R-w);
  const by = y-34 < c.T ? y+12 : y-34;
  const bg = g.querySelector(".hv-bg"); bg.setAttribute("x",bx); bg.setAttribute("y",by); bg.setAttribute("width",w);
  tx.setAttribute("x",bx+7); tx.setAttribute("y",by);
});

/* ---------- sentiment from everyone's portfolios ---------- */
function sentiment(){
  const s = {};
  for(const pf of Object.values(allPortfolios())){
    for(const [pid,pos] of Object.entries(pf.pos||{})){
      s[pid] = s[pid] || {long:0, short:0};
      s[pid][pos.side]++;
    }
  }
  return s;
}

/* ---------- render ---------- */
function render(){
  renderHeader(); renderBanner(); updateTicker(); renderLogin();
  document.querySelectorAll("nav button").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab===S.tab)));
  const home = S.tab==="home";
  document.getElementById("homeRoot").hidden = !home;
  document.getElementById("mainView").hidden = home;
  renderSim();
  if(home){ renderHome(); renderTicket(); renderSeason(); return; }
  stopArena();
  const v = document.getElementById("view");
  if(S.tab==="market") v.innerHTML = marketHTML();
  else if(S.tab==="heat"){ v.innerHTML = heatHTML(); drawHeat(); }
  else if(S.tab==="portfolio") v.innerHTML = portfolioHTML();
  else { v.innerHTML = leadersShell(); fillLeaders(); }
  renderTicket(); renderSeason();
}

function renderHeader(){
  const nw = netWorth(S.me), r = nw/START_CASH - 1;
  document.getElementById("hdNet").textContent = fmt(nw);
  const ret = document.getElementById("hdRet"); ret.textContent = pct(r); ret.className = cls(r);
  document.getElementById("hdCash").textContent = fmt(S.me.cash);
  document.getElementById("acct").hidden = S.mode==="loading";
  const pr = S.profile;
  document.getElementById("acctTag").textContent = pr ? pr.username : "Log in";
  document.getElementById("acctSub").textContent = pr ? (pr.discord_username ? "@"+pr.discord_username : "Link Discord") : "or sign up free";
  const av = document.getElementById("acctAv"), src = pr ? dcAvatar({avatar:pr.discord_avatar, discord:pr.discord_username, tag:pr.username}) : "";
  av.hidden = !src; if(src && av.getAttribute("src")!==src){ av.src = src; av.onerror = ()=>{ av.hidden = true; }; }
}

// Avatars: the verified Discord avatar when a trader has linked Discord, otherwise a Discord-blue initial badge.
function dcAvatar(pf){
  if(!pf) return "";
  if(typeof pf.avatar==="string" && /^https:\/\/cdn\.discordapp\.com\//.test(pf.avatar)) return pf.avatar;
  const name = pf.discord || pf.tag; if(!name) return "";
  const ch = (String(name).match(/[a-z0-9]/i) || ["?"])[0].toUpperCase();
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5865f2"/><text x="32" y="43" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text></svg>`);
}

/* ---------- accounts: username + password (Supabase Auth), Discord linked through Discord's own login ---------- */
const USER_RE = /^[A-Za-z0-9_.-]{3,16}$/;
function loginOpen(){ return S.showLogin && S.mode!=="loading"; }
function loginHTML(){
  const v = S.authView, msg = S.authMsg ? `<p class="lg-ok" role="status">${esc(S.authMsg)}</p>` : "";
  const shell = (title, sub, inner) => `<div class="lg-sky" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><b></b><b></b><b></b><b></b></div>
  <form class="lg-card" id="lgForm" data-view="${v}" novalidate aria-labelledby="lgTitle">
    <div class="lg-brand"><span class="label">${esc(title)}</span><h2 id="lgTitle">STORM<span>EX</span></h2></div>
    <p class="lg-sub">${sub}</p>${msg}${inner}
    <p class="lg-err" id="lgErr" role="alert"></p>
    <span class="dc-slot"></span>
  </form>`;
  if(v==="signup") return shell("Create your account", "Pick a username and password. Everyone starts each season with 25,000 gold bars.", `
    <label class="lg-f"><span class="label">Username</span><input id="lgUser" maxlength="16" autocomplete="username" spellcheck="false" placeholder="e.g. StormChaser" required></label>
    <label class="lg-f"><span class="label">Email</span><input id="lgEmail" type="email" maxlength="120" autocomplete="email" placeholder="you@example.com" required><small>Only used to confirm your account and reset your password. Never shown to anyone.</small></label>
    <label class="lg-f"><span class="label">Password</span><input id="lgPass" type="password" minlength="8" maxlength="72" autocomplete="new-password" required><small>At least 8 characters.</small></label>
    <button class="btn gold lg-go" type="submit">Create account</button>
    <button class="lg-skip" type="button" data-auth="login">I already have an account</button>
    <button class="lg-skip" type="button" id="lgSkip">Look around first</button>`);
  if(v==="reset") return shell("Reset password", "Enter your account email and we'll send you a link to set a new password.", `
    <label class="lg-f"><span class="label">Email</span><input id="lgEmail" type="email" maxlength="120" autocomplete="email" required></label>
    <button class="btn gold lg-go" type="submit">Send reset link</button>
    <button class="lg-skip" type="button" data-auth="login">Back to log in</button>`);
  if(v==="newpass") return shell("New password", "Choose a new password for your account.", `
    <label class="lg-f"><span class="label">New password</span><input id="lgPass" type="password" minlength="8" maxlength="72" autocomplete="new-password" required><small>At least 8 characters.</small></label>
    <button class="btn gold lg-go" type="submit">Save password</button>`);
  if(v==="account"){
    const pr = S.profile || {};
    const linked = !!pr.discord_id;
    return shell("Your account", linked ? "You're all set for season prizes." : "Link your Discord to compete for season prizes.", `
      <div class="lg-who"><img id="lgAv" alt="" src="${esc(dcAvatar({avatar:pr.discord_avatar, discord:pr.discord_username, tag:pr.username}))}"><div><span class="label">Username</span><b>${esc(pr.username || "")}</b></div></div>
      <div class="lg-f"><span class="label">Discord</span>
        ${linked ? `<div class="lg-who"><div><b>@${esc(pr.discord_username || "linked")}</b><small>Verified through Discord. Your Discord name and avatar show on the leaderboard, and you're eligible for prizes.</small></div></div>
          <button class="btn" type="button" id="dcUnlink">Unlink Discord</button>`
        : `<button class="btn dcbtn lg-go" type="button" id="dcLink">Link Discord</button>
          <small>You'll log in to Discord to confirm it's your account. Only linked traders can win prizes.</small>`}
      </div>
      <button class="btn lg-go" type="button" id="lgOut">Log out</button>
      <button class="lg-skip" type="button" id="lgSkip">Close</button>`);
  }
  return shell("Log in", "Log in with your username (or email) and password.", `
    <label class="lg-f"><span class="label">Username or email</span><input id="lgUser" maxlength="120" autocomplete="username" spellcheck="false" required></label>
    <label class="lg-f"><span class="label">Password</span><input id="lgPass" type="password" maxlength="72" autocomplete="current-password" required></label>
    <button class="btn gold lg-go" type="submit">Log in</button>
    <button class="lg-skip" type="button" data-auth="signup">Create an account</button>
    <button class="lg-skip" type="button" data-auth="reset">Forgot password?</button>
    <button class="lg-skip" type="button" id="lgSkip">Look around first</button>`);
}
function renderLogin(force){
  const root = document.getElementById("loginRoot"), open = loginOpen();
  const key = open ? S.authView + "|" + S.authMsg + "|" + (S.profile?.discord_id || "") : "";
  if(!force && root.dataset.key === key) return;
  root.dataset.key = key;
  root.hidden = !open; document.documentElement.style.overflow = open ? "hidden" : "";
  if(!open){ root.innerHTML = ""; return; }
  root.innerHTML = loginHTML();
  root.querySelector("input")?.focus({preventScroll:true});
}
function showAuth(view, msg){ S.authView = view; S.authMsg = msg || ""; S.showLogin = true; renderLogin(true); }
async function submitAuth(){
  const v = S.authView, val = id => (document.getElementById(id)?.value || "").trim();
  const err = m => { const e = document.getElementById("lgErr"); if(e) e.textContent = m; };
  const go = document.querySelector("#lgForm .lg-go"); if(go) go.disabled = true;
  try{
    if(v==="login"){
      const login = val("lgUser"), pw = document.getElementById("lgPass").value;
      if(!login || !pw) return err("Enter your username and password.");
      let email = login;
      if(!login.includes("@")){
        const {data, error} = await sb.rpc("login_email", {p_login:login, p_password:pw});
        if(error) return err(niceErr(error));
        if(!data) return err("Wrong username or password.");
        email = data;
      }
      const {error} = await sb.auth.signInWithPassword({email, password:pw});
      if(error) return err(/confirm/i.test(error.message) ? "Confirm your email first: check your inbox for the link we sent." : "Wrong username or password.");
      S.showLogin = false; toast("Welcome back."); return;
    }
    if(v==="signup"){
      const username = val("lgUser"), email = val("lgEmail"), pw = document.getElementById("lgPass").value;
      if(!USER_RE.test(username)) return err("Usernames are 3–16 letters, numbers, dots, dashes or underscores.");
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email.");
      if(pw.length < 8) return err("Use at least 8 characters for your password.");
      const {data:free} = await sb.rpc("username_available", {p_username:username});
      if(free === false) return err("That username is taken. Try another.");
      const {data, error} = await sb.auth.signUp({email, password:pw, options:{data:{username}, emailRedirectTo:location.origin + location.pathname}});
      if(error) return err(niceErr(error));
      if(data.session){ S.showLogin = false; toast(`Welcome to the Exchange, ${username}. You have ${fmt(START_CASH)} gold bars to trade.`); }
      else showAuth("login", "Check your email to confirm your account, then log in here.");
      return;
    }
    if(v==="reset"){
      const email = val("lgEmail"); if(!email) return err("Enter your email.");
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo:location.origin + location.pathname});
      if(error) return err(niceErr(error));
      return showAuth("login", "If that email has an account, a reset link is on its way.");
    }
    if(v==="newpass"){
      const pw = document.getElementById("lgPass").value;
      if(pw.length < 8) return err("Use at least 8 characters for your password.");
      const {error} = await sb.auth.updateUser({password:pw});
      if(error) return err(niceErr(error));
      S.showLogin = false; toast("Password updated.");
    }
  } finally { if(go && document.body.contains(go)) go.disabled = false; render(); }
}
async function linkDiscord(){
  // guilds.join lets our server function add them to the Storm Exchange Discord right after linking
  const {error} = await sb.auth.linkIdentity({provider:"discord", options:{scopes:"identify email guilds.join", redirectTo:location.origin + location.pathname + "?linked=discord"}});
  if(error){ const e = document.getElementById("lgErr"); if(e) e.textContent = niceErr(error); }
}
async function unlinkDiscord(){
  const {data, error} = await sb.auth.getUserIdentities();
  const idn = !error && data.identities.find(i=>i.provider==="discord");
  if(idn){ const r = await sb.auth.unlinkIdentity(idn); if(r.error){ const e = document.getElementById("lgErr"); if(e) e.textContent = niceErr(r.error); return; } }
  await sb.rpc("sync_discord"); await loadProfile(); await refreshMarket(); derive(); render(); renderLogin(true); toast("Discord unlinked.");
}

function discordInvite(){
  const u = (S.discord && S.discord.invite) || (S.dcWidget && S.dcWidget.instant_invite);
  return u && /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/.test(u) ? u : "";
}
function discordBtn(){
  const u = discordInvite(), w = S.dcWidget;
  if(!u) return "";
  const online = w && Number.isFinite(w.presence_count) ? `<span class="dc-online"><i></i>${fmt(w.presence_count)} online</span>` : "";
  return `<a class="btn dcbtn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Join our Discord${online}</a>`;
}
// Live server info from Discord's public widget feed (Server Settings -> Widget must be enabled).
async function loadDiscordWidget(){
  const id = S.discord && S.discord.guild_id;
  if(!id || !/^\d{17,20}$/.test(id)) return;
  try{
    const r = await fetch(`https://discord.com/api/guilds/${id}/widget.json`);
    if(!r.ok) return;
    const w = await r.json();
    S.dcWidget = {name:String(w.name || ""), presence_count:Number(w.presence_count), instant_invite:w.instant_invite || ""};
    renderSeason(); renderDcCard();
  }catch(e){}
}
function renderDcCard(){
  const el = document.getElementById("dcCard"); if(!el) return;
  const u = discordInvite(), w = S.dcWidget;
  el.hidden = !u;
  if(!u) return;
  el.innerHTML = `<div><span class="label">Community</span><h3>${esc(w?.name || "Storm Exchange Discord")}</h3>
    <p>${w && Number.isFinite(w.presence_count) ? `<b class="dc-online"><i></i>${fmt(w.presence_count)} online now</b> · ` : ""}Talk picks, call the next breakout, and claim season prizes. Link Discord on your account and you're added automatically.</p></div>
    <a class="btn dcbtn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Join the server</a>`;
}
function renderSeason(){
  const s = curSeason, over = seasonOver(), btn = discordBtn();
  document.getElementById("seasonClock").innerHTML = s
    ? `<div class="big">${over ? "FINAL" : "S"+esc(s.n)}</div><div class="label">${esc(s.name)} · ${over ? "has ended" : "ends "+dLabel(Date.parse(s.end))+" · "+daysLeft()}</div>`
    : `<div class="big">OPEN</div><div class="label">Market open 24/7</div>`;
  const k = document.getElementById("hmKick");
  if(k) k.textContent = s ? `Pro player futures · ${s.name} ${over ? "has ended" : "ends "+dLabel(Date.parse(s.end))}` : "Pro player futures · Market open 24/7";
  document.querySelectorAll(".dc-slot").forEach(el=>{ if(el.innerHTML !== btn) el.innerHTML = btn; });
  const per1 = fmt(depthNow()/100); document.querySelectorAll(".impact").forEach(el=>{ if(el.textContent !== per1) el.textContent = per1; });
}

function renderBanner(){
  const b = document.getElementById("banner");
  if(S.mode==="offline") b.innerHTML = S.offlineWhy==="config"
    ? `<div class="banner"><strong>This site isn't connected to its database yet.</strong> Add the Supabase project URL and anon key to config.js (see README.md).</div>`
    : `<div class="banner"><strong>The live market isn't reachable.</strong> Check your connection and reload the page.</div>`;
  else if(S.mode==="db" && !S.uid && !SIM.on) b.innerHTML = `<div class="banner"><strong>You're browsing as a guest.</strong> <button class="btn gold" data-auth="signup">Create an account</button> or <button class="btn" data-auth="login">log in</button> to trade.</div>`;
  else b.innerHTML = "";
}

function marketHTML(){
  if(S.mode==="loading") return `<div class="board"><div class="empty"><strong>Opening the market…</strong>Loading player prices.</div></div>`;
  if(!S.players.length) return `<div class="board"><div class="empty"><strong>No players listed yet.</strong>${S.admin ? "Add the first player with the form below." : "The market owner hasn't listed any players."}</div></div>` + adminHTML();
  const sent = sentiment();
  const regions = ["All", ...[...new Set(S.players.map(p=>p.region))].sort()];
  const q = (S.q||"").trim().toLowerCase();
  let list = S.players.filter(p=>(S.region==="All"||p.region===S.region) && (!S.tier||S.tierOf[p.id]===S.tier) && (!q || p.name.toLowerCase().includes(q) || (p.note||"").toLowerCase().includes(q)));
  const chg = p => (p.price-p.open)/p.open;
  const sorters = {price:(a,b)=>b.price-a.price, gain:(a,b)=>chg(b)-chg(a), loss:(a,b)=>chg(a)-chg(b), pr:(a,b)=>(b.pr||0)-(a.pr||0), bulls:(a,b)=>((sent[b.id]?.long||0)-(sent[b.id]?.short||0))-((sent[a.id]?.long||0)-(sent[a.id]?.short||0)), name:(a,b)=>a.name.localeCompare(b.name)};
  list.sort(sorters[S.sort]);
  const rows = list.map((p,i)=>{
    const c = chg(p), s = sent[p.id]||{long:0,short:0}, tot = s.long+s.short;
    const lp = tot? s.long/tot*100 : 50;
    const mine = S.me.pos[p.id];
    return `<div class="row player" data-row="${esc(p.id)}">
      <span class="rank">${i+1}</span>
      <span class="who"><span class="nline">${S.tierOf[p.id]?`<span class="tier mini t${S.tierOf[p.id]}" title="${esc(tierTitle(p))}">T${S.tierOf[p.id]}${tierArrow(p.id)}</span>`:""}<button class="pname n" data-open="${esc(p.id)}" title="Show ${esc(p.name)}'s chart">${esc(p.name)}</button>${mine?`<span class="mine ${mine.side}">${mine.side==="long"?"UP":"DOWN"} ×${mine.sh}</span>`:""}</span><span class="r">${esc(p.region)}${p.note?" · "+esc(p.note):""}${p.pr?" · SR "+fmt(p.pr):""}</span></span>
      <span class="price">${fmt(p.price)}</span>
      <span class="chg ${cls(c)}">${pct(c)}</span>
      <span class="sp">${spark(marketSeries(p),110,30,tone(c))}</span>
      <span class="sent"><span class="bar"><i style="width:${lp}%;background:${tot?"var(--up)":"var(--line)"}"></i><i style="width:${100-lp}%;background:${tot?"var(--down)":"var(--line)"}"></i></span><small>${tot? `${s.long} up · ${s.short} down` : "no bets yet"}</small></span>
      <span class="acts"><button class="btn long" data-open="${esc(p.id)}" data-side="long">Up</button><button class="btn short" data-open="${esc(p.id)}" data-side="short">Down</button></span>
    </div>`;
  }).join("");
  return `<div class="tools">
      ${regions.map(r=>`<button class="chip" data-region="${esc(r)}" aria-pressed="${r===S.region}">${esc(r)}</button>`).join("")}
      <span class="chip-sep" aria-hidden="true"></span>
      ${[[0,"All tiers"],[1,"T1"],[2,"T2"],[3,"T3"]].map(([t,l])=>`<button class="chip tchip${t?" tc"+t:""}" data-tierf="${t}" aria-pressed="${(S.tier||0)===t}" title="${["Every tier","Top 30 Storm Rating in region","Rating rank 31–100","Rating rank 101+"][t]}">${l}</button>`).join("")}
      <input id="mkSearch" type="search" placeholder="Search player or team" aria-label="Search players" value="${esc(S.q||"")}">
      <select id="sortSel" aria-label="Sort players">
        ${[["price","Highest market value"],["pr","Highest rating"],["gain","Biggest gainers"],["loss","Biggest fallers"],["bulls","Crowd favorites"],["name","Name A–Z"]].map(([k,l])=>`<option value="${k}" ${S.sort===k?"selected":""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="board">
      <div class="row head"><span></span><span class="label">Player</span><span class="label" style="text-align:right">Market value</span><span class="label" style="text-align:right">Since IPO</span><span class="label">Trend</span><span class="label">Crowd</span><span></span></div>
      ${rows}
    </div>
    <div class="how">
      <div><b>Live prices</b>Every <span class="impact">2,500</span> gold bars bought moves a player's price up about 1%, and selling or shorting moves it down. Cheap or expensive, every pro moves the same for the same money.</div>
      <div><b>Bet up or down</b>Bet up and you profit when others buy after you. Bet down and you profit when others sell after you.</div>
      <div><b>Rating is separate</b>The Storm Rating scores every pro from their tournament results over the past year and updates daily, so you can judge form. It never moves the price.</div>
      <div><b>Big events</b>The market runs all year, but prices swing hardest around FNCS, Victory Cash Cups and Performance Evaluations, when results and ratings change fast.</div>
    </div>
    ${adminHTML()}`;
}

function adminHTML(){
  if(!S.admin || S.mode==="offline") return "";
  return `<div class="admin"><h3 style="margin-top:0">List a new player</h3>
    <form id="addForm">
      <div class="field"><label class="label" for="addName">Name</label><input id="addName" required maxlength="24"></div>
      <div class="field"><label class="label" for="addRegion">Region</label><select id="addRegion">${["NA","EU","BR","OCE","ASIA","ME"].map(r=>`<option>${r}</option>`).join("")}</select></div>
      <div class="field"><label class="label" for="addPrice">Storm Rating</label><input id="addPrice" type="number" min="100" max="1000000" required></div>
      <button class="btn gold" type="submit">List player</button>
    </form>
    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">Only admins see this. A new player's IPO price is their Storm Rating ÷ 100. After that, trading sets the price.</p>
    <h3>Season and Discord</h3>
    <form id="seasonForm">
      <div class="field"><label class="label" for="seasonEnd">${curSeason ? esc(curSeason.name)+" ends" : "Season end"}</label><input id="seasonEnd" type="datetime-local" value="${curSeason ? toLocalInput(curSeason.end) : ""}" ${curSeason ? "" : "disabled"}></div>
      <button class="btn" type="submit" ${curSeason ? "" : "disabled"}>Save end date</button>
    </form>
    <form id="discordForm">
      <div class="field"><label class="label" for="dcInvite">Discord invite link</label><input id="dcInvite" placeholder="https://discord.gg/yourserver" value="${esc(S.discord?.invite||"")}"></div>
      <div class="field"><label class="label" for="dcGuild">Discord server ID</label><input id="dcGuild" inputmode="numeric" maxlength="20" placeholder="e.g. 1234567890123456789" value="${esc(S.discord?.guild_id||"")}"></div>
      <div class="field"><label class="label" for="dcClaims">Prize claims channel</label><input id="dcClaims" maxlength="32" placeholder="#prize-claims" value="${esc(S.discord?.claims||"")}"></div>
      <button class="btn gold" type="submit">Save Discord</button>
    </form>
    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">To end a season and start the next, ask Claude to roll it over. That saves the top Discord-linked finishers as past champions, re-IPOs every player at their current Storm Rating and resets everyone to ${fmt(START_CASH)} gold bars.</p></div>`;
}
function toLocalInput(iso){ const d = new Date(iso); return new Date(d - d.getTimezoneOffset()*6e4).toISOString().slice(0,16); }

/* ---------- live P&L history: replay every trade in the market to rebuild prices, and my own trades to rebuild my holdings ---------- */
const PL_COLORS = ["#3ee0ff","#ff7ac8","#b6f35a","#ff9f43","#b98cff","#e8f1ff"];
function plSeries(){
  const mine = (S.me.log||[]).filter(l=>l.ts).slice().sort((a,b)=>a.ts-b.ts);
  if(!mine.length) return null;
  const all = [];
  for(const pf of Object.values(allPortfolios())) for(const l of (pf.log||[])) if(l.ts) all.push(l);
  for(const s of seasonShocks()) all.push({ts:s.ts, pid:s.pid, a:"buy", n:0});
  all.sort((a,b)=>a.ts-b.ts);
  const held = Object.keys(S.me.pos||{}).filter(byId).sort((a,b)=>posValue(S.me.pos[b],byId(b).price)-posValue(S.me.pos[a],byId(a).price)).slice(0, PL_COLORS.length);
  const N = {}, pos = {}; let cash = START_CASH, mi = 0;
  const snap = t=>{ let v = cash; const pl = {};
    for(const [pid,ps] of Object.entries(pos)){ const p = byId(pid); if(!p || !ps.sh) continue; const val = posValue(ps, priceAt(p, N[pid]||0, multAt(pid, t))); v += val; pl[pid] = val - ps.sh*ps.avg; }
    return {x:t, total:v-START_CASH, pl}; };
  const out = [{x:mine[0].ts-60e3, total:0, pl:{}}];
  for(const l of all){
    if(l.ts < mine[0].ts){ N[l.pid] = (N[l.pid]||0) + dir(l.a)*l.n; continue; }
    N[l.pid] = (N[l.pid]||0) + dir(l.a)*l.n;
    while(mi < mine.length && mine[mi].ts <= l.ts){ const m = mine[mi++], cur = pos[m.pid], cost = m.n*m.px;
      if(m.a==="buy"||m.a==="short"){ cash -= cost; const sh = (cur?.sh||0)+m.n; pos[m.pid] = {side:m.a==="buy"?"long":"short", sh, avg:((cur?cur.sh*cur.avg:0)+cost)/sh}; }
      else if(cur){ cash += m.a==="sell" ? cost : Math.max(0, 2*cur.avg*m.n - cost); cur.sh -= m.n; if(cur.sh<=0) delete pos[m.pid]; } }
    out.push(snap(l.ts));
  }
  // anchor the last point to the live portfolio so the line always ends at today's real numbers
  const live = {x:Math.max(Date.now(), out[out.length-1].x), total:netWorth(S.me)-START_CASH, pl:{}};
  for(const pid of held){ const ps = S.me.pos[pid]; live.pl[pid] = liqValue(ps, byId(pid)) - ps.sh*ps.avg; }
  out.push(live);
  return {pts:out, held};
}
function plHTML(){
  const d = plSeries();
  if(!d) return `<h3>Live P&amp;L</h3><div class="board"><div class="empty"><strong>Your P&amp;L chart starts with your first trade.</strong>It tracks your total profit and each player you hold as prices move.</div></div>`;
  const pts = clip(d.pts.map(p=>({x:p.x, y:p.total, pl:p.pl})), S.plRange||"all").map(p=>p.pl ? p : {...p, pl:(d.pts.filter(q=>q.x<=p.x).pop()||d.pts[0]).pl});
  const series = [{id:"total", name:"Total P&L", color:cssVar("--gold"), w:3, ys:pts.map(p=>p.y)},
    ...d.held.map((pid,i)=>({id:pid, name:byId(pid).name, color:PL_COLORS[i], w:2, ys:pts.map(p=>p.pl[pid] ?? 0)}))];
  const W=640, H=240, L=62, R=14, T=16, B=28;
  const all = series.flatMap(s=>s.ys).concat(0); let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max(50, (hi-lo)*.12); lo -= pad; hi += pad;
  const x0 = pts[0].x, x1 = Math.max(pts[pts.length-1].x, x0+36e5);
  const X = x=>L+(x-x0)/(x1-x0)*(W-L-R), Y = y=>T+(1-(y-lo)/(hi-lo))*(H-T-B);
  const sgn = v=>(v>0?"+":v<0?"−":"")+fmt(Math.abs(v));
  let grid = "";
  for(let i=0;i<4;i++){ const v = lo+(hi-lo)*(i+.5)/4, y = Y(v).toFixed(1); grid += `<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${L-8}" y="${y}" dy="4" class="ch-y" text-anchor="end">${sgn(v)}</text>`; }
  const short = x1-x0 < 2*864e5;
  [0,.5,1].forEach(f=>{ const x = x0+(x1-x0)*f; grid += `<text x="${X(x).toFixed(1)}" y="${H-8}" class="ch-y" text-anchor="${f===0?"start":f===1?"end":"middle"}">${short?dtLabel(x):dLabel(x)}</text>`; });
  const path = s=>s.ys.map((y,i)=>(i ? `L${X(pts[i].x).toFixed(1)} ${Y(s.ys[i-1]).toFixed(1)} L` : "M")+`${X(pts[i].x).toFixed(1)} ${Y(y).toFixed(1)}`).join(" ");
  S.plChart = {pts, series, X, Y, W, L, R, T, B, H, x0, x1, sgn};
  const ranges = [["1d","1D"],["1w","1W"],["1m","1M"],["all","All"]].map(([k,l])=>`<button data-plrange="${k}" aria-pressed="${(S.plRange||"all")===k}">${l}</button>`).join("");
  return `<div class="pl-head"><h3>Live P&amp;L</h3><div class="ranges">${ranges}</div></div>
    <div class="pl-box">
      <svg class="chart" data-mchart="pl" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profit and loss over time">
        ${grid}<line x1="${L}" x2="${W-R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="pl-zero"/>
        ${series.slice().reverse().map(s=>`<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="${s.w}" stroke-linejoin="round"/>`).join("")}
        ${series.map(s=>`<circle cx="${X(pts[pts.length-1].x).toFixed(1)}" cy="${Y(s.ys[s.ys.length-1]).toFixed(1)}" r="${s.w+1.5}" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`).join("")}
        <g class="hv" style="display:none"><line class="hv-l" y1="${T}" y2="${H-B}"/></g>
        <rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent"/>
      </svg>
      <div class="pl-tip" id="plTip" hidden></div>
      <div class="pl-legend">${series.map(s=>{ const v = s.ys[s.ys.length-1]; return `<span><i style="background:${s.color}"></i>${esc(s.name)} <b class="${cls(v)}">${sgn(v)}</b></span>`; }).join("")}</div>
      ${Object.keys(S.me.pos||{}).length > d.held.length ? `<p class="t-note">Showing your ${d.held.length} biggest positions. Total P&amp;L includes all of them.</p>` : ""}
    </div>`;
}
document.addEventListener("pointermove", e=>{
  const svg = e.target.closest && e.target.closest("svg[data-mchart]"), tip = document.getElementById("plTip"), c = S.plChart;
  document.querySelectorAll("svg[data-mchart] .hv").forEach(g=>{ if(!svg) g.style.display="none"; });
  if(!svg || !c || !tip){ if(tip) tip.hidden = true; return; }
  const r = svg.getBoundingClientRect(), vx = Math.min(Math.max((e.clientX-r.left)/r.width*c.W, c.L), c.W-c.R);
  const t = c.x0 + (vx-c.L)/(c.W-c.L-c.R)*(c.x1-c.x0);
  let i = 0; c.pts.forEach((p,k)=>{ if(p.x<=t) i = k; });
  const g = svg.querySelector(".hv"); g.style.display = ""; const ln = g.querySelector(".hv-l"); ln.setAttribute("x1",vx); ln.setAttribute("x2",vx);
  tip.hidden = false;
  tip.innerHTML = `<b>${esc((c.x1-c.x0)<2*864e5?dtLabel(t):dLabel(t))}</b>` + c.series.map(s=>`<span><i style="background:${s.color}"></i>${esc(s.name)} <b class="${cls(s.ys[i])}">${c.sgn(s.ys[i])}</b></span>`).join("");
  const box = svg.parentElement.getBoundingClientRect(), left = e.clientX - box.left;
  tip.style.left = Math.min(Math.max(8, left + 14), box.width - tip.offsetWidth - 8) + "px";
});

function portfolioHTML(){
  const nw = netWorth(S.me), r = nw/START_CASH-1;
  const pos = Object.entries(S.me.pos||{});
  const invested = nw - S.me.cash;
  const posRows = pos.map(([pid,ps])=>{
    const p = byId(pid), px = p?p.price:ps.avg, val = p ? liqValue(ps, p) : cost0(ps), cost = ps.sh*ps.avg, pl = val-cost;
    return `<tr><td><b>${esc(p?p.name:pid)}</b></td><td><span class="mine ${ps.side}" style="margin:0">${ps.side==="long"?"UP":"DOWN"}</span></td>
      <td class="r num">${ps.sh}</td><td class="r num">${fmt(ps.avg)}</td><td class="r num">${fmt(px)}</td><td class="r num">${fmt(val)}</td>
      <td class="r num ${cls(pl)}">${pl>=0?"+":""}${fmt(pl)}</td><td class="r"><button class="btn" data-open="${esc(pid)}" data-side="${ps.side}" ${!p?"disabled":""}>Trade</button></td></tr>`;
  }).join("");
  const names = {buy:"Bet up",sell:"Sold",short:"Bet down",cover:"Covered"};
  const logRows = (S.me.log||[]).slice(0,60).map(l=>`<tr><td class="num">${l.ts?esc(dtLabel(l.ts)):esc(l.t||"")}</td><td>${names[l.a]||esc(l.a)}</td><td>${esc(byId(l.pid)?.name||l.pid)}</td><td class="r num">${l.n}</td><td class="r num">${fmt(l.px)}</td></tr>`).join("");
  return `<div class="tiles">
      <div class="tile"><span class="label">Net worth</span><b>${fmt(nw)}</b></div>
      <div class="tile"><span class="label">Return</span><b class="${cls(r)}">${pct(r)}</b></div>
      <div class="tile"><span class="label">In positions</span><b>${fmt(invested)}</b></div>
      <div class="tile"><span class="label">Gold Bars</span><b>${fmt(S.me.cash)}</b></div>
    </div>
    ${plHTML()}
    <h3>Open positions</h3>
    ${pos.length? `<div class="tbl"><table><thead><tr><th>Player</th><th>Bet</th><th class="r">Shares</th><th class="r">Avg entry</th><th class="r">Market value</th><th class="r" title="Gold bars you would get by closing the position right now">If closed now</th><th class="r">P/L</th><th></th></tr></thead><tbody>${posRows}</tbody></table></div>`
      : `<div class="board"><div class="empty"><strong>No positions yet.</strong>Pick players on the Market tab and bet up or down. You start with ${fmt(START_CASH)} gold bars.</div></div>`}
    <h3>Trade history</h3>
    ${logRows? `<div class="tbl"><table><thead><tr><th>When</th><th>Action</th><th>Player</th><th class="r">Shares</th><th class="r">Avg price</th></tr></thead><tbody>${logRows}</tbody></table></div>` : `<p class="label" style="text-transform:none;letter-spacing:0">Your trades will show here.</p>`}`;
}

function leadersShell(){
  if(S.mode==="offline") return `<div class="board"><div class="empty"><strong>The leaderboard needs the live market.</strong>Check your connection and reload the page.</div></div>`;
  const s = curSeason;
  return `${s ? `<div class="season-head"><div><span class="label">${seasonOver() ? "Final standings" : "Season standings"}</span><h3>${esc(s.name)}</h3></div>
      <span class="label" style="text-transform:none;letter-spacing:0">${seasonOver() ? "Ended "+dtLabel(Date.parse(s.end))+"." : "Ends "+dtLabel(Date.parse(s.end))+" · "+daysLeft()}</span></div>` : ""}
    <div class="prize"><div><b>Prizes for the top traders every season</b>
      <p>Only traders with a linked Discord account can win. Link yours from your account (top right), join the Storm Exchange Discord, and winners are confirmed in ${S.discord?.claims ? `<b>${esc(S.discord.claims)}</b>` : "the prize claims channel"}.</p></div><span class="dc-slot"></span></div>
    <div class="tbl"><table><thead><tr><th>#</th><th>Trader</th><th class="r">Net worth</th><th class="r">Return</th><th>Biggest bet</th></tr></thead><tbody id="lbBody"><tr><td colspan="5" class="label">Loading traders…</td></tr></tbody></table></div>
    <p class="label" style="text-transform:none;letter-spacing:0;margin-top:10px">Net worth is calculated on the server from live market values. Everyone starts each season with ${fmt(START_CASH)} gold bars. Traders without a linked Discord are listed but can't win prizes.</p>
    ${pastHTML()}`;
}
function pastHTML(){
  const past = (curSeason?.past||[]).slice().reverse(); if(!past.length) return "";
  return `<h3 class="past-h">Past champions</h3><div class="past">${past.map(ps=>`<div class="past-card"><span class="label">${esc(ps.name)}</span>${(ps.top||[]).slice(0,3).map((t,i)=>
    `<div class="pc-row"><span class="rk m${i+1}">${i+1}</span><b>${esc(t.tag||"Trader")}</b>${t.discord ? `<span class="dc">@${esc(t.discord)}</span>` : ""}<span class="num">${fmt(t.nw)}</span></div>`).join("")}</div>`).join("")}</div>`;
}
function fillLeaders(){
  const body = document.getElementById("lbBody"); if(!body) return;
  let rows;
  if(SIM.on){
    rows = Object.entries(S.portfolios).map(([id,pf])=>({id, pf, nw:netWorth(pf), name:pf.tag, discord:pf.discord, avatar:null, ok:true}));
    rows.push({id:"__me", pf:S.me, nw:netWorth(S.me), name:S.profile?.username || "You", discord:S.profile?.discord_username, avatar:S.profile?.discord_avatar, ok:true});
  } else rows = S.board.map(b=>({id:b.user_id, pf:S.portfolios[b.user_id] || (b.user_id===S.uid ? S.me : {pos:{}}), nw:Number(b.net_worth),
    name:b.username, discord:b.discord_username, avatar:b.discord_avatar, ok:b.prize_eligible}));
  if(!rows.length){ body.innerHTML = `<tr><td colspan="5"><div class="empty"><strong>No traders yet.</strong>Make the first trade to top the board.</div></td></tr>`; return; }
  rows.sort((a,b)=>(b.ok - a.ok) || b.nw - a.nw);
  body.innerHTML = ""; let rank = 0;
  rows.forEach((t,i)=>{
    const isMe = t.id===S.uid || t.id==="__me";
    const rk = t.ok ? ++rank : 0;
    if(SIM.on && i >= 100 && !isMe) return;   // the test run shows the top 100 bots plus you
    const big = Object.entries(t.pf.pos||{}).map(([pid,pos])=>({pid,pos,v:posValue(pos,byId(pid)?.price??pos.avg)})).sort((a,b)=>b.v-a.v)[0];
    const r = t.nw/START_CASH-1;
    const tr = document.createElement("tr"); tr.className = [isMe ? "lb-me" : "", t.ok ? "" : "lb-flag"].join(" ").trim();
    tr.innerHTML = `<td class="${rk && rk<=3?"medal":"num"}">${rk || "—"}</td><td><img class="av" alt=""><span class="nm"></span><span class="dc" hidden></span>${t.ok ? "" : `<span class="flag" title="Link Discord to be eligible for prizes">No Discord</span>`}</td><td class="r num">${fmt(t.nw)}</td><td class="r num ${cls(r)}">${pct(r)}</td><td>${big?`<span class="mine ${big.pos.side}" style="margin:0 6px 0 0">${big.pos.side==="long"?"UP":"DOWN"}</span>${esc(byId(big.pid)?.name||big.pid)}`:`<span class="label" style="text-transform:none;letter-spacing:0">All gold bars</span>`}</td>`;
    const img = tr.querySelector("img"), src = dcAvatar({avatar:t.avatar, discord:t.discord, tag:t.name});
    if(src){ img.classList.add("dav"); img.src = src; img.onerror = ()=>img.remove(); } else img.remove();
    tr.querySelector(".nm").textContent = (t.name || "Trader") + (isMe ? " (you)" : "");
    if(t.discord){ const dc = tr.querySelector(".dc"); dc.hidden = false; dc.textContent = "@" + t.discord; dc.title = "Discord (verified): " + t.discord; }
    body.appendChild(tr);
  });
}

/* ---------- player card + ticket ---------- */
function openTicket(id, side){
  const cur = S.me.pos[id];
  S.ticket = {id, side: cur ? cur.side : (side || "long"), qty: 1, msg:""}; S.formOpen = null;
  renderTicket();
  setTimeout(()=>document.getElementById(side ? "qtyIn" : "tkClose")?.focus(), 30);
}
function closeTicket(){ S.ticket=null; renderTicket(); }

function renderTicket(){
  const root = document.getElementById("ticketRoot");
  const t = S.ticket; const p = t && byId(t.id);
  if(!t || !p){ root.innerHTML=""; return; }
  const scroll = root.querySelector(".ticket")?.scrollTop || 0;
  const cur = S.me.pos[p.id];
  const q = Math.max(0, Math.floor(t.qty||0));
  const opening = !cur || cur.side===t.side;
  const mx = opening ? maxOpen(p, t.side) : cur.sh;
  const s = sentiment()[p.id] || {long:0,short:0};

  const mPts = clip(marketSeries(p), S.range);
  const mChg = (mPts[mPts.length-1].y - mPts[0].y)/mPts[0].y;
  const rangeName = {all:"since IPO","1m":"past month","1w":"past week","1d":"past day"}[S.range];
  const prPts = prSeries(p);
  const prChg = prPts.length ? (prPts[prPts.length-1].y - prPts[0].y)/prPts[0].y : 0;

  let preview = "";
  if(opening && q>0){
    const qt = quote(t.side==="long"?"buy":"short", p, q);
    preview = `<span>${t.side==="long"?"Cost":"Stake"}</span><span>${fmt(qt.total)}</span>
      <span>Avg price per share</span><span>${fmt(qt.total/q)}</span>
      <span>Market value after your trade</span><span class="${t.side==="long"?"up":"down"}">${fmt(qt.after)}</span>
      <span>Gold bars after</span><span>${fmt(S.me.cash-qt.total)}</span>`;
  } else if(!opening){
    preview = `<span>You hold a ${cur.side==="long"?"bet up":"bet down"}</span><span>${cur.sh} sh</span><span>Switching sides</span><span>Close it first</span>`;
  }
  if(cur && q>0){
    const n = Math.min(q,cur.sh), qt = quote(cur.side==="long"?"sell":"cover", p, n);
    const back = cur.side==="long" ? qt.total : Math.max(0, 2*cur.avg*n - qt.total);
    preview += `<span>Closing ${n} sh returns</span><span>${fmt(back)}</span>`;
  }

  root.innerHTML = `<div class="scrim" id="scrim"><div class="ticket" role="dialog" aria-modal="true" aria-labelledby="tkName">
    <div class="t-head"><div><span class="label">${esc(p.region)}${p.note?" · "+esc(p.note):""}</span><h2 id="tkName">${esc(p.name)}</h2></div><button class="x" id="tkClose" aria-label="Close">×</button></div>

    <div class="t-sec">
      <div class="t-top">
        <div><span class="label">Market value</span>
          <div class="t-price"><b>${fmt(p.price)}</b><span class="num ${cls(mChg)}">${pct(mChg)} ${rangeName}</span></div></div>
        <div class="ranges" role="group" aria-label="Chart range">${[["1d","1D"],["1w","1W"],["1m","1M"],["all","All"]].map(([k,l])=>`<button data-range="${k}" aria-pressed="${S.range===k}">${l}</button>`).join("")}</div>
      </div>
      ${chart("mkt", mPts, {fmtY:v=>fmt(v), color:tone(mChg), label:p.name+" market value chart"})}
      <p class="t-note">IPO price ${fmt(p.open)} · ${s.long} betting up · ${s.short} betting down${cur?` · You hold <b class="${cur.side==="long"?"up":"down"}">${cur.sh} ${cur.side==="long"?"UP":"DOWN"}</b> @ ${fmt(cur.avg)}`:""}</p>
    </div>

    ${shockHTML(p)}
    ${prPts.length ? `<div class="t-sec pr">
      <div class="t-top"><div><span class="label">Storm Rating</span>
        <div class="t-price small"><b>${fmt(p.pr)}</b><span class="num ${cls(prChg)}">${pct(prChg)} since listing</span></div></div></div>
      ${chart("pr", prPts, {fmtY:v=>v>=1000?Math.round(v/1000)+"k":fmt(v), color:cssVar("--gold"), h:140, label:p.name+" Storm Rating chart"})}
      <p class="t-note">Calculated daily from FNCS, Div Cup, Victory Cup and Performance Evaluation results over the past year. It doesn't move the market value.</p>
    </div>` : ""}

    ${formHTML(p)}

    <div class="seg" role="group" aria-label="Direction">
      <button class="l" data-tside="long" aria-pressed="${t.side==="long"}">Bet up · long</button>
      <button class="s" data-tside="short" aria-pressed="${t.side==="short"}">Bet down · short</button>
    </div>
    <label class="label" for="qtyIn">Shares</label>
    <div class="qty" style="margin-top:6px">
      <button class="btn" data-q="-1" aria-label="One fewer">−</button>
      <input id="qtyIn" type="number" min="1" step="1" value="${q||""}" inputmode="numeric">
      <button class="btn" data-q="1" aria-label="One more">+</button>
      <button class="btn" data-qmax="1">Max ${mx}</button>
    </div>
    ${preview?`<div class="preview">${preview}</div>`:""}
    <p class="msg" id="tkMsg" role="status">${esc(t.msg)}</p>
    <div class="t-acts">
      ${opening ? `<button class="btn gold" id="tkGo" ${S.saving?"disabled":""}>${t.side==="long"?"Bet up":"Bet down"} on ${q||0} share${q===1?"":"s"}</button>` : ""}
      ${cur ? `<button class="btn" id="tkClosePos" ${S.saving?"disabled":""}>${cur.side==="long"?"Sell":"Cover"} ${Math.min(q,cur.sh)||0}</button>` : ""}
    </div>
  </div></div>`;
  const tk = root.querySelector(".ticket"); if(tk) tk.scrollTop = scroll;
}

/* ---------- recent tournaments (from Osirion) ---------- */
const medal = n => n===1 ? " m1" : n===2 ? " m2" : n===3 ? " m3" : "";
const ord = n => n + (n%100>=11&&n%100<=13 ? "th" : ({1:"st",2:"nd",3:"rd"}[n%10]||"th"));
function shockHTML(p){
  const list = seasonShocks().filter(s=>s.pid===p.id).sort((a,b)=>b.ts-a.ts);
  if(!list.length) return "";
  const mv = S.tierMove && S.tierMove[p.id];
  return `<div class="t-sec"><span class="label">Tournament price moves this season</span>${mv ? `<p class="t-note tmv-note"><b class="${S.tierOf[p.id] > mv.from ? "down" : "up"}">${S.tierOf[p.id] > mv.from ? "↓ Moved down" : "↑ Moved up"} to Tier ${S.tierOf[p.id]}</b> from Tier ${mv.from} after ${esc(mv.why)}. Their Div Cup percentages now follow Tier ${S.tierOf[p.id]}.</p>` : ""}<ul class="shocks">${list.map(s=>
    `<li><b class="num ${s.f>1?"up":"down"}">${pct(s.f-1)}</b><span>${esc(s.why)}</span><span class="label">${dLabel(s.ts)}</span></li>`).join("")}</ul></div>`;
}
function formHTML(p){
  const f = p.form; if(!f) return "";
  const ev = f.ev || [];
  const upd = S.statsAt ? dtLabel(Date.parse(S.statsAt)) : f.updated ? dLabel(dayMs(f.updated)) : "";
  const home = p.region==="NA" ? "NAC" : p.region;
  if(!ev.length) return `<div class="t-sec form"><span class="label">Recent tournaments</span>
    <p class="t-note">No top-1,000 finishes in this season's FNCS, Solo Victory Cash Cups or Performance Evaluations yet.</p>
    <p class="t-note src">Source: Osirion · updated ${esc(upd)}</p></div>`;
  const best = Math.min(...ev.map(e=>e.rk));
  const avg = ev.reduce((a,e)=>a+e.rk,0)/ev.length;
  const wins = ev.reduce((a,e)=>a+e.w,0), m = ev.reduce((a,e)=>a+e.m,0), el = ev.reduce((a,e)=>a+e.el,0);
  const rows = ev.map((e,i)=>{
    const key = p.id+":"+i, open = S.formOpen===key, has = (e.mt||[]).length>0;
    return `<tr class="ev k-${esc(e.k)}${has?" can":""}${open?" open":""}" ${has?`data-form="${esc(key)}" tabindex="0" aria-expanded="${open}"`:""}>
      <td class="num">${has?`<span class="chev" aria-hidden="true">${open?"▾":"▸"}</span>`:""}${esc(dLabel(dayMs(e.t)))}</td>
      <td><span class="ek">${e.k==="div" ? `Div ${(e.e.match(/^Division (\d)/)||[,1])[1]} Cup` : {vc:"Victory Cup",fncs:"FNCS",pe:"Perf Eval"}[e.k]||""}</span>${esc(e.e.replace(/^Solo Victory Cup (\d)/,"Cup $1").replace(/^Division \d Cup, /,"").replace(/^FNCS Solos Qualifier, /,"Solos Qualifier, ").replace(/^Performance Evaluation (\d),/,"Session $1,"))}${e.team?` <span class="reg">TEAM</span>`:""}${e.r!==home?` <span class="reg">${esc(e.r)}</span>`:""}</td>
      <td class="r place${medal(e.rk)}">${ord(e.rk)}</td>
      <td class="r num">${e.k==="vc"?"–":fmt(e.pts)}</td>
      <td class="r num">${e.w}</td>
      <td class="r num">${e.el}</td>
      <td class="r num">${e.ap ?? "–"}</td></tr>
      ${open ? `<tr class="detail"><td colspan="7">${matchesHTML(e)}</td></tr>` : ""}`;
  }).join("");
  return `<div class="t-sec form">
    <span class="label">Recent tournaments</span>
    <div class="ftiles">
      <div><b>${ev.length}</b><span>events</span></div>
      <div><b>${ord(best)}</b><span>best finish</span></div>
      <div><b>${ord(Math.round(avg))}</b><span>avg finish</span></div>
      <div><b>${wins}</b><span>wins</span></div>
      <div><b>${m?(el/m).toFixed(1):"–"}</b><span>elims / game</span></div>
    </div>
    <div class="ftbl"><table><thead><tr><th>Date</th><th>Event</th><th class="r">Place</th><th class="r">Pts</th><th class="r">Wins</th><th class="r">Elims</th><th class="r">Avg place</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="t-note src">FNCS (Division 1–3 Cups and Qualifiers), Solo Victory Cash Cups and Performance Evaluations, top 1,000 finishes. Click an event for game-by-game stats. Source: Osirion · updated ${esc(upd)}</p>
  </div>`;
}

const mmss = s => Math.floor(s/60)+":"+String(Math.round(s%60)).padStart(2,"0");
function matchesHTML(e){
  // each game: [placement, elims, seconds alive, victory 0/1]
  const mt = e.mt || [];
  const alive = mt.reduce((a,m)=>a+m[2],0);
  const best = Math.min(...mt.map(m=>m[0]||999));
  const top10 = mt.filter(m=>m[0]>0 && m[0]<=10).length;
  const elimLbl = e.team ? "Team elims" : "Elims";
  // placement per game on a log scale: 1st at the top, worst at the bottom, top-10 band shaded
  const W=520, H=190, L=46, R=12, T=20, B=40;
  const maxPl = Math.max(e.team ? 33 : 100, ...mt.map(m=>m[0]||1));
  const Y = pl => T + Math.log(Math.max(1,pl))/Math.log(maxPl) * (H-T-B);
  const step = (W-L-R)/Math.max(1,mt.length), X = i => L + step*(i+.5);
  const ticks = [1,3,10,30,100].filter(t=>t<=maxPl);
  const pts = mt.map((m,i)=>[X(i), Y(m[0]||maxPl)]);
  const bars = `<svg class="pchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Placement in each game">
    <rect x="${L}" y="${T}" width="${W-L-R}" height="${(Y(10)-T).toFixed(1)}" class="pc-band"/>
    <text x="${W-R-4}" y="${T+12}" class="pc-band-t" text-anchor="end">TOP 10</text>
    ${ticks.map(t=>`<line x1="${L}" x2="${W-R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="pc-grid"/><text x="${L-8}" y="${Y(t).toFixed(1)}" dy="4" class="pc-ax" text-anchor="end">${ord(t)}</text>`).join("")}
    <polyline points="${pts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ")}" class="pc-line"/>
    ${mt.map((m,i)=>{ const [x,y]=pts[i], k = m[3]?"win":m[0]<=10?"t10":"rest";
      return `<g><title>Game ${i+1}: ${m[3]?"Victory Royale":ord(m[0])+" place"}, ${m[1]} ${e.team?"team ":""}elims, survived ${mmss(m[2])}</title>
        <rect x="${(x-step/2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${H-T}" fill="transparent"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${m[3]?8:6}" class="pc-dot ${k}"/>
        <text x="${x.toFixed(1)}" y="${(y-12).toFixed(1)}" class="pc-v${medal(m[0])}" text-anchor="middle">${m[3]?"WIN":m[0]}</text>
        <text x="${x.toFixed(1)}" y="${H-B+18}" class="pc-ax" text-anchor="middle">G${i+1}</text>
        <text x="${x.toFixed(1)}" y="${H-B+32}" class="pc-el" text-anchor="middle">${m[1]} el</text></g>`; }).join("")}
  </svg>
  <div class="pc-key"><span><i class="win"></i>Victory Royale</span><span><i class="t10"></i>Top 10</span><span><i class="rest"></i>Outside top 10</span><span>Below each game: <b class="el">eliminations</b></span></div>`;
  return `<div class="mdetail">
    <div class="mstats">
      <span><b>${mt.length}</b> games</span><span><b>${best<999?ord(best):"–"}</b> best placement</span>
      <span><b>${top10}</b> top-10s</span><span><b>${mmss(mt.length?alive/mt.length:0)}</b> avg survival</span>
      ${e.team?`<span>Team event · placement and elims are the team's</span>`:""}
    </div>
    ${bars}
    <table class="mtbl"><thead><tr><th>Game</th><th class="r">Placement</th><th class="r">${elimLbl}</th><th class="r">Survived</th></tr></thead>
    <tbody>${mt.map((m,i)=>`<tr><td>${i+1}</td><td class="r place${medal(m[0])}">${m[3]?"Victory Royale":ord(m[0])}</td><td class="r num">${m[1]}</td><td class="r num">${mmss(m[2])}</td></tr>`).join("")}</tbody></table>
  </div>`;
}

/* ---------- admin writes (server functions check that you're an admin) ---------- */
async function addPlayer(name, region, pr){
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || ("p"+Date.now());
  if(byId(id)){ toast(name+" is already listed."); return; }
  const {error} = await sb.rpc("admin_add_player", {p_id:id, p_name:name, p_region:region, p_pr:pr});
  if(error) return toast(niceErr(error));
  toast(name+" is listed at "+fmt(Math.round(pr/100))+"."); await loadAll(); derive(); render();
}

/* ---------- events ---------- */
document.addEventListener("click", e=>{
  const fr = e.target.closest("[data-form]");
  if(fr){ S.formOpen = S.formOpen===fr.dataset.form ? null : fr.dataset.form; renderTicket(); return; }
  const el = e.target.closest("button, #scrim");
  if(!el){ const row = e.target.closest("[data-row]"); if(row) openTicket(row.dataset.row); return; }
  if(el.id==="scrim"){ if(e.target.id==="scrim") closeTicket(); return; }
  if(el.id==="acct"){ showAuth(S.uid ? "account" : "login"); return; }
  if(el.dataset.auth){ showAuth(el.dataset.auth); return; }
  if(el.id==="dcLink"){ linkDiscord(); return; }
  if(el.id==="dcUnlink"){ unlinkDiscord(); return; }
  if(el.id==="lgOut"){ sb.auth.signOut().then(()=>{ S.showLogin = false; render(); toast("Logged out."); }); return; }
  if(el.dataset.sim){
    const a = el.dataset.sim;
    if(a==="start") simStart(); else if(a==="stop") simStop();
    else if(a==="pause" || a==="resume"){ SIM.paused = a==="pause"; SIM.last = 0; renderSim(); }
    else if(a==="mini"){ SIM.mini = !SIM.mini; renderSim(); }
    else if(a==="next"){ if(SIM.session){ simFinal(); SIM.clock = 0; } else { simSession(); SIM.clock = SIM_WEEK*.45; } derive(); render(); }
    return;
  }
  if(el.dataset.simspeed){ SIM.speed = +el.dataset.simspeed; renderSim(); return; }
  if(el.dataset.simbots){ const n = +el.dataset.simbots; if(n !== SIM.n){ simStop(true); simStart(n); } return; }
  if(el.id==="lgSkip"){ S.showLogin = false; render(); return; }
  if(el.dataset.tab){ S.tab = el.dataset.tab; render(); window.scrollTo(0,0); return; }
  if(el.dataset.heat){ S.heat = el.dataset.heat; render(); return; }
  if(el.dataset.goto){ document.getElementById(el.dataset.goto)?.scrollIntoView({behavior:"smooth"}); return; }
  if(el.dataset.region){ S.region = el.dataset.region; render(); return; }
  if(el.dataset.plrange){ S.plRange = el.dataset.plrange; render(); return; }
  if(el.dataset.evr){ S.evRegion = el.dataset.evr; try{ localStorage.setItem("stormex-evregion", S.evRegion); }catch(_){} renderEvents(); return; }
  if(el.dataset.tierf){ S.tier = +el.dataset.tierf; render(); return; }
  if(el.dataset.open){ openTicket(el.dataset.open, el.dataset.side); return; }
  const t = S.ticket; if(!t) return;
  const p = byId(t.id), cur = S.me.pos[t.id];
  if(el.dataset.range){ S.range = el.dataset.range; renderTicket(); return; }
  if(el.id==="tkClose"){ closeTicket(); return; }
  if(el.dataset.tside){ t.side = el.dataset.tside; t.msg=""; renderTicket(); return; }
  if(el.dataset.q){ t.qty = Math.max(1,(Math.floor(t.qty)||0)+Number(el.dataset.q)); renderTicket(); return; }
  if(el.dataset.qmax){ t.qty = Math.max(1, (!cur||cur.side===t.side) ? maxOpen(p,t.side) : cur.sh); renderTicket(); return; }
  if(el.id==="tkGo"){ runTrade(t.side==="long" ? "buy" : "short", t.qty); return; }
  if(el.id==="tkClosePos" && cur){ runTrade(cur.side==="long" ? "sell" : "cover", Math.min(t.qty, cur.sh)); return; }
});
document.addEventListener("input", e=>{
  if(e.target.id==="mkSearch"){ S.q = e.target.value; const pos = e.target.selectionStart; render(); const i = document.getElementById("mkSearch"); i.focus(); try{ i.setSelectionRange(pos,pos); }catch(_){} return; }
  if(e.target.id==="qtyIn" && S.ticket){ S.ticket.qty = Number(e.target.value)||0; const pos=e.target.selectionStart; renderTicket(); const i=document.getElementById("qtyIn"); i.focus(); try{i.setSelectionRange(pos,pos)}catch(_){} }
});
document.addEventListener("change", e=>{
  if(e.target.id==="sortSel"){ S.sort = e.target.value; render(); }
});
document.addEventListener("submit", e=>{
  if(e.target.id==="lgForm"){ e.preventDefault(); submitAuth(); return; }
  if(e.target.id==="seasonForm"){
    e.preventDefault(); const v = document.getElementById("seasonEnd").value, t = new Date(v);
    if(!v || isNaN(t)) return toast("Pick an end date and time.");
    sb.rpc("admin_set_season_end", {p_end:t.toISOString()}).then(({error})=>{ if(error) return toast(niceErr(error)); toast("Season end saved."); loadAll().then(()=>{ derive(); render(); }); });
    return;
  }
  if(e.target.id==="discordForm"){
    e.preventDefault();
    const invite = document.getElementById("dcInvite").value.trim(), claims = document.getElementById("dcClaims").value.trim().slice(0,32);
    const guild_id = document.getElementById("dcGuild").value.trim();
    if(invite && !DC_INVITE_RE.test(invite)) return toast("Use an invite link like https://discord.gg/yourserver");
    if(guild_id && !/^\d{17,20}$/.test(guild_id)) return toast("The server ID is a 17–20 digit number (right-click your server → Copy Server ID).");
    const value = {invite, claims, guild_id};
    sb.rpc("admin_set_meta", {p_key:"discord", p_value:value}).then(({error})=>{ if(error) return toast(niceErr(error)); S.discord = value; render(); loadDiscordWidget(); toast("Discord settings saved."); });
    return;
  }
  if(e.target.id!=="addForm") return; e.preventDefault();
  const name = document.getElementById("addName").value.trim(), region = document.getElementById("addRegion").value, pr = Math.round(Number(document.getElementById("addPrice").value));
  if(name && pr>0) addPlayer(name, region, pr);
});
document.addEventListener("keydown", e=>{
  if(e.key==="Escape" && !document.getElementById("loginRoot").hidden){ document.getElementById("lgSkip")?.click(); return; }
  if(e.key==="Escape" && S.ticket) closeTicket();
  const fr = e.target.closest && e.target.closest("[data-form]");
  if(fr && (e.key==="Enter"||e.key===" ")){ e.preventDefault(); const k=fr.dataset.form; fr.click(); document.querySelector(`[data-form="${k}"]`)?.focus(); }
});

let toastTimer;
function toast(msg){
  const r = document.getElementById("toastRoot");
  r.innerHTML = `<div class="toast" role="status"></div>`; r.firstChild.textContent = msg;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>r.innerHTML="", 3200);
}

/* ---------- heatmap: one treemap per region and tier, tile area grows with gains, color = change ---------- */
const HEAT = {ipo:"Market value since IPO", "1d":"Market value, past 24h", pr7:"Rating, past 7 days"};
function heatChange(p){
  if(S.heat==="1d"){ const s = clip(marketSeries(p), "1d"); return s[s.length-1].y/s[0].y - 1; }
  if(S.heat==="pr7"){ const h = prSeries(p); if(!h.length) return 0; const cut = Date.now()-7*864e5;
    const base = h.filter(q=>q.x<=cut).pop() || h[0]; return h[h.length-1].y/base.y - 1; }
  return p.price/p.open - 1;
}
function heatColor(c, max){
  const t = Math.min(1, Math.abs(c)/max), mid = [52,72,120], end = c>0 ? [22,170,82] : [214,46,66];
  if(Math.abs(c) < .0005) return `rgb(${mid})`;
  return `rgb(${mid.map((m,i)=>Math.round(m+(end[i]-m)*(.25+.75*t)))})`;
}
function heatHTML(){
  if(S.mode==="loading") return `<div class="board"><div class="empty"><strong>Opening the market…</strong>Loading player prices.</div></div>`;
  if(!S.players.length) return `<div class="board"><div class="empty"><strong>No players listed yet.</strong></div></div>`;
  const groups = [["NA","North America"],["EU","Europe"]];
  const other = [...new Set(S.players.map(p=>p.region))].filter(r=>r!=="NA"&&r!=="EU");
  for(const r of other) groups.push([r, r]);
  const changes = S.players.map(heatChange), max = Math.max(.05, ...changes.map(Math.abs));
  S.heatMax = max;
  return `<div class="tools">${Object.entries(HEAT).map(([k,l])=>`<button class="chip" data-heat="${k}" aria-pressed="${S.heat===k}">${l}</button>`).join("")}</div>
    <div class="hm-legend"><span class="t-down">−${(max*100).toFixed(0)}%</span><i style="background:linear-gradient(90deg,${heatColor(-max,max)},${heatColor(0,max)},${heatColor(max,max)})"></i><span class="t-up">+${(max*100).toFixed(0)}%</span><small>Tiles grow as a player gains and shrink as they drop · ↑↓ = moved tier on Div Cup form · click a tile for the player's chart</small></div>
    ${groups.map(([r,label])=>{ const ps = S.players.filter(p=>p.region===r).sort((a,b)=>(b.pr||0)-(a.pr||0)); if(!ps.length) return "";
      const summary = list=>{ const cs = list.map(heatChange), up = cs.filter(c=>c>.0005).length, dn = cs.filter(c=>c<-.0005).length, avg = cs.reduce((a,b)=>a+b,0)/cs.length;
        return `${list.length} pros · <b class="t-up">${up} up</b> · <b class="t-down">${dn} down</b> · avg <b class="${cls(avg)==="flat"?"":"t-"+cls(avg)}">${pct(avg)}</b>`; };
      const tiers = [[1,"Top 30 rating"],[2,"Rating rank 31–100"],[3,"Rating rank 101+"]].map(([t,sub])=>{ const list = ps.filter(p=>S.tierOf[p.id]===t); if(!list.length) return "";
        return `<div class="hm-tier"><div class="hm-thead"><span class="tier t${t}">T${t}</span><span class="tsub">${sub}</span><span class="tsum">${summary(list)}</span></div>
          <div class="hm-map" data-region="${esc(r)}" data-tier="${t}" style="height:0"></div></div>`; }).join("");
      return `<section class="hm-sec"><div class="hm-head"><h3>${esc(label)}</h3><span>${summary(ps)}</span></div>${tiers}</section>`; }).join("")}`;
}
// Tile size: IPO value (so stars stay a bit bigger) times a growth factor from the change shown.
// Gains grow a tile up to 3× (+50% or more), losses shrink it to no less than half, and no tile may
// exceed 4× the average tile or 12% of its map, so a runaway winner never hides everyone else.
function heatWeights(ps){
  let ws = ps.map(p=>{ const c = heatChange(p); return (p.open || p.price) * (c >= 0 ? Math.min(3, 1 + 4*c) : Math.max(.5, 1 + 2*c)); });
  for(let k=0; k<3; k++){
    const total = ws.reduce((a,b)=>a+b,0), cap = Math.min(4*total/ws.length, .12*total);
    if(ws.length < 3 || !ws.some(w=>w > cap)) break;
    ws = ws.map(w=>Math.min(w, cap));
  }
  return ws;
}
function squarify(items, x, y, w, h){
  const out = []; let rest = items.slice();
  while(rest.length){
    const side = Math.min(w,h); let row = [], best = Infinity;
    while(rest.length){ const cand = [...row, rest[0]], s = cand.reduce((a,b)=>a+b.a,0);
      const worst = Math.max(side*side*Math.max(...cand.map(c=>c.a))/(s*s), s*s/(side*side*Math.min(...cand.map(c=>c.a))));
      if(worst > best) break; best = worst; row = cand; rest.shift(); }
    const s = row.reduce((a,b)=>a+b.a,0);
    if(w >= h){ const cw = s/h; let cy = y; for(const r of row){ const ch = r.a/cw; out.push({...r, x, y:cy, w:cw, h:ch}); cy += ch; } x += cw; w -= cw; }
    else { const rh = s/w; let cx = x; for(const r of row){ const rw = r.a/rh; out.push({...r, x:cx, y, w:rw, h:rh}); cx += rw; } y += rh; h -= rh; }
  }
  return out;
}
function drawHeat(){
  document.querySelectorAll(".hm-map").forEach(m=>{
    const W = m.clientWidth; if(!W) return;
    const ps = S.players.filter(p=>p.region===m.dataset.region && S.tierOf[p.id]===+m.dataset.tier).sort((a,b)=>b.price-a.price);
    const H = Math.round((W < 600 ? W*1.15 : Math.max(300, W*.5)) * Math.max(1, Math.sqrt(ps.length/25))); m.style.height = H+"px";
    const ws = heatWeights(ps), total = ws.reduce((a,b)=>a+b,0);
    const tiles = squarify(ps.map((p,i)=>({p, a:ws[i]/total*W*H})).sort((a,b)=>b.a-a.a), 0, 0, W, H);
    m.innerHTML = tiles.map(({p,x,y,w,h})=>{ const c = heatChange(p), big = w>110 && h>70, mid = w>64 && h>40;
      return `<button class="hm-tile${big?" big":mid?"":" tiny"}" data-open="${esc(p.id)}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;background:${heatColor(c,S.heatMax)}" title="${esc(p.name)} · ${fmt(p.price)} · ${pct(c)}">
        <b>${tierArrow(p.id) ? `<i class="tmv" title="${esc(tierTitle(p))}">${tierArrow(p.id)}</i>` : ""}${esc(p.name)}</b>${mid?`<span class="pc">${pct(c)}</span>`:""}${big?`<span class="px">${fmt(p.price)}</span>`:""}</button>`; }).join("");
  });
}
let heatW = 0;
new ResizeObserver(es=>{ const w = Math.round(es[0].contentRect.width); if(w!==heatW){ heatW = w; if(S.tab==="heat") drawHeat(); } }).observe(document.getElementById("view"));

/* ---------- home ---------- */
function homeHTML(){
  const dots = [[12,"o"],[1,"w"],[6,"t"],[3,"t"],[24,"o"],[2,"t"],[9,"t"],[1,"w"]];
  return `<section class="hero">
    <canvas id="arena" aria-hidden="true"></canvas>
    <div class="hero-in">
      <div class="kick" id="hmKick">Pro player futures · Market open 24/7</div>
      <h2>Trade the <span>pros.</span></h2>
      <p>Back the pros you think are about to take over and bet against the ones you think will fall off. Every trade moves the price, and the market heats up every time a big tournament drops. Climb the leaderboard by calling it first.</p>
      <div class="ctas"><button class="btn gold" data-tab="market">Enter the market</button><button class="btn" data-goto="how">How it works</button><span class="dc-slot"></span></div>
      <div class="hstats"><div><b id="hmPlayers">—</b><span>pros listed</span></div><div><b id="hmTraders">—</b><span>traders</span></div><div><b id="hmTrades">—</b><span>trades made</span></div></div>
    </div>
  </section>
  <section class="dc-card wrap" id="dcCard" hidden></section>
  <section class="ev-wrap" id="events">
    <div class="ev-head"><h3>Upcoming events</h3><span>Prices move fastest around these. Times shown in your time zone.</span></div>
    <div class="tools" id="evChips"></div>
    <div class="ev-list" id="evList"><p class="ev-empty">Loading the schedule…</p></div>
  </section>
  <section class="how-wrap" id="how">
    <h3>How it works</h3>
    <p class="how-sub">Five things to know before your first trade.</p>
    <div class="steps">
      <div class="step"><span class="no">1</span><h4>Grab your gold bars</h4>
        <div class="demo d-bars"><div class="goldstack" aria-hidden="true"><i></i><i></i><i></i></div><div><b id="dmBars">25,000</b><span>gold bars</span></div></div>
        <p>Everyone starts with 25,000 gold bars. That's your whole bankroll for the season, so spread it smart.</p></div>
      <div class="step"><span class="no">2</span><h4>Bet up or bet down</h4>
        <div class="demo d-ud" aria-hidden="true"><div class="row2"><span class="btn long">▲ Up</span><span class="btn short">▼ Down</span></div><small>Pick a side on any pro</small></div>
        <p>Think a pro is about to pop off? Bet up. Think they're overhyped? Bet down. You hold one side per player at a time.</p></div>
      <div class="step"><span class="no">3</span><h4>The crowd sets the price</h4>
        <div class="demo d-price"><div><b id="dmPx">2,000</b><span class="act" id="dmAct">Market open</span></div><div id="dmSpark"></div></div>
        <p>Every <span class="impact">2,500</span> gold bars bought pushes a player up about 1%, and selling or shorting pulls them down. Get in early on the right pro and the crowd pays you. Div Cup Finals move prices too. Tier 1: top 5 +3.5%, 11th or worse −2.5%. Tier 2: top 15 +10%, 31st or worse −0.5%. Tier 3: top 20 +10%. Playing the week's Division 1 session but missing the Final costs 5% (T1), 1.25% (T2) or 0.35% (T3). Form moves tiers too: a bad result in each of the last 4 Finals drops a pro a tier, and an up finish in 3 of the last 4 lifts them one. FNCS Solo Qualifier rounds count as well: within each tier, the top third of pros who played go up (T1 +3%, T2 +4%, T3 +5%) and the bottom third go down by the same amount.</p></div>
      <div class="step"><span class="no">4</span><h4>Scout their form</h4>
        <div class="demo d-form" aria-hidden="true">${dots.map(([n,k],i)=>`<i class="${k}" style="--i:${i}"><b class="${medal(n).trim()}">${k==="w"?"W":n}</b></i>`).join("")}</div>
        <p>Click any player for their market chart, Storm Rating, and game-by-game results from FNCS, Victory Cash Cups and Performance Evaluations.</p></div>
      <div class="step"><span class="no">5</span><h4>Climb the leaderboard</h4>
        <div class="demo" aria-hidden="true"><div class="lbd"><div class="r1"><span>Rival A</span><b>31,400</b></div><div class="r2"><span>Rival B</span><b>29,950</b></div><div class="you"><span>You</span><b>33,120</b></div></div></div>
        <p>Your net worth updates live as prices move. Sell into the hype after a big event or hold for the next one. The top traders when the season ends win prizes, claimed in our Discord, and then everyone restarts at 25,000.</p></div>
    </div>
    <div class="how-cta"><button class="btn gold" data-tab="market">Start trading</button><button class="btn" data-tab="leaders">See the leaderboard</button></div>
  </section>`;
}
function renderHome(){
  const root = document.getElementById("homeRoot");
  if(!root.dataset.built){ root.innerHTML = homeHTML(); root.dataset.built = "1"; startDemos(); }
  startArena(); updateHomeLive(); renderDcCard();
}
function updateTicker(){
  const t = document.getElementById("ticker");
  const items = S.players.slice().sort((a,b)=>b.price-a.price).map(p=>{ const c=(p.price-p.open)/p.open, k=cls(c);
    return `<span>${esc(p.name.toUpperCase())} <b>${fmt(p.price)}</b> <span class="t-${k}">${{up:"▲",down:"▼",flat:"–"}[k]} ${Math.abs(c*100).toFixed(1)}%</span></span>`; }).join("");
  const html = items ? items + items : `<span>Opening the market…</span>`;
  if(t.innerHTML !== html){ t.innerHTML = html; t.style.animationDuration = Math.max(40, S.players.length*1.6)+"s"; }
}
/* upcoming events: stored in the db doc meta/events as {events:[{t: ISO start, h: hours, name, k, r}]} */
function untilLabel(ms){
  const m = Math.round(ms/60000); if(m < 60) return `in ${m} min`;
  const h = Math.floor(m/60); if(h < 24) return `in ${h}h ${m%60}m`;
  const d = Math.floor(h/24); return `in ${d}d ${h%24}h`;
}
function renderEvents(){
  const el = document.getElementById("evList"); if(!el) return;
  const reg = S.evRegion || "All";
  document.getElementById("evChips").innerHTML = [["All","All regions"],["NA","NA"],["EU","EU"]].map(([k,l])=>`<button class="chip" data-evr="${k}" aria-pressed="${reg===k}">${l}</button>`).join("");
  if(!S.events){ el.innerHTML = `<p class="ev-empty">${S.mode==="offline" ? "The schedule couldn't load. Check your connection and reload." : "Loading the schedule…"}</p>`; return; }
  const now = Date.now();
  const list = S.events.map(e=>({...e, s:Date.parse(e.t), end:Date.parse(e.t)+(e.h||3)*36e5})).filter(e=>e.end>now && (reg==="All" || (reg==="NA" ? /^NA/.test(e.r) : e.r===reg))).sort((a,b)=>a.s-b.s).slice(0,8);
  if(!list.length){ el.innerHTML = `<p class="ev-empty">No ${reg==="All"?"":reg+" "}events scheduled right now. Check back soon.</p>`; return; }
  const tag = {fncs:"FNCS", vc:"Victory Cup", pe:"Perf Eval", div:"Div Cup"};
  el.innerHTML = list.map(e=>{ const d = new Date(e.s), live = e.s<=now;
    return `<div class="ev-card ev-${esc(e.k)}${live?" live":""}">
      <div class="ev-date"><b>${d.toLocaleDateString("en-US",{day:"numeric"})}</b><span>${d.toLocaleDateString("en-US",{month:"short"})}</span></div>
      <div class="ev-body"><div><span class="ek">${esc(tag[e.k]||"Event")}</span><span class="reg">${esc(e.r)}</span></div>
        <b class="ev-name">${esc(e.name)}</b>
        <span class="ev-when">${d.toLocaleDateString("en-US",{weekday:"short"})} · ${d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}</span></div>
      <div class="ev-cd">${live ? `<span class="ev-live">● LIVE</span>` : esc(untilLabel(e.s-now))}</div></div>`; }).join("");
}
setInterval(()=>{ if(S.tab==="home") renderEvents(); }, 60000);
function updateHomeLive(){
  renderEvents();
  if(!document.getElementById("hmPlayers")) return;
  const traders = new Set(Object.keys(S.portfolios)); if(S.uid && Object.keys(S.me.pos).length) traders.add(S.uid);
  document.getElementById("hmPlayers").textContent = S.players.length || "—";
  document.getElementById("hmTraders").textContent = traders.size;
  document.getElementById("hmTrades").textContent = fmt(Object.values(allPortfolios()).reduce((a,pf)=>a+(pf.log||[]).length, 0));
}
function startDemos(){
  let N = 0; const series = Array.from({length:24}, ()=>({y:2000}));
  const step = ()=>{
    if(S.tab!=="home") return;
    const px = document.getElementById("dmPx"); if(!px) return;
    const buy = Math.random() < .58, n = 1 + Math.floor(Math.random()*3);
    N = Math.max(-30, Math.min(30, N + (buy ? n : -n)));
    const v = priceAt({open:2000}, N); series.push({y:v}); series.shift();
    px.textContent = fmt(v); px.className = buy ? "up" : "down";
    const a = document.getElementById("dmAct"); a.textContent = `${buy?"+":"−"}${n} share${n>1?"s":""} ${buy?"bought":"sold"}`;
    a.className = "act " + (buy ? "up" : "down"); a.style.animation = "none"; void a.offsetWidth; a.style.animation = "";
    document.getElementById("dmSpark").innerHTML = spark(series, 240, 64, tone(v/2000-1));
  };
  step();
  setInterval(step, 1300);
  const bars = document.getElementById("dmBars");
  if("IntersectionObserver" in window) new IntersectionObserver(es=>es.forEach(e=>{
    if(!e.isIntersecting) return; const t0 = performance.now();
    const tick = now=>{ const k = Math.min(1,(now-t0)/1400); bars.textContent = fmt(25000*(1-Math.pow(1-k,3))); if(k<1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), {threshold:.6}).observe(bars);
}

/* ---------- arena background: an original animated LAN-final scene drawn on canvas ---------- */
const AR = {raf:0, last:0, next:3, conf:[]};
function seedArena(){
  const {w,h} = AR, R = Math.random;
  AR.dots = Array.from({length:Math.round(w/3)}, ()=>({x:R()*w, y:h*(.26+R()*.26), r:.6+R()*1.3, ph:R()*7, sp:.6+R()*2.4, hue:[190,270,45,0][Math.floor(R()*4)]}));
  AR.haze = Array.from({length:14}, ()=>({x:R()*w, y:h*(.3+R()*.5), r:60+R()*140, vx:(R()-.5)*8}));
  AR.crowd = [0,1,2].map(row=>{ const s = 13+row*7, y = h*(.80+row*.085), out=[];
    for(let x=-s; x<w+s; x+=s*1.55) out.push({x:x+R()*s*.5, y, s, ph:R()*7, f:2+R()*3, arm:R()<.14, side:R()<.5?-1:1});
    return out; });
}
function startArena(){
  const c = document.getElementById("arena"); if(!c || AR.raf) return;
  AR.ctx = c.getContext("2d");
  const fit = ()=>{ const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio||1);
    if(!r.width) return; AR.w = r.width; AR.h = r.height; c.width = r.width*d; c.height = r.height*d; AR.ctx.setTransform(d,0,0,d,0,0); seedArena(); drawArena(AR.last||0); };
  if(!AR.ro){ AR.ro = new ResizeObserver(fit); AR.ro.observe(c); }
  fit();
  const loop = ts=>{ drawArena(ts/1000); AR.raf = requestAnimationFrame(loop); };
  AR.raf = requestAnimationFrame(loop);
}
function stopArena(){ if(AR.raf) cancelAnimationFrame(AR.raf); AR.raf = 0; }
function drawArena(t){
  const x = AR.ctx, w = AR.w, h = AR.h; if(!x || !w || !AR.dots) return;
  const dt = Math.min(.05, t - (AR.last||t)); AR.last = t;
  let g = x.createLinearGradient(0,0,0,h); g.addColorStop(0,"#03081d"); g.addColorStop(.55,"#0a1c52"); g.addColorStop(1,"#0c2766");
  x.globalCompositeOperation = "source-over"; x.fillStyle = g; x.fillRect(0,0,w,h);
  // stands: phone lights twinkling around the bowl
  for(const d of AR.dots){ const a = .18 + .4*(.5+.5*Math.sin(t*d.sp+d.ph)); x.fillStyle = `hsla(${d.hue},95%,${d.hue?72:96}%,${a})`; x.fillRect(d.x, d.y, d.r, d.r); }
  // main screen + side screens, focal point on the right
  const cx = w*.64, sw = Math.min(w*.42, 560), sh = sw*.5, sy = h*.1;
  const screen = (X, Y, W, H, title, sub)=>{
    x.save(); x.shadowColor = "rgba(155,77,255,.8)"; x.shadowBlur = 40;
    const sg = x.createLinearGradient(X, Y, X+W, Y+H); sg.addColorStop(0,"#2a1170"); sg.addColorStop(.5,"#5b2bd6"); sg.addColorStop(1,"#1450c8");
    x.fillStyle = sg; x.fillRect(X, Y, W, H); x.restore();
    x.strokeStyle = "rgba(255,255,255,.25)"; x.lineWidth = 2; x.strokeRect(X, Y, W, H);
    const scan = Y + ((t*50) % H); x.fillStyle = "rgba(255,255,255,.08)"; x.fillRect(X, scan, W, H*.06);
    x.fillStyle = "#fff"; x.textAlign = "center"; x.font = `${Math.round(H*.2)}px Anton, Impact, sans-serif`; x.fillText(title, X+W/2, Y+H*.42);
    if(sub){ x.font = `${Math.round(H*.09)}px "Oswald", sans-serif`; x.fillStyle = "rgba(255,255,255,.75)"; x.fillText(sub, X+W/2, Y+H*.58); }
    return scan;
  };
  screen(cx-sw/2, sy, sw, sh, "GRAND FINALS", "GAME 6 OF 12");
  // live leaderboard bars on the main screen
  for(let i=0;i<4;i++){ const by = sy+sh*(.66+i*.075), bw = sw*.5*(.55+.45*Math.abs(Math.sin(t*.35+i*1.7)));
    x.fillStyle = ["#ffd54a","#dfe7f0","#e8955a","#3ee0ff"][i]; x.globalAlpha = .85; x.fillRect(cx-sw*.25, by, bw, sh*.045); x.globalAlpha = 1; }
  x.fillStyle = `rgba(255,70,90,${.5+.5*Math.sin(t*4)})`; x.beginPath(); x.arc(cx-sw/2+18, sy+16, 5, 0, 7); x.fill();
  x.font = `600 ${Math.round(sh*.07)}px Oswald, sans-serif`; x.textAlign = "left"; x.fillStyle = "#fff"; x.fillText("LIVE", cx-sw/2+28, sy+21);
  const ssw = sw*.42, ssh = ssw*.56;
  screen(cx-sw/2-ssw-24, sy+sh*.18, ssw, ssh, "STORM EX", null);
  if(cx+sw/2+24 < w) screen(cx+sw/2+24, sy+sh*.18, ssw, ssh, "STORM EX", null);
  // lighting truss + sweeping spotlights
  x.fillStyle = "#1a2442"; x.fillRect(0, h*.035, w, 5);
  x.globalCompositeOperation = "lighter";
  const cols = ["62,224,255","155,77,255","255,200,61"];
  for(let i=0;i<7;i++){
    const lx = w*(.14+i*.13), ly = h*.04, a = Math.PI/2 + Math.sin(t*.55+i*1.3)*.5, len = h*1.05, spread = .11;
    const lg = x.createRadialGradient(lx, ly, 0, lx, ly, len); lg.addColorStop(0,`rgba(${cols[i%3]},.32)`); lg.addColorStop(1,`rgba(${cols[i%3]},0)`);
    x.fillStyle = lg; x.beginPath(); x.moveTo(lx, ly); x.lineTo(lx+Math.cos(a-spread)*len, ly+Math.sin(a-spread)*len); x.lineTo(lx+Math.cos(a+spread)*len, ly+Math.sin(a+spread)*len); x.closePath(); x.fill();
    x.fillStyle = `rgba(${cols[i%3]},.95)`; x.beginPath(); x.arc(lx, ly+4, 4, 0, 7); x.fill();
  }
  // haze
  for(const p of AR.haze){ p.x += p.vx*dt; if(p.x < -p.r) p.x = w+p.r; if(p.x > w+p.r) p.x = -p.r;
    const hg = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); hg.addColorStop(0,"rgba(120,150,255,.06)"); hg.addColorStop(1,"rgba(120,150,255,0)"); x.fillStyle = hg; x.fillRect(p.x-p.r, p.y-p.r, p.r*2, p.r*2); }
  x.globalCompositeOperation = "source-over";
  // stage with player pods and an LED front edge
  const st = h*.6, sb = h*.69, sl = w*.26, sr = w*1.02;
  const stg = x.createLinearGradient(0, st, 0, sb); stg.addColorStop(0,"#16337d"); stg.addColorStop(1,"#07163f");
  x.fillStyle = stg; x.beginPath(); x.moveTo(sl+30, st); x.lineTo(sr-10, st); x.lineTo(sr, sb); x.lineTo(sl, sb); x.closePath(); x.fill();
  x.fillStyle = `hsl(${(t*40)%360},90%,60%)`; x.fillRect(sl, sb-3, sr-sl, 3);
  const pods = 10;
  for(let i=0;i<pods;i++){ const px = sl+40+i*((sr-sl-80)/(pods-1)), py = st-2;
    x.fillStyle = "#050c26"; x.fillRect(px-11, py-12, 22, 12);
    x.fillStyle = `rgba(62,224,255,${.55+.35*Math.sin(t*3+i)})`; x.fillRect(px-8, py-24, 16, 10);
    x.fillStyle = "#03081d"; x.beginPath(); x.arc(px, py-16, 4.5, 0, 7); x.fill(); }
  // crowd silhouettes, back rows first
  for(const row of AR.crowd) for(const p of row){
    const bob = Math.max(0, Math.sin(t*p.f+p.ph))*p.s*.35, y = p.y-bob, s = p.s;
    x.fillStyle = "#020717";
    x.beginPath(); x.arc(p.x, y-s*.95, s*.42, 0, 7); x.fill();
    x.beginPath(); x.moveTo(p.x-s*.75, y+s*.9); x.quadraticCurveTo(p.x-s*.75, y-s*.45, p.x, y-s*.5); x.quadraticCurveTo(p.x+s*.75, y-s*.45, p.x+s*.75, y+s*.9); x.fill();
    if(p.arm){ const ax = p.x+p.side*s*.55, ay = y-s*1.9-Math.sin(t*p.f*1.3+p.ph)*s*.25;
      x.strokeStyle = "#020717"; x.lineWidth = s*.22; x.lineCap = "round"; x.beginPath(); x.moveTo(p.x+p.side*s*.4, y-s*.3); x.lineTo(ax, ay); x.stroke();
      x.fillStyle = "rgba(255,255,255,.9)"; x.fillRect(ax-2, ay-6, 4, 6); }
  }
  // confetti bursts every few seconds
  if(t > AR.next){ AR.next = t + 5 + Math.random()*4; const ox = w*(.45+Math.random()*.45);
    for(let i=0;i<70;i++) AR.conf.push({x:ox+(Math.random()-.5)*w*.3, y:-10-Math.random()*h*.2, vx:(Math.random()-.5)*40, vy:40+Math.random()*60, r:Math.random()*6, vr:(Math.random()-.5)*8, c:["#ffd54a","#3ee0ff","#9b4dff","#ffffff","#62f58c"][i%5]}); }
  AR.conf = AR.conf.filter(c=>c.y < h+20);
  for(const c of AR.conf){ c.x += c.vx*dt; c.y += c.vy*dt; c.r += c.vr*dt;
    x.save(); x.translate(c.x, c.y); x.rotate(c.r); x.fillStyle = c.c; x.fillRect(-3, -1.5, 6, 3); x.restore(); }
}

/* ---------- test-run simulator (owner only) ----------
   1,000 bot traders with different strategies plus mock Division 1 Div Cup weeks (a session, then a Final
   that applies the real Div Cup price-move rules). Everything lives in this browser tab: nothing is saved,
   and real database updates are parked in SIM.real until the simulator stops. */
const SIM = {on:false, paused:false, speed:1, timer:null, real:null, clock:0, week:0, session:null,
  feed:[], form:{}, trades:0, prev:{}, prevAt:0, movers:null, moversAt:0, lastRender:0};
const SIM_WEEK = 40000;   // one Div Cup week per 40 seconds at 1x
const SIM_TYPES = {momentum:"Momentum", contrarian:"Contrarian", fan:"Fan", underdog:"Underdog hunter", hype:"Result chaser", random:"Gut feel", value:"Value hunter"};
const SIM_MIX = ["momentum","contrarian","fan","underdog","hype","random","value","value"];   // value hunters are 2 in 8
const SIM_W1 = ["Storm","Crank","Loot","Zone","Box","Edit","Cracked","Tilted","Sweaty","Clutch","Rotate","Mats","Peak","Snipe","Bus","Victory"];
const SIM_W2 = ["King","Goblin","Wizard","Gremlin","Diff","Merchant","Enjoyer","Demon","Farmer","Hawk","Shark","Bandit","Rat","Legend"];
const pick = a => a.length ? a[Math.random()*a.length|0] : undefined;
const gauss = () => Math.sqrt(-2*Math.log(1-Math.random())) * Math.cos(2*Math.PI*Math.random());
// skill: 90% a pro's real Division 1 Final record over the past year, 10% rating (meta/simskill, fitted offline).
// Pros without a fitted value fall back to their rating alone. Upsets still happen through the per-round noise.
const skill = p => SIM.skill && SIM.skill[p.id] != null ? SIM.skill[p.id] : (Math.log(Math.max(1000, p.pr||1000)) - 11.5) * .3;

function simStart(n){
  if(SIM.on || !S.players.length) return;
  SIM.real = {portfolios:S.portfolios, me:S.me, shocks:S.shocks};
  Object.assign(SIM, {on:true, paused:false, mini:innerHeight < 600, clock:0, week:0, session:null, feed:[], form:{}, trades:0, prev:{}, prevAt:0, movers:null, last:0, n:n || SIM.n || 10000});
  const season = curSeason ? curSeason.n : 0, types = SIM_MIX, pf = {};
  TB = null; SIM.depth = 250000 * Math.max(1, SIM.n/1000);   // depth grows with the crowd, as it will per season live
  if(!SIM.skill && S.simskill){ SIM.skill = S.simskill.skill; SIM.pop = S.simskill.pop || null; SIM.popW = null; }
  for(let i=0;i<SIM.n;i++){
    const tag = pick(SIM_W1) + pick(SIM_W2) + (i % 97);
    pf["sim"+i] = {cash:START_CASH, pos:{}, log:[], season, tag, discord:tag.toLowerCase(), bot:types[i % types.length]};
  }
  S.portfolios = pf;
  S.me = fresh();
  for(const k of ["tag","discord","pfp"]) if(!S.me[k]) delete S.me[k];
  S.shocks = {season, list:[]}; S.ticket = null;
  simFeed(`Simulation started: ${fmt(SIM.n)} bot traders, 25,000 gold bars each. Nothing here is saved.`);
  derive(); SIM.prev = priceMap(); SIM.prevAt = Date.now();
  if(S.tab==="home") S.tab = "market";
  document.body.classList.add("sim");
  clearInterval(SIM.timer); SIM.timer = setInterval(simStep, 250);
  render();
}
function simStop(quiet){
  if(!SIM.on) return;
  clearInterval(SIM.timer); SIM.on = false; TB = null;
  S.portfolios = SIM.real.portfolios; S.me = SIM.real.me; S.shocks = SIM.real.shocks; S.ticket = null;
  for(const p of S.players) if(p._realForm !== undefined) p.form = p._realForm;
  document.body.classList.remove("sim");
  derive(); render(); if(!quiet) toast("Simulation stopped. You're back on the live market.");
}
function priceMap(){ const m = {}; for(const p of S.players) m[p.id] = p.price; return m; }
function simFeed(msg){ SIM.feed.unshift({t:Date.now(), msg}); SIM.feed.length = Math.min(SIM.feed.length, 30); }

function simStep(){
  if(!SIM.on || SIM.paused) return;
  const ids = Object.keys(S.portfolios), now = Date.now();
  // the sim follows real elapsed time, so it keeps pace even when the browser throttles a background tab
  const dt = Math.min(2000, Math.max(0, now - (SIM.last || now)) || 250); SIM.last = now;
  // activity scales with the crowd: ~24 bot decisions a second per 1,000 bots at 1×, capped to keep the tab smooth
  for(let i = 0, k = Math.min(6000, Math.round(6*SIM.speed*SIM.n/1000 * dt/250)); i < k; i++) botAct(S.portfolios[pick(ids)]);
  SIM.clock += dt*SIM.speed;
  if(!SIM.session && SIM.clock >= SIM_WEEK*.45) simSession();
  if(SIM.clock >= SIM_WEEK){ simFinal(); SIM.clock = 0; }
  if(now - SIM.prevAt > 8000/SIM.speed){ SIM.prev = priceMap(); SIM.prevAt = now; }   // every 8 sim-seconds
  derive();
  if(now - SIM.lastRender > 1000){ SIM.lastRender = now; const a = document.activeElement; if(!(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) render(); else renderSim(); }
}

function moversNow(){   // players sorted by % change over the last ~8 seconds, refreshed once a second
  if(SIM.movers && Date.now() - SIM.moversAt < 1000) return SIM.movers;
  SIM.movers = S.players.slice().sort((a,b)=>(b.price/(SIM.prev[b.id]||b.price)) - (a.price/(SIM.prev[a.id]||a.price)));
  SIM.moversAt = Date.now(); return SIM.movers;
}
function botAct(pf){
  if(!pf) return;
  const held = Object.keys(pf.pos);
  if(held.length && Math.random() < .3){   // manage an open position: take profit, cut losses, or get bored
    const pid = pick(held), pos = pf.pos[pid], p = byId(pid); if(!p) return;
    const gain = pos.side==="long" ? p.price/pos.avg - 1 : 1 - p.price/pos.avg;
    if(gain > .06 || gain < -.08 || Math.random() < (pf.bot==="random" ? .4 : .1))
      simTrade(pf, pos.side==="long" ? "sell" : "cover", pid, Math.ceil(pos.sh*(.5 + Math.random()*.5)));
    return;
  }
  let p, side = "long";
  if(pf.bot==="momentum") p = pick(moversNow().slice(0, 12));
  else if(pf.bot==="contrarian"){ p = pick(moversNow().slice(0, 12)); side = "short"; }
  else if(pf.bot==="fan"){ p = popPick(5); side = Math.random() < .85 ? "long" : "short"; }   // fans back famous names (some bet against them)
  else if(pf.bot==="underdog") p = pick(S.players.filter(x=>S.tierOf[x.id]===3));
  else if(pf.bot==="hype"){ const s = pick(S.shocks.list.slice(-30)); if(!s) return; p = byId(s.pid); side = s.f > 1 ? "long" : "short"; }
  else if(pf.bot==="value"){   // fair value = IPO × Div Cup results; buy below it, short above it
    p = pick(S.players); const gap = p.price/(p.open*(p.m ?? 1)) - 1;
    if(Math.abs(gap) < .05) return; side = gap > 0 ? "short" : "long";
  }
  else { p = popPick(2); side = Math.random() < .5 ? "long" : "short"; }   // gut-feel bettors lean toward names they know
  if(!p || (pf.pos[p.id] && pf.pos[p.id].side !== side)) return;
  const n = Math.min(MAX_ORDER, Math.floor(pf.cash*(.04 + Math.random()*.12) / p.price));
  if(n >= 1) simTrade(pf, side==="long" ? "buy" : "short", p.id, n);
}
// Popularity (0–1, meta/simskill.pop): rating, past-year Finals record, team, plus a fame boost for the biggest names.
// Picks a pro with weight e^(k·popularity), so a superstar draws ~e^k times the bets of an unknown. Fallback: rating tier.
function popPick(k){
  if(!SIM.pop) return k > 3 ? pick(S.players.filter(x=>S.tierOf[x.id]===1)) : pick(S.players);
  const key = k + ":" + S.players.length;
  if(!SIM.popW || !SIM.popW[key]){
    let acc = 0; const cdf = S.players.map(p=>acc += Math.exp(k*(SIM.pop[p.id] || 0)));
    SIM.popW = Object.assign(SIM.popW || {}, {[key]: {cdf, ids:S.players.map(p=>p.id)}});
  }
  const w = SIM.popW[key], r = Math.random()*w.cdf[w.cdf.length-1];
  let lo = 0, hi = w.cdf.length-1; while(lo < hi){ const m = (lo+hi)>>1; if(w.cdf[m] < r) lo = m+1; else hi = m; }
  return byId(w.ids[lo]);
}
function simTrade(pf, action, pid, n){   // the same rules as a real trade, applied to a bot's portfolio
  const p = byId(pid); if(!p || !(n > 0)) return;
  const N = S.net[pid] || 0, q = dir(action) > 0 ? fill(p, N, n) : fill(p, N-n, n);
  if(!isFinite(q)) return;
  const cur = pf.pos[pid];
  if(action==="buy" || action==="short"){
    const side = action==="buy" ? "long" : "short";
    if(q > pf.cash) return;
    const sh = (cur ? cur.sh : 0) + n, avg = ((cur ? cur.sh*cur.avg : 0) + q) / sh;
    if(liqValue({side, sh, avg}, p, N + dir(action)*n) > MAX_POS*netWorth(pf)) return;
    pf.cash -= q; pf.pos[pid] = {side, sh, avg};
  } else {
    if(!cur || n > cur.sh) return;
    pf.cash += cur.side==="long" ? q : Math.max(0, 2*cur.avg*n - q);
    cur.sh -= n; if(!cur.sh) delete pf.pos[pid];
  }
  S.net[pid] = N + dir(action)*n; p.price = priceAt(p, S.net[pid]);
  const l = {ts:Date.now(), pid, a:action, n, px:q/n};
  pf.log.unshift(l);
  if(TB) (TB[pid] = TB[pid] || []).push(l);   // keep the chart index current instead of rebuilding it every tick
  SIM.trades++;
}

function simEv(p, name, rk, reg){   // a mock result row for the player's "Recent tournaments" list
  const games = Array.from({length:6}, ()=>{
    const pl = Math.min(100, Math.max(1, Math.round(Math.exp(Math.random()*Math.log(100)) * (.35 + rk/120))));
    return [pl, Math.round(Math.random()*(pl <= 10 ? 7 : 3)), 300 + Math.round(Math.random()*1200), pl===1 ? 1 : 0];
  });
  const ev = {id:"sim:"+name+reg, t:today(), e:name, k:"div", r:reg==="NA" ? "NAC" : reg, rk, team:false,
    pts:Math.max(0, 420 - rk*3 + Math.round(Math.random()*40)), m:games.length, w:games.reduce((a,g)=>a+g[3],0),
    el:games.reduce((a,g)=>a+g[1],0), ap:+(games.reduce((a,g)=>a+g[0],0)/games.length).toFixed(1), mt:games};
  const list = SIM.form[p.id] = SIM.form[p.id] || []; list.unshift(ev); list.length = Math.min(list.length, 30);
}
// Real Division 1 Div Cups are duos: ~700 teams (1,400 players) per region in a session and 50 teams (100 players)
// in the Final, and listed pros hold ~75% of Final spots. So every session and Final includes the unlisted rest
// of the field, and placements are team ranks (players 1–2 = #1). Skill model fitted to S42 Div 1 results.
const SIM_FIELD = 1400, SIM_FINAL = 100;
const fieldSkill = () => -2.2 + gauss()*.7;
const teamRank = i => Math.ceil((i+1)/2);
const who = x => x.p ? `${x.p.name} (T${S.tierOf[x.p.id] || 3})` : "an unlisted player";
function simSession(){
  SIM.week++; SIM.session = {};
  for(const reg of ["NA","EU"]){
    const pool = S.players.filter(p=>p.region===reg && Math.random() < .95);   // nearly every listed pro plays (real S42 sessions)
    const ents = pool.map(p=>({p, b:skill(p)}));
    for(let i = pool.length; i < SIM_FIELD; i++) ents.push({p:null, b:fieldSkill()});
    for(const e of ents) e.s = e.b + gauss()*.9;
    ents.sort((a,b)=>b.s-a.s);
    const fin = ents.slice(0, SIM_FINAL), listedQ = fin.filter(e=>e.p).length;
    SIM.session[reg] = {all:pool.map(p=>p.id), fin};
    ents.forEach((x,i)=>{ if(x.p) simEv(x.p, `Division 1 Cup, Session ${SIM.week} (sim)`, teamRank(i), reg); });
    simFeed(`${reg} Div Cup Session ${SIM.week}: ${fmt(SIM_FIELD)} players. ${listedQ} of ${pool.length} listed pros made the Final; the other ${SIM_FINAL - listedQ} spots went to the rest of the field. Session winners: ${who(ents[0])} & ${who(ents[1])}.`);
  }
}
function simFinal(){
  if(!SIM.session) return;
  const ts = Date.now();
  for(const reg of ["NA","EU"]){
    const ses = SIM.session[reg]; if(!ses) continue;
    const fin = ses.fin.map(e=>({p:e.p, s:e.b + gauss()*1.0})).sort((a,b)=>b.s-a.s);
    let up = 0, down = 0;
    fin.forEach((x,i)=>{
      if(!x.p) return;
      const rk = teamRank(i), t = S.tierOf[x.p.id] || 3, f = finalF(t, rk);
      simEv(x.p, `Division 1 Cup, Week ${SIM.week} Final (sim)`, rk, reg);
      if(!f) return;
      S.shocks.list.push({pid:x.p.id, ts, f, w:`sim-${SIM.week}-${reg}`, r:reg, k:f > 1 ? "top" : "bad", why:`#${rk} in the Div Cup Week ${SIM.week} Final (Tier ${t}) · simulated`});
      if(f > 1) up++; else down++;
    });
    const moves = [`Winners: ${who(fin[0])} & ${who(fin[1])}`, `${up} pros up, ${down} down on placement`];
    const made = new Set(ses.fin.filter(e=>e.p).map(e=>e.p.id)), miss = {1:0, 2:0, 3:0};
    for(const pid of ses.all){
      const t = S.tierOf[pid] || 3; if(made.has(pid)) continue;
      S.shocks.list.push({pid, ts, f:MISS_F[t], w:`sim-${SIM.week}-${reg}`, r:reg, k:"bad", why:`Missed the Div Cup Week ${SIM.week} Final (Tier ${t}) · simulated`}); miss[t]++;
    }
    simFeed(`${reg} Week ${SIM.week} Final: ${moves.join(" · ")}. Missed the Final: ${miss[1]} T1 (−5%), ${miss[2]} T2 (−1.25%), ${miss[3]} T3 (−0.35%).`);
  }
  SIM.session = null;
}

function renderSim(){
  const root = document.getElementById("simRoot");
  document.getElementById("simTab").hidden = !S.admin || SIM.on || S.mode==="offline";
  if(!SIM.on){ root.innerHTML = ""; return; }
  const left = Math.max(0, Math.ceil((SIM.session ? SIM_WEEK - SIM.clock : SIM_WEEK*.45 - SIM.clock) / 1000 / SIM.speed));
  const strat = {};
  for(const pf of Object.values(S.portfolios)){ const g = strat[pf.bot] = strat[pf.bot] || {n:0, r:0}; g.n++; g.r += netWorth(pf)/START_CASH - 1; }
  const rows = Object.entries(strat).map(([k,g])=>[SIM_TYPES[k], g.r/g.n]).sort((a,b)=>b[1]-a[1]);
  root.innerHTML = `<div class="simbar" role="region" aria-label="Simulation controls"><div class="in">
      <span class="stag">Test run</span>
      <span class="st">Week ${SIM.week || 1} · ${SIM.session ? "Final in "+left+"s" : "Session in "+left+"s"} · ${fmt(SIM.n)} bots ·${fmt(SIM.trades)} trades${SIM.paused ? " · paused" : ""}</span>
      <span class="ctl">
        <button class="btn" data-sim="${SIM.paused ? "resume" : "pause"}">${SIM.paused ? "Resume" : "Pause"}</button>
        ${[1,2,5,10].map(x=>`<button class="chip" data-simspeed="${x}" aria-pressed="${SIM.speed===x}">${x}×</button>`).join("")}
        <span class="chip-sep"></span>
        ${[1000,10000].map(x=>`<button class="chip" data-simbots="${x}" aria-pressed="${SIM.n===x}" title="Restart with ${fmt(x)} bots">${x/1000}k bots</button>`).join("")}
        <button class="btn" data-sim="next">Skip to ${SIM.session ? "Final" : "Session"}</button>
        <button class="btn" data-sim="mini">${SIM.mini ? "Show feed" : "Hide feed"}</button>
        <button class="btn short" data-sim="stop">Stop</button>
      </span></div>
    ${SIM.mini ? "" : `<div class="simfeed"><ol>${SIM.feed.slice(0, 5).map(f=>`<li>${esc(f.msg)}</li>`).join("")}</ol>
      <div class="simstrat"><span class="label">Avg return by strategy</span><span></span>${rows.map(([n,r])=>`<span>${esc(n)}</span><b class="num ${cls(r)}">${pct(r)}</b>`).join("")}</div></div>`}</div>`;
}

/* ---------- data: everything is read from Supabase (public, read-only); live updates arrive over realtime ---------- */
async function fetchAll(make){   // PostgREST returns at most 1,000 rows per request, so page through
  const out = [];
  for(let from = 0;; from += 1000){
    const {data, error} = await make().range(from, from + 999);
    if(error) throw error;
    out.push(...data); if(data.length < 1000) return out;
  }
}
async function loadAll(){
  const [pl, se, meta, snaps] = await Promise.all([
    fetchAll(()=>sb.from("players").select("*").eq("active", true).order("id")),
    sb.from("seasons").select("*").lte("start_at", new Date().toISOString()).order("n", {ascending:false}).limit(1),
    sb.from("site_meta").select("*"),
    sb.from("prsnaps").select("*").order("at", {ascending:false}).limit(200)]);
  if(se.error) throw se.error;
  S.players = pl.map(p=>({id:p.id, name:p.name, region:p.region, pr:p.pr, open:p.open, note:p.note || "", listed:p.listed,
    prHistory:p.pr_history || [], form:p.form ? {src:"Osirion", ...p.form} : null}));
  const r = se.data[0];
  curSeason = r ? {n:r.n, name:r.name, start:r.start_at, end:r.end_at, depth:Number(r.depth), ipo:r.ipo || {}, past:r.past || []} : null;
  const m = Object.fromEntries((meta.data || []).map(x=>[x.key, x.value]));
  S.events = m.events?.events || []; S.discord = m.discord || null; S.simskill = m.simskill || null; S.statsAt = m.stats?.at || null;
  loadDiscordWidget();
  S.prSnaps = (snaps.data || []).map(x=>({at:x.at, pr:x.pr, note:x.note})).sort((a,b)=>a.at.localeCompare(b.at));
  await refreshMarket();
  renderEvents();
}
async function refreshMarket(){
  if(!curSeason) return;
  const n = curSeason.n;
  const [mk, pf, ps, tr, sh, lb] = await Promise.all([
    fetchAll(()=>sb.from("market").select("*").eq("season", n).order("player_id")),
    fetchAll(()=>sb.from("portfolios").select("user_id,cash,trades").eq("season", n).order("user_id")),
    fetchAll(()=>sb.from("positions").select("*").eq("season", n).order("user_id")),
    fetchAll(()=>sb.from("trades").select("id,user_id,player_id,action,shares,price,at").eq("season", n).order("id")),
    fetchAll(()=>sb.from("shocks").select("*").eq("season", n).order("id")),
    fetchAll(()=>sb.from("leaderboard").select("*").order("user_id"))]);
  const market = {}; for(const x of mk) market[x.player_id] = {net:x.net, mult:Number(x.mult)};
  const pfs = {};
  for(const x of pf) pfs[x.user_id] = {season:n, cash:Number(x.cash), pos:{}, log:[]};
  for(const x of ps) if(pfs[x.user_id]) pfs[x.user_id].pos[x.player_id] = {side:x.side, sh:x.shares, avg:Number(x.avg)};
  for(const x of tr) if(pfs[x.user_id]) pfs[x.user_id].log.unshift({ts:Date.parse(x.at), pid:x.player_id, a:x.action, n:x.shares, px:Number(x.price)});
  for(const b of lb) if(pfs[b.user_id]) Object.assign(pfs[b.user_id], {tag:b.username, discord:b.discord_username || undefined, avatar:b.discord_avatar || undefined});
  const shocks = {season:n, list:sh.map(x=>({pid:x.player_id, ts:Date.parse(x.at), f:Number(x.factor), w:x.window_id, r:x.region, k:x.kind, why:x.why}))};
  const me = (S.uid && pfs[S.uid]) || fresh(); if(S.uid) delete pfs[S.uid];
  if(SIM.on){ Object.assign(SIM.real, {portfolios:pfs, me, shocks}); S.market = market; S.board = lb; return; }
  S.market = market; S.portfolios = pfs; S.me = me; S.shocks = shocks; S.board = lb; TB = null;
}
async function loadProfile(){
  S.profile = null; S.admin = false;
  if(!S.uid) return;
  const [{data}, adm] = await Promise.all([sb.from("profiles").select("*").eq("id", S.uid).maybeSingle(), sb.rpc("is_admin")]);
  S.profile = data || null; S.admin = !!adm.data;
}
let reloadTimer = null, fullReload = false;
function scheduleRefresh(full){   // realtime events arrive in bursts; refresh at most a few times a second
  fullReload = fullReload || full;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async ()=>{
    const f = fullReload; fullReload = false;
    try{ if(f) await loadAll(); else await refreshMarket(); derive(); render(); }catch(e){}
  }, 700);
}
function subscribe(){
  const ch = sb.channel("stormex-live");
  for(const t of ["market","trades","shocks","portfolios","positions"]) ch.on("postgres_changes", {event:"*", schema:"public", table:t}, ()=>scheduleRefresh(false));
  for(const t of ["players","seasons","site_meta"]) ch.on("postgres_changes", {event:"*", schema:"public", table:t}, ()=>scheduleRefresh(true));
  ch.subscribe();
}
async function setSession(session){
  const uid = session?.user?.id || null;
  if(uid === S.uid && S.profileLoaded) return;
  S.uid = uid; S.profileLoaded = true;
  await loadProfile();
  if(S.mode==="db"){ await refreshMarket(); derive(); render(); }
}

/* ---------- boot ---------- */
async function boot(){
  render();
  const cfg = window.STORMEX_CONFIG || {};
  if(!window.supabase || !cfg.supabaseUrl || !cfg.supabaseAnonKey || /YOUR-/.test(cfg.supabaseUrl)){ S.mode = "offline"; S.offlineWhy = "config"; render(); return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  sb.auth.onAuthStateChange((event, session)=>{
    if(event==="PASSWORD_RECOVERY") showAuth("newpass");
    setTimeout(()=>setSession(session), 0);   // don't call Supabase inside the auth callback itself
  });
  const {data:{session}} = await sb.auth.getSession();
  await setSession(session);
  try{ await loadAll(); }catch(e){ S.mode = "offline"; render(); return; }
  S.mode = "db";
  subscribe();
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const authErr = q.get("error_description") || h.get("error_description");
  if(authErr){ toast(authErr.replace(/\+/g, " ")); history.replaceState(null, "", location.pathname); }
  if(q.get("linked")==="discord"){
    history.replaceState(null, "", location.pathname);
    const {error} = await sb.rpc("sync_discord");
    await loadProfile(); await refreshMarket();
    if(error) toast(niceErr(error));
    else {
      let joined = "";
      const token = (await sb.auth.getSession()).data.session?.provider_token;
      if(token && S.discord?.guild_id){
        const r = await sb.functions.invoke("discord-join", {body:{access_token:token}});
        if(r.data?.joined) joined = " You've been added to the Storm Exchange Discord.";
        else if(r.data?.alreadyMember) joined = " You're verified in the Storm Exchange Discord.";
      }
      toast("Discord linked. You're eligible for season prizes." + joined);
    }
  }
  derive(); render();
}
boot();
