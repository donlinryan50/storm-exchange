"""One-off: port web/app.js (the old claude.ai page script) to Supabase. Run once from the project root."""
import os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "app.js")
s = open(p, encoding="utf-8").read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f"{n} matches for: {old[:80]!r}"
    s = s.replace(old, new)

def cut(start, end, new):
    """replace from start marker (inclusive) to end marker (exclusive)"""
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + new + s[j:]

# ---- constants / state
rep('''const LOG_CAP = 3000;           // trades per season; the cheat audit needs every trade, so the log is never trimmed''',
'''const LOG_CAP = 3000;           // trades per season (the server enforces the same limit)''')
rep('''let curSeason = null;           // meta/season: {n, name, start, end, ipo:{pid:open}, past:[{n, name, end, top:[{tag, discord, nw}]}]}
const LOCAL_KEY = "stormex-portfolio-v2";''',
'''let curSeason = null;           // seasons row: {n, name, start, end, depth, ipo:{pid:open}, past:[{n, name, end, top:[{tag, discord, nw}]}]}
let sb = null;                  // Supabase client (web/config.js holds the project URL and the public anon key)''')
rep('''  db:null, user:null, uid:null, admin:false,
  mode:"loading",           // loading | db | local | offline''',
'''  uid:null, profile:null, admin:false,
  mode:"loading",           // loading | db | offline''')
rep('''  meLoaded:false, showLogin:false, skipLogin:false, audit:null, discord:null, shocks:null''',
'''  showLogin:false, authView:"login", authMsg:"", market:{}, board:[], discord:null, shocks:null, simskill:null''')

# ---- other traders: the server is the source of truth now
cut("/* Other traders' portfolios are written by their own browsers", "let TB = null;",
'''/* Every trader's portfolio, built from the server's portfolios / positions / trades tables (read-only for
   browsers; trades only change through the server's trade() function). In a test run, the bots live here. */
function allPortfolios(){
  const all = {};
  for(const [id,pf] of Object.entries(S.portfolios)) if(inSeason(pf)) all[id] = pf;
  if(S.uid || SIM.on) all[S.uid || "__me"] = S.me;
  return all;
}
''')
rep('''  const net = {};
  for(const pf of Object.values(allPortfolios(true)))
    for(const [pid,pos] of Object.entries(pf.pos||{})) net[pid] = (net[pid]||0) + (pos.side==="long" ? pos.sh : -pos.sh);
  S.net = net;''',
'''  const net = {};
  if(SIM.on){   // the test run prices from its bots' holdings
    for(const pf of Object.values(allPortfolios()))
      for(const [pid,pos] of Object.entries(pf.pos||{})) net[pid] = (net[pid]||0) + (pos.side==="long" ? pos.sh : -pos.sh);
  } else for(const [pid, m] of Object.entries(S.market)) net[pid] = m.net;   // live: the server's market table
  S.net = net;''')
rep('''    p.m = multAt(p.id, Date.now());''', '''    p.m = SIM.on ? multAt(p.id, Date.now()) : (S.market[p.id]?.mult ?? 1);''')
rep('''    if(S.statsForm && S.statsForm[p.id]) p.form = {src:"Osirion", ...S.statsForm[p.id]};
''', "")
rep('''  for(const pf of Object.values(allPortfolios(true))) for(const l of (pf.log||[])) if(l.ts) (TB[l.pid] = TB[l.pid] || []).push(l);''',
'''  for(const pf of Object.values(allPortfolios())) for(const l of (pf.log||[])) if(l.ts) (TB[l.pid] = TB[l.pid] || []).push(l);''')
rep('''  for(const pf of Object.values(allPortfolios(true))) for(const l of (pf.log||[])) if(l.ts) all.push(l);''',
'''  for(const pf of Object.values(allPortfolios())) for(const l of (pf.log||[])) if(l.ts) all.push(l);''')

# ---- storage + trading
cut("/* ---------- storage ---------- */", "/* ---------- charts ---------- */",
'''/* ---------- trading ---------- */
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
  return m.replace(/^.*?ERROR:\\s*/, "").slice(0, 200) || "Something went wrong. Try again.";
}

''')

# ---- header / avatars
rep('''  document.getElementById("acct").hidden = S.mode==="loading";
  document.getElementById("acctTag").textContent = S.me.tag || "Sign in";
  document.getElementById("acctSub").textContent = S.me.discord ? "@"+S.me.discord : "Trader";
  const av = document.getElementById("acctAv"), src = dcAvatar(S.me);''',
'''  document.getElementById("acct").hidden = S.mode==="loading";
  const pr = S.profile;
  document.getElementById("acctTag").textContent = pr ? pr.username : "Log in";
  document.getElementById("acctSub").textContent = pr ? (pr.discord_username ? "@"+pr.discord_username : "Link Discord") : "or sign up free";
  const av = document.getElementById("acctAv"), src = pr ? dcAvatar({avatar:pr.discord_avatar, discord:pr.discord_username, tag:pr.username}) : "";''')

cut("// Discord profile pictures: artifact pages can't load images", "function discordBtn(){",
r'''// Avatars: the verified Discord avatar when a trader has linked Discord, otherwise a Discord-blue initial badge.
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
  const {error} = await sb.auth.linkIdentity({provider:"discord", options:{redirectTo:location.origin + location.pathname + "?linked=discord"}});
  if(error){ const e = document.getElementById("lgErr"); if(e) e.textContent = niceErr(error); }
}
async function unlinkDiscord(){
  const {data, error} = await sb.auth.getUserIdentities();
  const idn = !error && data.identities.find(i=>i.provider==="discord");
  if(idn){ const r = await sb.auth.unlinkIdentity(idn); if(r.error){ const e = document.getElementById("lgErr"); if(e) e.textContent = niceErr(r.error); return; } }
  await sb.rpc("sync_discord"); await loadProfile(); await refreshMarket(); derive(); render(); renderLogin(true); toast("Discord unlinked.");
}

''')

rep('''  if(S.mode==="local") b.innerHTML = `<div class="banner"><strong>Practice mode.</strong> Your trades are saved in this browser only and don't move the shared market or appear on the leaderboard. Ask the market owner for Contributor access to compete.</div>`;
  else if(S.mode==="offline") b.innerHTML = `<div class="banner"><strong>The live market isn't reachable.</strong> Open this page on claude.ai while signed in to see player prices.</div>`;
  else b.innerHTML = "";''',
'''  if(S.mode==="offline") b.innerHTML = S.offlineWhy==="config"
    ? `<div class="banner"><strong>This site isn't connected to its database yet.</strong> Add the Supabase project URL and anon key to config.js (see README.md).</div>`
    : `<div class="banner"><strong>The live market isn't reachable.</strong> Check your connection and reload the page.</div>`;
  else if(S.mode==="db" && !S.uid && !SIM.on) b.innerHTML = `<div class="banner"><strong>You're browsing as a guest.</strong> <button class="btn gold" data-auth="signup">Create an account</button> or <button class="btn" data-auth="login">log in</button> to trade.</div>`;
  else b.innerHTML = "";''')

# ---- admin panel copy
rep('''    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">Only you and Editors see this. A new player's IPO price is their PR ÷ 100. After that, trading sets the price.</p>''',
'''    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">Only admins see this. A new player's IPO price is their PR ÷ 100. After that, trading sets the price.</p>''')
rep('''    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">To end a season and start the next, ask Claude to run the cheat audit and roll over the season. That saves the verified top finishers as past champions, re-IPOs every player at their current PR and resets everyone to ${fmt(START_CASH)} gold bars.</p></div>`;''',
'''    <p class="label" style="margin:10px 0 0;text-transform:none;letter-spacing:0">To end a season and start the next, ask Claude to roll it over. That saves the top Discord-linked finishers as past champions, re-IPOs every player at their current PR and resets everyone to ${fmt(START_CASH)} gold bars.</p></div>`;''')

# ---- leaderboard: live standings come from the server's leaderboard view
cut("function leadersShell(){", "/* ---------- player card + ticket ---------- */",
'''function leadersShell(){
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

''')

# ---- admin writes
cut("/* ---------- admin writes ---------- */", "/* ---------- events ---------- */",
'''/* ---------- admin writes (server functions check that you're an admin) ---------- */
async function addPlayer(name, region, pr){
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || ("p"+Date.now());
  if(byId(id)){ toast(name+" is already listed."); return; }
  const {error} = await sb.rpc("admin_add_player", {p_id:id, p_name:name, p_region:region, p_pr:pr});
  if(error) return toast(niceErr(error));
  toast(name+" is listed at "+fmt(Math.round(pr/100))+"."); await loadAll(); derive(); render();
}

''')

# ---- event handlers
rep('''  if(el.id==="acct"){ S.showLogin = true; render(); return; }''',
'''  if(el.id==="acct"){ showAuth(S.uid ? "account" : "login"); return; }
  if(el.dataset.auth){ showAuth(el.dataset.auth); return; }
  if(el.id==="dcLink"){ linkDiscord(); return; }
  if(el.id==="dcUnlink"){ unlinkDiscord(); return; }
  if(el.id==="lgOut"){ sb.auth.signOut().then(()=>{ S.showLogin = false; render(); toast("Logged out."); }); return; }''')
rep('''  if(el.id==="lgPick"){ document.getElementById("lgFile").click(); return; }
  if(el.id==="lgPfpClear"){ S.pfpDraft = ""; previewPfp(); return; }
  if(el.id==="lgSkip"){ if(S.showLogin) S.showLogin = false; else S.skipLogin = true; render(); return; }''',
'''  if(el.id==="lgSkip"){ S.showLogin = false; render(); return; }''')
rep('''  if(el.id==="tkGo"){ const n=t.qty; const err = execute(t.side==="long"?"buy":"short", t.id, n); if(err){t.msg=err; renderTicket();} else { toast(`${t.side==="long"?"Bet up":"Bet down"} on ${n} × ${p.name}. Price now ${fmt(p.price)}.`); t.qty=1; t.msg=""; renderTicket(); } return; }
  if(el.id==="tkClosePos"){ const n=Math.min(t.qty,cur.sh); const side=cur.side; const err = execute(side==="long"?"sell":"cover", t.id, n); if(err){t.msg=err; renderTicket();} else { toast(`${side==="long"?"Sold":"Covered"} ${n} × ${p.name}. Price now ${fmt(p.price)}.`); t.qty=1; t.msg=""; renderTicket(); } return; }
  if(el.id==="revalGo"){ updatePR(p, Number(document.getElementById("revalIn").value)); return; }
  if(el.id==="delistGo"){
    if(el.dataset.armed){ S.db.doc("players/"+p.id).delete().then(()=>{toast(p.name+" was delisted."); closeTicket();}).catch(()=>toast("Couldn't delist that player.")); }
    else { el.dataset.armed="1"; el.textContent="Confirm delist"; }
    return;
  }''',
'''  if(el.id==="tkGo"){ runTrade(t.side==="long" ? "buy" : "short", t.qty); return; }
  if(el.id==="tkClosePos" && cur){ runTrade(cur.side==="long" ? "sell" : "cover", Math.min(t.qty, cur.sh)); return; }''')
rep('''  if(e.target.id==="lgDc"){ previewPfp(); return; }
''', "")
rep('''  if(e.target.id==="lgFile") readPfp(e.target.files[0]).then(d=>{ S.pfpDraft = d; document.getElementById("lgErr").textContent = ""; previewPfp(); })
    .catch(()=>{ document.getElementById("lgErr").textContent = "That picture couldn't be read. Try a PNG or JPG under 8 MB."; });
''', "")
rep('''  if(e.target.id==="lgForm"){ e.preventDefault(); submitLogin(); return; }''',
'''  if(e.target.id==="lgForm"){ e.preventDefault(); submitAuth(); return; }''')
rep('''    S.db.doc("meta/season").update({end:t.toISOString()}).then(()=>toast("Season end saved.")).catch(()=>toast("Couldn't save the end date."));''',
'''    sb.rpc("admin_set_season_end", {p_end:t.toISOString()}).then(({error})=>{ if(error) return toast(niceErr(error)); toast("Season end saved."); loadAll().then(()=>{ derive(); render(); }); });''')
rep('''    S.db.doc("meta/discord").set({invite, claims}).then(()=>toast("Discord settings saved.")).catch(()=>toast("Couldn't save the Discord settings."));''',
'''    sb.rpc("admin_set_meta", {p_key:"discord", p_value:{invite, claims}}).then(({error})=>{ if(error) return toast(niceErr(error)); S.discord = {invite, claims}; render(); toast("Discord settings saved."); });''')
rep('''  if(e.key==="Escape" && !document.getElementById("loginRoot").hidden){ document.getElementById("lgSkip").click(); return; }''',
'''  if(e.key==="Escape" && !document.getElementById("loginRoot").hidden){ document.getElementById("lgSkip")?.click(); return; }''')

# ---- test run: skill/popularity come from site_meta now
rep('''  if(!SIM.skill && S.db) S.db.doc("meta/simskill").get().then(d=>{ if(d.exists){ SIM.skill = d.data().skill; SIM.pop = d.data().pop || null; SIM.popW = null; } }).catch(()=>{});''',
'''  if(!SIM.skill && S.simskill){ SIM.skill = S.simskill.skill; SIM.pop = S.simskill.pop || null; SIM.popW = null; }''')

# ---- boot
cut("/* ---------- boot ---------- */", "\nboot();",
'''/* ---------- data: everything is read from Supabase (public, read-only); live updates arrive over realtime ---------- */
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
  if(authErr){ toast(authErr.replace(/\\+/g, " ")); history.replaceState(null, "", location.pathname); }
  if(q.get("linked")==="discord"){
    history.replaceState(null, "", location.pathname);
    const {error} = await sb.rpc("sync_discord");
    await loadProfile(); await refreshMarket();
    toast(error ? niceErr(error) : "Discord linked. You're eligible for season prizes.");
  }
  derive(); render();
}''')

open(p, "w", encoding="utf-8").write(s)
print("ok", len(s.splitlines()), "lines")
