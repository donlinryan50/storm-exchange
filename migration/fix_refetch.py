"""One-off: make build.py stats overwrite re-fetched windows completely, store each event's completion status and
schedule, report pending/upcoming windows, and add a `diff` mode that lists which stored events changed."""
import os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "build.py")
s = open(p, encoding="utf-8").read()

def rep(a, b):
    global s
    assert s.count(a) == 1, a[:70]
    s = s.replace(a, b)

rep('''    lines = open(txt, encoding="utf-8").read().strip().splitlines()
    done = []
    fresh = {}
    for line in lines:
        if line.startswith("#DONE"): done = [w for w in line[5:].strip().split(",") if w]; continue
        if "=" not in line: continue''',
'''    lines = open(txt, encoding="utf-8").read().strip().splitlines()
    done, fresh, meta, upcoming = [], {}, {}, []
    for line in lines:
        if line.startswith("#DONE"): done = [w for w in line[5:].strip().split(",") if w]; continue
        if line.startswith("#WIN "):       # a window fetched this run: w|begin|end|complete|entries
            w, b, e, c, _n = (line[5:].split("|") + ["", "", "", "0", "0"])[:5]
            meta[w] = {"b": b, "end": e, "c": c == "1"}; continue
        if line.startswith("#UPCOMING "):  # scheduled windows coming up: w|begin|end
            w, b, e = (line[10:].split("|") + ["", ""])[:3]; upcoming.append({"w": w, "b": b, "end": e}); continue
        if line.startswith("#") or "=" not in line: continue''')

rep('''            fresh.setdefault(pid, {})[w] = {"id": w, "t": d, "e": name, "k": k, "r": reg, "rk": int(rk), "pts": int(pts),
                "team": team == "1", "m": n, "w": sum(x[3] for x in mt), "el": sum(x[1] for x in mt),
                "ap": round(sum(x[0] for x in mt) / n, 1) if n else None, "mt": mt}''',
'''            wm = meta.get(w, {})
            fresh.setdefault(pid, {})[w] = {"id": w, "t": d, "e": name, "k": k, "r": reg, "rk": int(rk), "pts": int(pts),
                "team": team == "1", "m": n, "w": sum(x[3] for x in mt), "el": sum(x[1] for x in mt),
                "ap": round(sum(x[0] for x in mt) / n, 1) if n else None, "mt": mt,
                "c": wm.get("c", w in done), "b": wm.get("b") or None, "end": wm.get("end") or None}''')

rep('''    merged = {}
    for pid in players:
        evs = {e["id"]: e for e in prev.get(pid, {}).get("ev", [])}
        evs.update(fresh.get(pid, {}))''',
'''    # Every window fetched this run REPLACES what was stored for it: players who no longer appear in its
    # results (e.g. finished outside the places we read) lose their old partial entry instead of keeping it.
    fetched, done_set = set(meta), set(done)
    merged = {}
    for pid in players:
        evs = {e["id"]: e for e in prev.get(pid, {}).get("ev", []) if e.get("id") not in fetched}
        for e in evs.values():
            if "c" not in e: e["c"] = e.get("id") in done_set   # older entries: complete if their window is
        evs.update(fresh.get(pid, {}))''')

rep('''    jdump({"at": at, "chunks": len(chunks), "done": all_done, "players": sum(1 for v in merged.values() if v)}, rp)''',
'''    pending = [{"w": w, "end": m["end"]} for w, m in sorted(meta.items()) if not m["c"]]
    jdump({"at": at, "chunks": len(chunks), "done": all_done, "players": sum(1 for v in merged.values() if v),
           "pending": pending, "upcoming": upcoming}, rp)''')

rep('''    print(f"# run {run}: {len(chunks)} chunks, {sum(len(v) for v in fresh.values())} new/updated results for {len(fresh)} players, {len(all_done)} finished windows")''',
'''    print(f"# run {run}: {len(chunks)} chunks, {sum(len(v) for v in fresh.values())} new/updated results for {len(fresh)} players, "
          f"{len(meta)} windows fetched, {len(all_done)} complete, {len(pending)} still in progress")

def diff(prev_dir, stats_dir, days="7"):
    """List stored events that changed between W/prev (before) and W/stats (after), within the last N days."""
    before, after = {}, {}
    for d in docs(prev_dir).values(): before.update(d.get("players", {}))
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
    print(f"# diff: {len(rows)} events changed in the last {days} days across {len({r[0] for r in rows})} players")''')

rep('''"rating": rating}[mode](*args)''', '''"rating": rating, "diff": diff}[mode](*args)''')

# price moves only for windows that began after the season started (uses the official schedule when known)
rep('''        q = re.match(r"S\\d+_FNCSSoloQualifiers_Qual(\\d)Round(\\d)(?:Day\\d)?_(EU|NAC)$", w)
        if q:
            days = [e["t"] for e in ev.get(w, {}).values() if e.get("t")]
            if not days: continue
            if min(days) < season["start"][:10]: prev["done"].append(w); continue   # before this season: skip for good''',
'''        q = re.match(r"S\\d+_FNCSSoloQualifiers_Qual(\\d)Round(\\d)(?:Day\\d)?_(EU|NAC)$", w)
        if q:
            days = [e["t"] for e in ev.get(w, {}).values() if e.get("t")]
            if not days: continue
            began = next((e.get("b") for e in ev.get(w, {}).values() if e.get("b")), None)
            if (began or min(days)) < (season["start"] if began else season["start"][:10]):
                prev["done"].append(w); continue   # began before this season: skip for good''')

open(p, "w", encoding="utf-8").write(s)
print("ok")
