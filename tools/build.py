"""Storm Exchange data builder, used by the scheduled refresh task.

Modes
  prep    <epicmap.json> <latest_run.json|-> <out.json>
          -> {"map": {pid: epic}, "done": [window ids already complete]} for the Osirion scraper
  pr      <epicmap.json> <ft.tsv> <out_dir> [players_dir]
          -> out_dir/prsnap.json (a new prsnaps doc) ; prints the doc id
  stats   <players_dir|epicmap.json> <prev_chunks_dir|-> <osirion.txt> <out_dir>
          -> out_dir/chunk_N.json + out_dir/run.json ; prints the batch writes to send
  cleanup <runs_dir> <chunks_dir> <prsnaps_dir>
          -> prints a delete batch for runs/chunks older than the newest 2 runs and
             extra prsnaps (keeps every snapshot from the last 2 days, then one per day)
  audit   <portfolios_dir> <players_dir> <season.json> <out.json>
          -> out.json (the meta/audit doc): replays the season's trades and flags portfolios that don't add up
  newseason <prev_season.json|-> <audit.json|-> <portfolios_dir|-> <prsnap.json> <start_iso> <end_iso> <out.json>
          -> out.json (the next meta/season doc), archiving the verified top 10 of the previous season
All new docs are only ever created, never edited, so deletes can always pin if_version 1.
"""
import json, os, re, sys, glob, datetime as dt

def jload(p):
    with open(p, encoding="utf-8") as f: return json.load(f)
def jdump(o, p):
    with open(p, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=True, separators=(",", ":"))
def body(d): return d.get("data", d) if isinstance(d, dict) else d
def docs(dirpath):
    out = {}
    for f in glob.glob(os.path.join(dirpath, "**", "*.json"), recursive=True):
        out[os.path.splitext(os.path.basename(f))[0]] = body(jload(f))
    return out
def now_id(): return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M")
def now_iso(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def label(w):
    """window id -> (display name, kind). Kinds match the page tags: div, vc, fncs, pe."""
    m = re.search(r"Division(\d)_Week(\d)Final", w)
    if m: return f"Division {m[1]} Cup, Week {m[2]} Final", "div"
    m = re.search(r"Division(\d)_Event(\d+)", w)
    if m: return f"Division {m[1]} Cup, Session {m[2]}", "div"
    m = re.search(r"SoloVictoryCup_Event(\d+)Round(\d)", w)
    if m: return f"Solo Victory Cup {m[1]}", "vc"
    m = re.search(r"Qual(\d)Round(\d)(Day(\d))?", w)
    if m: return f"FNCS Solos Q{m[1]}, Round {m[2]}" + (f" Day {m[4]}" if m[4] else ""), "fncs"
    m = re.search(r"FNCSSolo_(FastTrack|Heat(\d)|LastChance(Qualifier|Final|Lobby)|Final_Day(\d))", w)
    if m:
        s = m[1]
        if s == "FastTrack": n = "Fast Track"
        elif m[2]: n = f"Heat {m[2]}"
        elif m[3]: n = "Last Chance " + ("Final" if m[3] == "Final" else "Qualifier")
        else: n = f"Grand Finals Day {m[4]}"
        return "FNCS Solos " + n, "fncs"
    m = re.search(r"PerformanceEvaluation_Event(\d+)Round(\d)", w)
    if m: return f"Performance Evaluation {m[1]}, Round {m[2]}", "pe"
    return w, "fncs"

def seed_id(e):
    """Rebuild a window id for events stored before ids were tracked (first run only)."""
    r = e["r"]; n = e["e"]
    m = re.match(r"Division 1 Cup, Week (\d) Final", n)
    if m: return f"S42_FNCSDivisionalCup_Division1_Week{m[1]}Final_{r}"
    m = re.match(r"Division (\d) Cup, Session (\d+)", n)
    if m: return f"S42_FNCSDivisionalCup_Division{m[1]}_Event{m[2]}_{r}"
    m = re.match(r"Solo Victory Cup (\d+)", n)
    if m: return f"S42_SoloVictoryCup_Event{m[1]}Round2_{r}"
    m = re.match(r"FNCS Solos Qualifier, Round (\d)", n)
    if m: return f"S42_FNCSSoloQualifiers_Qual1Round{m[1]}_{r}"
    m = re.match(r"Performance Evaluation (\d+), Round (\d)", n)
    if m: return f"S42_PerformanceEvaluation_Event{m[1]}Round{m[2]}_{r}"
    return f"{n}|{r}|{e['t']}"

def prep(epicmap, runfile, out):
    done = body(jload(runfile)).get("done", []) if runfile != "-" and os.path.exists(runfile) else []
    idf = os.path.join(os.path.dirname(epicmap), "epicids.json")   # account ids learned by earlier runs
    jdump({"map": body(jload(epicmap)), "done": done, "ids": jload(idf) if os.path.exists(idf) else {}}, out)
    print(f"map {len(body(jload(epicmap)))} players, {len(done)} finished windows")

def pr(epicmap, tsv, out_dir, players_dir="-"):
    emap = body(jload(epicmap))
    players = docs(players_dir) if players_dir != "-" else {}
    for pid in emap: players.setdefault(pid, {"region": "", "name": ""})
    by_epic = {e: pid for pid, e in emap.items()}
    by_name = {}
    for pid, p in players.items(): by_name.setdefault((p["region"], p["name"].lower()), pid)
    snap, notes, seen = {}, {}, set()
    for line in open(tsv, encoding="utf-8").read().strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 5: continue
        reg, name, team, prv, epic = parts[:5]
        pid = by_epic.get(epic) or by_name.get(("NA" if reg == "NAC" else reg, name.lower()))
        if not pid or pid in seen: continue
        seen.add(pid); snap[pid] = int(prv)
        if team: notes[pid] = team
    os.makedirs(out_dir, exist_ok=True)
    jdump({"at": now_iso(), "pr": snap, "note": notes}, os.path.join(out_dir, "prsnap.json"))
    print(f"prsnaps/{now_id()} matched {len(snap)} of {len(players)} players; not found: {sorted(set(players) - seen)[:40]}")

def stats(players_src, prev_dir, txt, out_dir):
    # players_src: a players/ folder (needed on the very first run) or meta/epicmap.json (enough afterwards)
    players = docs(players_src) if os.path.isdir(players_src) else {pid: {} for pid in body(jload(players_src))}
    prev = {}
    if prev_dir != "-" and os.path.isdir(prev_dir):
        for d in docs(prev_dir).values(): prev.update(d["players"] if isinstance(d.get("players"), dict) else {})   # run.json's "players" is a count
    else:  # first run: start from the per-player form stored on player docs
        for pid, p in players.items():
            ev = (p.get("form") or {}).get("ev", [])
            for e in ev: e["id"] = seed_id(e)
            prev[pid] = {"ev": ev}
    lines = open(txt, encoding="utf-8").read().strip().splitlines()
    done, fresh, meta, upcoming, failed, learned = [], {}, {}, [], [], {}
    for line in lines:
        if line.startswith("#DONE"): done = [w for w in line[5:].strip().split(",") if w]; continue
        if line.startswith("#WIN "):       # a window fetched this run: w|begin|end|complete|entries
            w, b, e, c, _n = (line[5:].split("|") + ["", "", "", "0", "0"])[:5]
            meta[w] = {"b": b, "end": e, "c": c == "1", "n": int(_n or 0)}; continue
        if line.startswith("#IDS "): learned = json.loads(line[5:]); continue   # account ids matched by name this run
        if line.startswith("#FAILED "): failed = [w for w in line[8:].strip().split(",") if w]; continue   # unreadable: stored results kept
        if line.startswith("#UPCOMING "):  # scheduled windows coming up: w|begin|end
            w, b, e = (line[10:].split("|") + ["", ""])[:3]; upcoming.append({"w": w, "b": b, "end": e}); continue
        if line.startswith("#") or "=" not in line: continue
        pid, rest = line.split("=", 1)
        for ent in rest.split(";"):
            w, d, rk, pts, team, mts = ent.split("|", 5)
            mt = [[int(float(x)) for x in m.split(".")] for m in mts.split("_")] if mts else []
            name, k = label(w); n = len(mt)
            reg = "EU" if w.endswith("_EU") else "NAC"
            wm = meta.get(w, {})
            fresh.setdefault(pid, {})[w] = {"id": w, "t": d, "e": name, "k": k, "r": reg, "rk": int(rk), "pts": int(pts),
                "team": team == "1", "m": n, "w": sum(x[3] for x in mt), "el": sum(x[1] for x in mt),
                "ap": round(sum(x[0] for x in mt) / n, 1) if n else None, "mt": mt,
                "c": wm.get("c", w in done), "b": wm.get("b") or None, "end": wm.get("end") or None}
    # Every window fetched this run REPLACES what was stored for it: players who no longer appear in its
    # results (e.g. finished outside the places we read) lose their old partial entry instead of keeping it.
    fetched, done_set = set(meta), set(done)
    unmatched = []
    merged = {}
    for pid in players:
        # a player found in no window at all is a name lookup miss (renamed Epic account), not a wipe: keep theirs
        keep = pid not in fresh
        if keep and any(e.get("id") in fetched for e in prev.get(pid, {}).get("ev", [])): unmatched.append(pid)
        evs = {e["id"]: e for e in prev.get(pid, {}).get("ev", []) if keep or e.get("id") not in fetched}
        for e in evs.values():
            if "c" not in e: e["c"] = e.get("id") in done_set   # older entries: complete if their window is
        evs.update(fresh.get(pid, {}))
        merged[pid] = sorted(evs.values(), key=lambda e: (e["t"], e["e"]), reverse=True)
    all_done = sorted(set(done))  # the scraper reports previously finished windows plus newly finished ones
    run = now_id(); at = now_iso()
    os.makedirs(out_dir, exist_ok=True)
    chunks, cur, size = [], {}, 0
    for pid in sorted(merged):
        s = len(json.dumps(merged[pid]))
        if cur and size + s > 180000: chunks.append(cur); cur, size = {}, 0
        cur[pid] = {"updated": at[:10], "ev": merged[pid]}; size += s
    if cur: chunks.append(cur)
    writes = []
    for i, c in enumerate(chunks):
        p = os.path.join(out_dir, f"chunk_{i}.json"); jdump({"run": run, "at": at, "players": c}, p)
        writes.append({"op": "set", "collection": "statschunks", "doc_id": f"{run}-{i}", "file_path": p.replace("\\", "/")})
    jdump(learned, os.path.join(out_dir, "epicids.json"))
    rp = os.path.join(out_dir, "run.json")
    pending = [{"w": w, "end": m["end"]} for w, m in sorted(meta.items()) if not m["c"] and (m["n"] or m["b"])]   # unscheduled + empty = not started
    pending += [{"w": w, "end": None} for w in failed]
    jdump({"at": at, "chunks": len(chunks), "done": all_done, "players": sum(1 for v in merged.values() if v),
           "pending": pending, "upcoming": upcoming}, rp)
    writes.append({"op": "set", "collection": "statsruns", "doc_id": run, "file_path": rp.replace("\\", "/")})
    print(json.dumps(writes, ensure_ascii=False))
    print(f"# run {run}: {len(chunks)} chunks, {sum(len(v) for v in fresh.values())} new/updated results for {len(fresh)} players, "
          f"{len(meta)} windows fetched, {len(all_done)} complete, {len(pending)} still in progress")
    if failed: print("# could not read (Osirion errors), kept stored results, will retry next run:", ", ".join(failed))
    if unmatched: print("# not found in any fetched window (Epic name changed?), kept old results:", ", ".join(unmatched))

def diff(prev_dir, stats_dir, days="7"):
    """List stored events that changed between W/prev (before) and W/stats (after), within the last N days."""
    before, after = {}, {}
    for d in docs(prev_dir).values(): before.update(d["players"] if isinstance(d.get("players"), dict) else {})
    for f in glob.glob(os.path.join(stats_dir, "chunk_*.json")): after.update(body(jload(f))["players"])
    cut = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(days))).date().isoformat()
    rows = []
    for pid in sorted(set(before) | set(after)):
        b = {e["id"]: e for e in (before.get(pid) or {}).get("ev", [])}
        a = {e["id"]: e for e in (after.get(pid) or {}).get("ev", [])}
        for w in sorted(set(b) | set(a)):
            x, y = b.get(w), a.get(w)
            if (y or x)["t"] < cut: continue
            if x and y and (x["rk"], x["m"], x["pts"]) == (y["rk"], y["m"], y["pts"]): continue
            rows.append((pid, w, x, y))
    for pid, w, x, y in rows:
        f = lambda e: f"#{e['rk']}, {e['m']} games, {e['pts']} pts" if e else "none"
        state = "" if not y else (" (complete)" if y.get("c") else " (in progress)")
        print(f"{pid:16} {w.replace('S42_', ''):48} {f(x):28} -> {f(y)}{state}")
    print(f"# diff: {len(rows)} events changed in the last {days} days across {len({r[0] for r in rows})} players")

def cleanup(runs_dir, chunks_dir, snaps_dir):
    runs = sorted(docs(runs_dir).keys(), reverse=True)
    keep = set(runs[:2])
    writes = [{"op": "delete", "collection": "statsruns", "doc_id": r, "if_version": 1} for r in runs[2:]]
    for cid in docs(chunks_dir):
        if cid.rsplit("-", 1)[0] not in keep: writes.append({"op": "delete", "collection": "statschunks", "doc_id": cid, "if_version": 1})
    snaps = sorted(docs(snaps_dir).keys(), reverse=True)
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).strftime("%Y%m%d")
    kept_days = set()
    for s in snaps:
        day = s[:8]
        if day >= cutoff: continue
        if day in kept_days: writes.append({"op": "delete", "collection": "prsnaps", "doc_id": s, "if_version": 1})
        else: kept_days.add(day)
    for i in range(0, len(writes), 50): print(json.dumps(writes[i:i+50]))
    print(f"# {len(writes)} deletes")

# ---- seasons + cheat audit -------------------------------------------------------------
# Mirrors the page's market maker exactly: price = open / (1 - N*open/DEPTH),
# cost of moving net shares N -> N+n = DEPTH * ln((1-N*a)/(1-(N+n)*a)), a = open/DEPTH.
DEPTH, START_CASH, MAX_ORDER = 250000, 25000, 500

def ms(iso): return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000

def audit(portfolios_dir, players_dir, season_json, out, shocks_json="-"):
    """Replay every trade of the current season, in time order, against the shared market.
    Flags portfolios whose stored gold bars / positions don't match what their own trades produce,
    whose logs contain impossible trades, or whose recorded fill prices are far from the market.
    Writes out (a meta/audit doc) with each trader's replayed net worth."""
    import math
    season = body(jload(season_json)); n = season["n"]
    DEPTH = season.get("depth") or 250000   # the page uses the season's market depth too
    start, end = ms(season["start"]), ms(season["end"])
    ipo = season.get("ipo", {})
    opens = {pid: ipo.get(pid) or p.get("open") for pid, p in docs(players_dir).items()}
    pfs = {uid: pf for uid, pf in docs(portfolios_dir).items() if pf.get("season") == n}
    flags, dev, N = {}, {}, {}
    st = {uid: {"cash": float(START_CASH), "pos": {}} for uid in pfs}
    def flag(uid, why): flags.setdefault(uid, why)
    trades = sorted(((l.get("ts") or 0, uid, l) for uid, pf in pfs.items() for l in pf.get("log", [])), key=lambda t: (t[0], t[1]))
    sh_list = body(jload(shocks_json)) if shocks_json != "-" and os.path.exists(shocks_json) else {}
    sh_list = sh_list.get("list", []) if sh_list.get("season") == n else []
    def mult(pid, t):   # Div Cup result shocks scale a player's price from their timestamp on, same as the page
        m = 1.0
        for s in sh_list:
            if s["pid"] == pid and s["ts"] <= t: m *= s["f"]
        return m
    def fill(o, N0, k):
        a = o / DEPTH; hi = 1 - (N0 + k) * a
        return math.inf if hi <= 0 else DEPTH * math.log((1 - N0 * a) / hi) * m
    for ts, uid, l in trades:
        pid, act, k, o = l.get("pid"), l.get("a"), l.get("n"), opens.get(l.get("pid"))
        m = mult(pid, ts)
        if not isinstance(k, int) or not 0 < k <= MAX_ORDER or act not in ("buy", "sell", "short", "cover") or not o:
            flag(uid, "impossible trade in the log"); continue
        if ts < start - 60000 or ts > end + 60000:
            flag(uid, "trade outside the season"); continue
        s, N0 = st[uid], N.get(pid, 0); cur = s["pos"].get(pid)
        if act in ("buy", "short"):
            side = "long" if act == "buy" else "short"
            if cur and cur["side"] != side: flag(uid, "trade log doesn't add up"); continue
            total = fill(o, N0, k) if act == "buy" else fill(o, N0 - k, k)
            if not math.isfinite(total): flag(uid, "impossible trade in the log"); continue
            if total > s["cash"] + 250: flag(uid, "spent more gold bars than it had")
            s["cash"] -= total; sh = (cur["sh"] if cur else 0) + k
            s["pos"][pid] = {"side": side, "sh": sh, "avg": ((cur["sh"] * cur["avg"] if cur else 0) + total) / sh}
        else:
            need = "long" if act == "sell" else "short"
            if not cur or cur["side"] != need or k > cur["sh"]: flag(uid, "sold shares it didn't hold"); continue
            total = fill(o, N0 - k, k) if act == "sell" else fill(o, N0, k)
            if not math.isfinite(total): flag(uid, "impossible trade in the log"); continue
            s["cash"] += total if act == "sell" else max(0.0, 2 * cur["avg"] * k - total)
            cur["sh"] -= k
            if cur["sh"] == 0: del s["pos"][pid]
        N[pid] = N0 + (k if act in ("buy", "cover") else -k)
        px = l.get("px")
        if isinstance(px, (int, float)) and total > 0: dev[uid] = max(dev.get(uid, 0), abs(px - total / k) / (total / k))
    now = dt.datetime.now(dt.timezone.utc).timestamp() * 1000
    price = lambda pid: mult(pid, now) * opens[pid] / max(1e-6, 1 - N.get(pid, 0) * opens[pid] / DEPTH)
    nw = {}
    for uid, pf in pfs.items():
        s = st[uid]
        v = s["cash"] + sum(p["sh"] * price(pid) if p["side"] == "long" else p["sh"] * max(0, 2 * p["avg"] - price(pid)) for pid, p in s["pos"].items())
        nw[uid] = round(v)
        stored = {pid: (p.get("side"), p.get("sh")) for pid, p in (pf.get("pos") or {}).items()}
        if stored != {pid: (p["side"], p["sh"]) for pid, p in s["pos"].items()}: flag(uid, "holdings don't match its trades")
        elif abs((pf.get("cash") or 0) - s["cash"]) > max(250, 0.01 * v): flag(uid, "gold bars don't match its trades")
        elif dev.get(uid, 0) > 0.05: flag(uid, "trade prices don't match the market")
    doc = {"at": now_iso(), "season": n, "checked": len(pfs), "flags": flags, "nw": nw}
    jdump(doc, out)
    print(f"# audit season {n}: {len(pfs)} traders checked, {len(trades)} trades replayed, {len(flags)} under review")
    for uid in sorted(nw, key=lambda u: -nw[u])[:10]:
        pf = pfs[uid]; print(f"  {nw[uid]:>9,}  {pf.get('tag') or uid}  @{pf.get('discord', '')}  {('UNDER REVIEW: ' + flags[uid]) if uid in flags else 'ok'}")

def newseason(prev_json, audit_json, portfolios_dir, prsnap_json, start_iso, end_iso, out):
    """Build the next meta/season doc: archive the previous season's verified top 10 (from the audit),
    re-IPO every player at PR/100 from the latest PR snapshot, and start a new numbered season."""
    prev = body(jload(prev_json)) if prev_json != "-" else {"n": 0, "past": []}
    past = list(prev.get("past", []))
    depth = 250000
    if prev_json != "-":
        a = body(jload(audit_json)); pfs = docs(portfolios_dir)
        # market depth grows with the crowd: +250,000 per 1,000 traders who played last season (never below the base)
        depth = 250000 * max(1, a.get("checked", 0) / 1000)
        assert a["season"] == prev["n"], "audit is for a different season"
        ok = [u for u in sorted(a["nw"], key=lambda u: -a["nw"][u]) if u not in a.get("flags", {})][:10]
        past.append({"n": prev["n"], "name": prev["name"], "end": prev["end"],
                     "top": [{"tag": pfs.get(u, {}).get("tag") or "Trader", "discord": pfs.get(u, {}).get("discord", ""), "nw": a["nw"][u]} for u in ok]})
    snap = body(jload(prsnap_json))
    n = prev["n"] + 1
    doc = {"n": n, "name": f"Season {n}", "start": start_iso, "end": end_iso, "past": past, "depth": round(depth),
           "ipo": {pid: max(1, round(v / 100)) for pid, v in snap["pr"].items()}}
    jdump(doc, out)
    print(f"# Season {n}: {start_iso} -> {end_iso}, {len(doc['ipo'])} players re-IPO'd, {len(past)} past seasons archived")

def final_factor(t, rk):
    """Placement in a Division 1 Week Final -> price multiplier (None = no change). Same table as the page:
    T1: top 5 +3.5%, 6-10 even, 11+ -2.5% · T2: top 15 +10%, 16-30 even, 31+ -0.5% · T3: top 20 +10%, else even.
    Percentages tuned against a year of real Div Cup results so every heatmap stays mixed."""
    if t == 1: return 1.035 if rk <= 5 else None if rk <= 10 else 0.975
    if t == 2: return 1.10 if rk <= 15 else None if rk <= 30 else 0.995
    return 1.10 if rk <= 20 else None
SHOCK_MISS = {1: 0.95, 2: 0.9875, 3: 0.9965}    # played that week's Division 1 session but missed the Final, by tier
# FNCS Solo Qualifier rounds: within each tier and region, the top third of the pros who played move up and the
# bottom third move down by the mirror-image amount (x(1+u) vs x1/(1+u)), so every round adds as much green as red
# and the heatmaps stay balanced. Solo moves don't count toward form-tier promotions/demotions (Div Cups only).
SOLO_STEP = {1: 0.03, 2: 0.04, 3: 0.05}

def tiers(players, pr):
    """Same as the page: rank by latest PR within region; top 30 = T1, 31-100 = T2, rest = T3."""
    by = {}
    for pid, p in players.items():
        if (p.get("open") or 0) > 0: by.setdefault(p.get("region"), []).append(pid)
    out = {}
    for ids in by.values():
        for i, pid in enumerate(sorted(ids, key=lambda x: -(pr.get(x) or players[x].get("pr") or 0))):
            out[pid] = 1 if i < 30 else 2 if i < 100 else 3
    return out

def form_tiers(tier, moves):
    """Same as the page's formTiers(): within each region's last 4 Finals, a bad result in all 4 drops a pro one
    tier (T1->T2, T2->T3) and an up finish in 3 of 4 lifts them one. Uses moves already recorded (r, w, k)."""
    at = {}
    for s in moves:
        if s.get("w") and s.get("r") and s.get("k"):
            d = at.setdefault(s["r"], {}); d[s["w"]] = min(d.get(s["w"], s["ts"]), s["ts"])
    last4 = {r: set(sorted(d, key=lambda w: -d[w])[:4]) for r, d in at.items()}
    seen = {}
    for s in moves:
        if s.get("k") and s.get("w") in last4.get(s.get("r"), ()):
            seen.setdefault(s["pid"], {"top": set(), "bad": set()})[s["k"]].add(s["w"])
    out = dict(tier)
    for pid, o in seen.items():
        b = tier.get(pid)
        if not b: continue
        out[pid] = b + 1 if b < 3 and len(o["bad"]) >= 4 else b - 1 if b > 1 and len(o["top"]) >= 3 else b
    return out

def shocks(prev_json, season_json, stats_dir, prsnap_json, players_dir, out):
    """Turn finished Division 1 Week Finals into market shocks (meta/shocks). Append-only: each final is
    processed once, at the time this runs, so prices step when results come in.
    Prints NEED_PLAYERS (and writes nothing) if a new final needs tiers but players_dir is '-'."""
    season = body(jload(season_json)); n = season["n"]
    prev = body(jload(prev_json)) if prev_json != "-" and os.path.exists(prev_json) else {}
    if prev.get("season") != n: prev = {"season": n, "list": [], "done": []}
    run = body(jload(os.path.join(stats_dir, "run.json")))
    ev = {}
    for f in glob.glob(os.path.join(stats_dir, "chunk_*.json")):
        for pid, v in body(jload(f))["players"].items():
            for e in v.get("ev", []): ev.setdefault(e.get("id"), {})[pid] = e
    finished = set(run.get("done", []))
    todo = []
    for w in sorted(finished - set(prev["done"])):
        q = re.match(r"S\d+_FNCSSoloQualifiers_Qual(\d)Round(\d)(?:Day\d)?_(EU|NAC)$", w)
        if q:
            days = [e["t"] for e in ev.get(w, {}).values() if e.get("t")]
            if not days: continue
            began = next((e.get("b") for e in ev.get(w, {}).values() if e.get("b")), None)
            if (began or min(days)) < (season["start"] if began else season["start"][:10]):
                prev["done"].append(w); continue   # began before this season: skip for good
            todo.append((w, f"Q{q[1]} Round {q[2]}", "solo")); continue
        m = re.match(r"S\d+_FNCSDivisionalCup_Division1_Week(\d)Final_(EU|NAC)$", w)
        if not m: continue
        session = w.replace(f"Week{m[1]}Final", f"Event{m[1]}")
        days = [e["t"] for e in ev.get(w, {}).values() if e.get("t")]
        if not days or session not in finished: continue
        if min(days) < season["start"][:10]: prev["done"].append(w); continue   # before this season: skip for good
        todo.append((w, m[1], session))
    if not todo:
        jdump(prev, out); print(f"# shocks: no new Div Cup Finals or solo rounds ({len(prev['list'])} this season)"); return
    if players_dir == "-":
        print("NEED_PLAYERS"); return
    base = tiers(docs(players_dir), body(jload(prsnap_json)).get("pr", {}))
    now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    added = []
    for n_, (w, wk, session) in enumerate(todo):
        ts = now + n_   # keeps Finals processed in one run in order for the form-tier window
        tier = form_tiers(base, prev["list"] + added)   # PR tier, moved by recent Div Cup form
        r = "EU" if w.endswith("_EU") else "NA"
        if session == "solo":
            byt = {}
            for pid, e in ev.get(w, {}).items():
                if tier.get(pid): byt.setdefault(tier[pid], []).append((e.get("rk", 10**6), pid))
            for t, lst in byt.items():
                lst.sort(); k = len(lst) // 3; u = SOLO_STEP[t]
                for i, (rk, pid) in enumerate(lst):
                    if i < k: f = 1 + u
                    elif i >= len(lst) - k: f = 1 / (1 + u)
                    else: continue
                    added.append({"pid": pid, "ts": ts, "f": round(f, 6), "w": w, "r": r, "k": None,
                                  "why": f"#{rk} in FNCS Solos {wk} ({'top' if f > 1 else 'bottom'} third of Tier {t})"})
            prev["done"].append(w); continue
        finalists = ev.get(w, {})
        for pid, e in finalists.items():
            t = tier.get(pid); f = final_factor(t, e.get("rk", 999)) if t else None
            if f:
                added.append({"pid": pid, "ts": ts, "f": f, "w": w, "r": r, "k": "top" if f > 1 else "bad",
                              "why": f"#{e['rk']} in the Div Cup Week {wk} Final (Tier {t})"})
        for pid in ev.get(session, {}):
            t = tier.get(pid)
            if t and pid not in finalists:
                added.append({"pid": pid, "ts": ts, "f": SHOCK_MISS[t], "w": w, "r": r, "k": "bad", "why": f"Missed the Div Cup Week {wk} Final (Tier {t})"})
        prev["done"].append(w)
    prev["list"] = prev["list"] + added
    jdump(prev, out)
    print(f"# shocks: {len(todo)} new Div Cup Final(s)/solo round(s), {len(added)} price moves: " + ", ".join(f"{a['pid']} {a['f']:+.3f}".replace("+1.", "x1.").replace("+0.", "x0.") for a in added))

HIST_SEASON_START = {37: "2025-09-01", 39: "2026-01-05", 40: "2026-03-09", 41: "2026-05-25"}   # dates for the archived Div 1 Finals

def rating_kind(e):
    """Map a stored result to a rating category (weights and field sizes live in data/storm_rating_params.json)."""
    k, name = e.get("k"), e.get("e", "")
    if k == "div": return "divfinal" if "Final" in name else ("div1" if name.startswith("Division 1") else "div23")
    if k == "fncs":
        if "Grand Finals" in name: return "fncsgf"
        m = re.search(r"Round (\d)", name)
        return "fncs" + m[1] if m else "fncsx"
    return k

def rating(forms_dir, hist_txt, params_json, out_dir):
    """Storm Rating for every player from tournament results (no Fortnite Tracker data):
    raw = sum of weight[kind] * (1 - ln(rank)/ln(field+1))^expo * 0.5^(age_days/half); rating = scale * raw^gamma.
    forms_dir: JSON files with {"players": {pid: {"ev": [...]}}} (this run's W/stats, or W/prev).
    Writes out_dir/prsnap.json in the same shape the site already uses for rating history."""
    import math
    prm = jload(params_json)
    W, F, expo, half, scale, gamma = prm["W"], prm["field"], prm["expo"], prm["half"], prm["scale"], prm.get("gamma", 1.0)
    forms = {}
    for f in glob.glob(os.path.join(forms_dir, "*.json")):
        d = body(jload(f))
        if isinstance(d, dict) and isinstance(d.get("players"), dict): forms.update(d["players"])   # run.json's "players" is a count
    events = {pid: [(rating_kind(e), e.get("rk"), e.get("t")) for e in (v or {}).get("ev", [])] for pid, v in forms.items()}
    if hist_txt != "-" and os.path.exists(hist_txt):
        for line in open(hist_txt, encoding="utf-8"):
            if line.startswith("#"): continue
            parts = line.strip().split("|")
            if len(parts) < 3: continue
            m = re.match(r"S(\d+)_FNCSDivisionalCup_Division1_Week(\d)Final", parts[0])
            if not m or int(m[1]) not in HIST_SEASON_START: continue
            day = (dt.date.fromisoformat(HIST_SEASON_START[int(m[1])]) + dt.timedelta(days=7 * int(m[2]))).isoformat()
            events.setdefault(parts[1], []).append(("divfinal", int(parts[2]), day))
    today = dt.datetime.now(dt.timezone.utc).date()
    out = {}
    for pid, evs in events.items():
        tot = 0.0
        for k, rk, day in evs:
            if not rk or not day or k not in W: continue
            s = max(0.0, 1 - math.log(max(1, rk)) / math.log(F.get(k, 1000) + 1))
            tot += W[k] * s ** expo * 0.5 ** ((today - dt.date.fromisoformat(day[:10])).days / half)
        out[pid] = int(round(scale * tot ** gamma))   # fixed curve fitted once so values read like familiar PR numbers
    os.makedirs(out_dir, exist_ok=True)
    jdump({"at": now_iso(), "pr": out, "note": {}}, os.path.join(out_dir, "prsnap.json"))
    top = sorted(out, key=lambda p: -out[p])[:5]
    print(f"# rating: {len(out)} players rated; top: " + ", ".join(f"{p} {out[p]:,}" for p in top))

if __name__ == "__main__":
    mode, args = sys.argv[1], sys.argv[2:]
    {"prep": prep, "pr": pr, "stats": stats, "cleanup": cleanup, "audit": audit, "newseason": newseason, "shocks": shocks, "rating": rating, "diff": diff}[mode](*args)
