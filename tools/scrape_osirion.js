// Storm Exchange: Osirion tournament scraper. Run inside an https://osirion.gg/tournaments tab
// after window.__in = {map:{pid:epic}, done:[window ids]} has been loaded.
// A window is COMPLETE only when its official scheduled end (from Epic's event definition embedded in Osirion's
// page) is more than 2 hours past. Windows that aren't complete are re-fetched on every run and fully replace
// what was stored before. Output lines: #DONE (complete windows), #WIN (each window fetched this run),
// #UPCOMING (scheduled windows in the next 8 days), then one line per player.
// Starts in the background; poll window.__S until window.__S.finished is true.
// When finished it saves stormex-osirion.txt to Downloads.
window.__S = {finished:false, prog:0, total:0, note:""};
(async () => {
  const S = window.__S, IN = window.__in, done = new Set(IN.done || []);
  const exact = {}, lower = {};
  for (const [pid, e] of Object.entries(IN.map)) { exact[e] = pid; lower[e.toLowerCase()] = pid; }
  const idTo = {}; const who = (id, u) => { if (!(id in idTo)) idTo[id] = exact[u] || lower[u.toLowerCase()] || null; };
  const PR = /^S\d+_(FNCSDivisionalCup_Division[123]_(Week\dFinal|Event\d+)|SoloVictoryCup_Event\d+Round2|FNCSSoloQualifiers_Qual\dRound\d(?:Day\d)?|FNCSSolo_(FastTrack|Heat\d|LastChanceQualifier|LastChanceFinal|Final_Day\d)|PerformanceEvaluation_Event\d+Round\d)_(EU|NAC)$/;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getText = async url => { for (let a = 0; a < 3; a++) { try { const r = await fetch(url, {cache: 'no-store'}); if (r.ok) return await r.text(); } catch (e) {} await sleep(1500); } return ""; };
  // official schedule: Epic's event definition lists each window id followed by its beginTime/endTime
  const SCHED = {};
  const readSchedule = html => {
    const re = /beginTime:"([^"]+)"[^]{0,200}?endTime:"([^"]+)"/g; let m;
    while ((m = re.exec(html))) {
      const ids = [...html.slice(Math.max(0, m.index - 700), m.index).matchAll(/(?:eventWindowId|windowId|id):"(?:epicgames_[^":]+:)?(S\d+_[A-Za-z0-9_]+)"/g)];
      if (ids.length) SCHED[ids[ids.length - 1][1]] = {begin: m[1], end: m[2]};
    }
  };
  const lb = async (ev, w, page) => { for (let a = 0; a < 3; a++) { try {
      const r = await fetch('/api/fortnite/tournaments/leaderboards/get-epic-leaderboard', {method:'POST', cache:'no-store', headers:{'content-type':'application/json'},
        body: JSON.stringify({sourceEventId:ev, sourceEventWindowId:w, leaderboardEventId:ev, leaderboardEventWindowId:w, page})});
      if (r.ok) return await r.json(); } catch (e) {} await sleep(1500); } return null; };

  // 1. discover windows: links on this page + every window id mentioned in the listing and FNCS pages' HTML
  const ids = new Set([...document.querySelectorAll('a')].map(a => (a.href.split('/tournaments/')[1] || '').split('?')[0]));
  let html = await getText('/tournaments');
  const fncs = [...ids].find(w => /FNCSSoloQualifiers/.test(w));
  if (fncs) html += await getText('/tournaments/' + fncs);
  readSchedule(html);
  for (const m of html.matchAll(/S\d+_[A-Za-z0-9_]+?_(EU|NAC)\b/g)) ids.add(m[0]);
  for (const w of [...ids]) if (w.endsWith('_EU')) ids.add(w.replace(/_EU$/, '_NAC'));
  // only the current season: the highest S<number> prefix among this page's own links
  const season = Math.max(...[...document.querySelectorAll('a')].map(a => +((a.href.split('/tournaments/')[1] || '').match(/^S(\d+)_/) || [, 0])[1]));
  const todo = [...ids].filter(w => w.startsWith(`S${season}_`) && PR.test(w) && !done.has(w)).sort();
  S.total = todo.length; S.note = todo.length + " windows to check";

  // 2. pull each unfinished window
  const F = {}, WIN = {}, now = Date.now();
  const queue = todo.slice();
  const one = async w => {
    const reg = w.endsWith('_EU') ? 'EU' : 'NAC';
    const page = await getText('/tournaments/' + w);
    readSchedule(page);
    const ev = [...new Set(page.match(/epicgames_S\d+_[A-Za-z0-9_]+/g) || [])].find(x => !/_S\d+_/.test(x.slice(10)) && x.endsWith('_' + reg));
    if (!ev) { S.prog++; return; }
    const sc = SCHED[w];
    if (sc && Date.parse(sc.begin) > now) { S.prog++; return; }   // hasn't started yet
    const pages = /Week\dFinal|FNCSSolo_/.test(w) ? 3 : /PerformanceEvaluation/.test(w) ? 5 : 10;
    let lastEnd = 0, n = 0;
    for (let pg = 0; pg < pages; pg++) {
      const j = await lb(ev, w, pg); if (!j?.success || !j.entries?.length) break;
      for (const [id, u] of Object.entries(j.usernames || {})) who(id, u);
      for (const e of j.entries) {
        n++;
        const sh = (e.sessionHistory || []).slice().sort((a, b) => a.endTime.localeCompare(b.endTime));
        for (const s of sh) lastEnd = Math.max(lastEnd, Date.parse(s.endTime));
        const ids2 = e.teamAccountIds || [];
        for (const id of ids2) { const pid = idTo[id]; if (!pid) continue;
          const mt = sh.map(s => { const t = s.trackedStats || {}; return [t.PLACEMENT_STAT_INDEX||0, t.TEAM_ELIMS_STAT_INDEX||0, t.TIME_ALIVE_STAT||0, t.VICTORY_ROYALE_STAT||0].join('.'); }).join('_');
          (F[pid] = F[pid] || {})[w] = [w, '', e.rank, e.pointsEarned, ids2.length > 1 ? 1 : 0, mt]; }
      }
      if (pg + 1 >= j.totalPages) break;
      await sleep(300);
    }
    const day = lastEnd ? new Date(lastEnd).toISOString().slice(0, 10) : (sc ? sc.end.slice(0, 10) : '');
    for (const pid in F) if (F[pid][w]) F[pid][w][1] = day;
    // complete = official end + 2h grace (or, with no schedule, 6h after the last game we saw)
    const complete = sc ? now > Date.parse(sc.end) + 2 * 36e5 : !!(n && lastEnd && now - lastEnd > 6 * 36e5);
    if (complete) done.add(w);
    WIN[w] = [w, sc ? sc.begin : '', sc ? sc.end : '', complete ? 1 : 0, n];
    S.prog++;
  };
  // three windows at a time; each request already retries if Osirion throttles
  await Promise.all([0, 1, 2].map(async () => { while (queue.length) { await one(queue.shift()); await sleep(200); } }));

  // 3. save the results file
  const lines = ['#DONE ' + [...done].sort().join(',')];
  for (const x of Object.values(WIN)) lines.push('#WIN ' + x.join('|'));
  for (const [w, sc] of Object.entries(SCHED))   // upcoming windows tell the refresh job when to run
    if (w.startsWith(`S${season}_`) && PR.test(w) && Date.parse(sc.end) > now && Date.parse(sc.begin) < now + 8 * 864e5) lines.push(`#UPCOMING ${w}|${sc.begin}|${sc.end}`);
  for (const [pid, ws] of Object.entries(F)) lines.push(pid + '=' + Object.values(ws).filter(x => x[1]).map(x => x.join('|')).join(';'));
  // Chrome blocks repeat downloads that aren't started by a click, so add a button for the task to click
  window.__out = lines.join('\n');
  const b = document.createElement('button'); b.id = '__save'; b.textContent = 'Save Storm Exchange results';
  b.setAttribute('aria-label', 'save stormex results'); b.style.cssText = 'position:fixed;top:40px;left:0;z-index:999999;padding:8px';
  b.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([window.__out], {type: 'text/plain'}));
    a.download = 'stormex-osirion.txt'; document.body.appendChild(a); a.click(); a.remove(); };
  document.body.appendChild(b);
  S.players = Object.keys(F).length; S.finished = true;
})();
'started';
