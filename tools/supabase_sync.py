"""Storm Exchange refresh job <-> Supabase.

Reads what the scrapers need from the database and writes their results back. Pricing logic stays in
the database (Div Cup price moves are inserted into `shocks`; a trigger applies them to the market).

    python tools/supabase_sync.py should-run        # RUN or SKIP (event day / first run of the day)
    python tools/supabase_sync.py fetch  W          # W = a working folder; writes the inputs build.py expects
    python tools/supabase_sync.py latest-prsnap W   # newest PR snapshot -> W/out/prsnap.json (when the PR step was skipped)
    python tools/supabase_sync.py push-pr W         # W/out/prsnap.json (Storm Rating) -> prsnaps, players.pr
    python tools/supabase_sync.py push-stats W      # W/stats/chunk_*.json, run.json -> players.form, site_meta.stats
    python tools/supabase_sync.py push-shocks W     # W/shk/out.json (new entries)  -> shocks, site_meta.shocks_done
    python tools/supabase_sync.py cleanup           # trims old PR snapshots

Credentials come from the environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) or, if those aren't set,
from %USERPROFILE%\\.stormex\\supabase.env (lines like KEY=value). The service-role key bypasses row-level
security, so it must never be committed or printed; this script never prints it.
"""
import datetime as dt, glob, json, os, sys, urllib.error, urllib.parse, urllib.request

def creds():
    vals = {k: os.environ.get(k, "").strip() for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")}
    f = os.path.join(os.path.expanduser("~"), ".stormex", "supabase.env")
    if (not all(vals.values())) and os.path.exists(f):
        for line in open(f, encoding="utf-8-sig"):   # -sig: PowerShell may write a byte-order mark
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1); k = k.strip()
                if k in vals and not vals[k]: vals[k] = v.strip().strip('"')
    if not all(vals.values()):
        sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env vars or ~/.stormex/supabase.env).")
    return vals["SUPABASE_URL"].rstrip("/"), vals["SUPABASE_SERVICE_ROLE_KEY"]

URL, KEY = creds()

def call(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path.split('?')[0]}: {e.code} {e.read().decode()[:400]}")

def get_all(path):
    out, sep = [], "&" if "?" in path else "?"
    for off in range(0, 100000, 1000):
        rows = call("GET", f"{path}{sep}limit=1000&offset={off}")
        out += rows
        if len(rows) < 1000: return out

def jdump(o, p):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=True, separators=(",", ":"))
def jload(p):
    with open(p, encoding="utf-8") as f: return json.load(f)
def iso_ms(ms): return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()
def ms_iso(s): return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

def current_season():
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    rows = call("GET", "seasons?select=n,name,start_at,end_at&start_at=lte." + urllib.parse.quote(now) + "&order=n.desc&limit=1")
    return rows[0] if rows else None

def meta(key):
    rows = call("GET", f"site_meta?key=eq.{key}&select=value")
    return rows[0]["value"] if rows else None

def set_meta(key, value):
    call("POST", "site_meta?on_conflict=key", [{"key": key, "value": value}], "resolution=merge-duplicates,return=minimal")

# ---------------------------------------------------------------------------------------------
def fetch(W):
    players = get_all("players?select=id,name,region,pr,open,epic,form&active=is.true&order=id")
    jdump({p["id"]: p["epic"] for p in players if p.get("epic")}, os.path.join(W, "meta", "epicmap.json"))
    jdump({"players": {p["id"]: p["form"] for p in players if p.get("form")}}, os.path.join(W, "prev", "current.json"))
    for p in players:
        jdump({"name": p["name"], "region": p["region"], "open": p["open"], "pr": p["pr"]}, os.path.join(W, "players", p["id"] + ".json"))
    stats = meta("stats") or {}
    jdump({"done": stats.get("done", [])}, os.path.join(W, "statsrun.json"))
    s = current_season()
    if s:
        jdump({"n": s["n"], "name": s["name"], "start": s["start_at"], "end": s["end_at"]}, os.path.join(W, "season.json"))
        rows = get_all(f"shocks?select=player_id,factor,window_id,region,kind,why,at&season=eq.{s['n']}&order=id")
        sd = meta("shocks_done") or {}
        prev = {"season": s["n"], "done": sd.get("done", []) if sd.get("season") == s["n"] else [],
                "list": [{"pid": r["player_id"], "ts": ms_iso(r["at"]), "f": float(r["factor"]), "w": r["window_id"],
                          "r": r["region"], "k": r["kind"], "why": r["why"]} for r in rows]}
        jdump(prev, os.path.join(W, "shk", "prev.json"))
    print(f"fetched {len(players)} players, {len(stats.get('done', []))} finished windows, season {s['n'] if s else 'none'}")

def push_pr(W):
    """Upload a Storm Rating snapshot (W/out/prsnap.json) and store each player's current rating on players.pr."""
    snap = jload(os.path.join(W, "out", "prsnap.json"))
    sid = dt.datetime.fromisoformat(snap["at"]).strftime("%Y%m%dT%H%M")
    call("POST", "prsnaps?on_conflict=id", [{"id": sid, **snap}], "resolution=merge-duplicates,return=minimal")
    changed = 0
    for pid, v in snap["pr"].items():
        f = os.path.join(W, "players", pid + ".json")
        if os.path.exists(f) and jload(f).get("pr") == v: continue
        call("PATCH", "players?id=eq." + urllib.parse.quote(pid), {"pr": v}, "return=minimal"); changed += 1
    print(f"ratings/{sid}: {len(snap['pr'])} players, {changed} ratings changed")

def purge_fortnite_tracker(W):
    """One-time: remove every value that came from Fortnite Tracker (PR snapshots and PR history) and replace
    them with the first Storm Rating snapshot in W/out/prsnap.json. Team names and Epic names are kept."""
    snap = jload(os.path.join(W, "out", "prsnap.json"))
    day = snap["at"][:10]
    for r in get_all("prsnaps?select=id&order=id"):
        call("DELETE", "prsnaps?id=eq." + urllib.parse.quote(r["id"]), prefer="return=minimal")
    for pid, v in snap["pr"].items():
        call("PATCH", "players?id=eq." + urllib.parse.quote(pid), {"pr": v, "pr_history": [{"t": day, "pr": v}]}, "return=minimal")
    sid = dt.datetime.fromisoformat(snap["at"]).strftime("%Y%m%dT%H%M")
    call("POST", "prsnaps?on_conflict=id", [{"id": sid, **snap}], "resolution=merge-duplicates,return=minimal")
    print(f"purged Fortnite Tracker PR; {len(snap['pr'])} players now on Storm Rating (snapshot {sid})")

def push_stats(W):
    prev = jload(os.path.join(W, "prev", "current.json"))["players"]
    new = {}
    for f in glob.glob(os.path.join(W, "stats", "chunk_*.json")): new.update(jload(f)["players"])
    run = jload(os.path.join(W, "stats", "run.json"))
    changed = [pid for pid, form in new.items() if (prev.get(pid) or {}).get("ev") != form.get("ev")]
    for pid in changed:
        call("PATCH", "players?id=eq." + urllib.parse.quote(pid), {"form": new[pid]}, "return=minimal")
    set_meta("stats", {"at": run["at"], "done": run["done"]})
    print(f"stats: {len(changed)} players updated, {len(run['done'])} finished windows")

def push_shocks(W):
    prev = jload(os.path.join(W, "shk", "prev.json")); out = jload(os.path.join(W, "shk", "out.json"))
    new = out["list"][len(prev["list"]):]
    if new:
        call("POST", "shocks", [{"season": out["season"], "player_id": x["pid"], "factor": x["f"], "window_id": x.get("w"),
                                  "region": x.get("r"), "kind": x.get("k"), "why": x.get("why"), "at": iso_ms(x["ts"])} for x in new],
             "return=minimal")
    set_meta("shocks_done", {"season": out["season"], "done": out["done"]})
    print(f"shocks: {len(new)} new price moves")

def should_run():
    """RUN if an event started in the last 14 hours or starts within the hour, or it's before 10:00 local; else SKIP."""
    now = dt.datetime.now(dt.timezone.utc)
    events = (meta("events") or {}).get("events", [])
    def hours_until(e): return (dt.datetime.fromisoformat(e["t"].replace("Z", "+00:00")) - now).total_seconds() / 3600
    event_day = any(-14 <= hours_until(e) <= 1 for e in events)   # started in the last 14h, or starts within the hour
    first_run = dt.datetime.now().hour < 10
    force = os.path.join(os.path.expanduser("~"), ".stormex", "force_next_run")   # one-time manual override
    forced = os.path.exists(force)
    if forced: os.remove(force)
    print(("RUN" if event_day or first_run or forced else "SKIP") + f" event_day={event_day} first_run_today={first_run}" + (" forced=True" if forced else ""))

def latest_prsnap(W):
    rows = call("GET", "prsnaps?select=at,pr,note&order=at.desc&limit=1")
    if rows: jdump(rows[0], os.path.join(W, "out", "prsnap.json"))
    print("latest PR snapshot:", rows[0]["at"] if rows else "none")

def cleanup():
    snaps = sorted((r["id"] for r in get_all("prsnaps?select=id&order=id")), reverse=True)
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).strftime("%Y%m%d")
    seen, drop = set(), []
    for sid in snaps:
        day = sid[:8]
        if day >= cutoff: continue
        if day in seen: drop.append(sid)
        else: seen.add(day)
    for sid in drop: call("DELETE", "prsnaps?id=eq." + urllib.parse.quote(sid), prefer="return=minimal")
    print(f"cleanup: removed {len(drop)} old PR snapshots")

if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"should-run": should_run, "fetch": fetch, "latest-prsnap": latest_prsnap, "push-pr": push_pr,
     "push-stats": push_stats, "push-shocks": push_shocks, "cleanup": cleanup, "purge-fortnite-tracker": purge_fortnite_tracker}[cmd](*args)
