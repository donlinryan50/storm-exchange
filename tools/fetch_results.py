"""Storm Exchange: pull tournament results from Osirion's official public API (https://fnapi.osirion.gg).

    python tools/fetch_results.py <in.json> <out.txt>

in.json comes from `build.py prep` ({map: {pid: epic name}, done: [finished window ids], ids: {account id: pid}}).
out.txt is read by `build.py stats`. Use is governed by Osirion's API Terms (https://osirion.gg/legal/license):
stay under the published rate limit (tournament leaderboards: 60 requests/minute) and never scrape the website.

A window is COMPLETE when its official scheduled end is more than 2 hours past; until then it is re-fetched on
every run and replaces what was stored. Output lines: #DONE, #WIN w|begin|end|complete|entries, #FAILED,
#UPCOMING w|begin|end, #IDS {account id: pid}, then one line per player: pid=w|day|rank|points|team|games;...
"""
import json, re, sys, time, datetime as dt, urllib.request, urllib.error, urllib.parse

API = "https://fnapi.osirion.gg"
UA = {"User-Agent": "StormExchange/1.0 (+https://stormexchange.app)"}
PR = re.compile(r"^S\d+_(FNCSDivisionalCup_Division[123]_(Week\dFinal|Event\d+)|SoloVictoryCup_Event\d+Round2|"
                r"FNCSSoloQualifiers_Qual\dRound\d(?:Day\d)?|FNCSSolo_(FastTrack|Heat\d|LastChanceQualifier|LastChanceFinal|Final_Day\d)|"
                r"PerformanceEvaluation_Event\d+Round\d)_(EU|NAC)$")
GAP = 1.05          # seconds between requests: stays under 60/minute
_last = [0.0]

def get(path, **q):
    """GET a JSON endpoint, paced and retried. Returns (json, None), (None, 404) or (None, 'error')."""
    url = API + path + "?" + urllib.parse.urlencode(q)
    for a in range(5):
        wait = _last[0] + GAP - time.time()
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                if r.headers.get("RateLimit-Remaining") == "0": time.sleep(int(r.headers.get("RateLimit-Reset") or 60))
                return json.load(r), None
        except urllib.error.HTTPError as e:
            if e.code == 404: return None, 404
            if e.code == 429: time.sleep(int(e.headers.get("Retry-After") or e.headers.get("RateLimit-Reset") or 60)); continue
        except (urllib.error.URLError, TimeoutError, ValueError):
            pass
        time.sleep(2 * 2 ** a)
    return None, "error"

def iso(t): return dt.datetime.fromisoformat(t.replace("Z", "+00:00"))

def main(in_json, out_txt):
    IN = json.load(open(in_json, encoding="utf-8"))
    done = set(IN.get("done", []))
    exact = {e: pid for pid, e in IN["map"].items()}
    lower = {e.lower(): pid for pid, e in IN["map"].items()}
    idTo, learned = dict(IN.get("ids") or {}), {}
    def who(acc, name):   # account ids never change, so one match keeps a player matched after a rename
        if acc not in idTo and name:
            pid = exact.get(name) or lower.get(name.lower())
            if pid: idTo[acc] = learned[acc] = pid

    # 1. the official schedule: every window with its begin/end and leaderboard ids
    sched = {}
    for reg in ("EU", "NAC"):
        d, err = get("/v1/tournaments", region=reg)
        if err: sys.exit(f"could not load the tournament list for {reg} ({err})")
        for t in d.get("tournaments", []):
            for w in t.get("eventWindows", []):
                wid = w.get("eventWindowId", "")
                if not PR.match(wid): continue
                loc = next((s for s in w.get("scoreLocations", []) if s.get("isMain")), None) or (w.get("scoreLocations") or [{}])[0]
                sched[wid] = {"begin": w["beginTime"], "end": w["endTime"],
                              "ev": loc.get("leaderboardEventId") or t["eventId"], "lw": loc.get("leaderboardEventWindowId") or wid}
    season = max((int(re.match(r"S(\d+)_", w)[1]) for w in sched), default=0)
    now = dt.datetime.now(dt.timezone.utc)
    todo = sorted(w for w, s in sched.items() if w.startswith(f"S{season}_") and w not in done and iso(s["begin"]) <= now)
    print(f"{len(todo)} windows to fetch (season {season})", flush=True)

    # 2. each unfinished window that has started: read the whole leaderboard
    ACC, WIN, FAILED = {}, {}, []
    for i, w in enumerate(todo, 1):
        s = sched[w]; R = {}; n = 0; last = None; failed = False; page = 0
        while True:
            d, err = get("/v1/tournaments/leaderboard", leaderboardEventId=s["ev"], leaderboardEventWindowId=s["lw"], page=page)
            if err == 404: break
            if err or not d.get("success", True): failed = True; break
            lb = d.get("leaderboard") or {}
            for e in lb.get("entries", []):
                n += 1
                players = e.get("players") or []
                for p in players: who(p.get("accountId"), p.get("username"))
                sh = sorted(e.get("sessionHistory") or [], key=lambda x: x.get("endTime", ""))
                if sh: last = max(last or "", sh[-1]["endTime"])
                mt = "_".join(".".join(str((x.get("trackedStats") or {}).get(k, 0)) for k in
                              ("PLACEMENT_STAT_INDEX", "TEAM_ELIMS_STAT_INDEX", "TIME_ALIVE_STAT", "VICTORY_ROYALE_STAT")) for x in sh)
                for p in players: R[p.get("accountId")] = [w, "", e.get("rank"), e.get("pointsEarned"), 1 if len(players) > 1 else 0, mt]
            page += 1
            if not lb.get("entries") or page >= (lb.get("totalPages") or 0): break
        if failed:
            FAILED.append(w); print(f"  [{i}/{len(todo)}] {w}: could not read, keeping stored results", flush=True); continue
        day = (last or s["end"])[:10]
        for acc, r in R.items(): r[1] = day; ACC.setdefault(acc, {})[w] = r
        complete = now > iso(s["end"]) + dt.timedelta(hours=2)
        if complete: done.add(w)
        WIN[w] = [w, s["begin"], s["end"], 1 if complete else 0, n]
        print(f"  [{i}/{len(todo)}] {w}: {n} entries{'' if complete else ' (in progress)'}", flush=True)

    # 3. match accounts to players (after everything is read, so read order doesn't matter) and write the file
    F = {}
    for acc, ws in ACC.items():
        pid = idTo.get(acc)
        if pid: F.setdefault(pid, {}).update(ws)
    lines = ["#DONE " + ",".join(sorted(done))]
    lines += ["#WIN " + "|".join(map(str, x)) for x in WIN.values()]
    if FAILED: lines.append("#FAILED " + ",".join(sorted(FAILED)))
    soon = now + dt.timedelta(days=8)
    lines += [f"#UPCOMING {w}|{s['begin']}|{s['end']}" for w, s in sorted(sched.items())
              if w.startswith(f"S{season}_") and iso(s["end"]) > now and iso(s["begin"]) < soon]
    lines.append("#IDS " + json.dumps(learned, ensure_ascii=False))
    lines += [pid + "=" + ";".join("|".join(map(str, x)) for x in ws.values()) for pid, ws in F.items()]
    open(out_txt, "w", encoding="utf-8").write("\n".join(lines))
    print(f"wrote {out_txt}: {len(WIN)} windows, {len(F)} players, {len(FAILED)} failed, {len(learned)} new account ids")

if __name__ == "__main__":
    main(*sys.argv[1:3])
