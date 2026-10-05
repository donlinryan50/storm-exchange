"""Upload the data exported from the old claude.ai version of Storm Exchange into Supabase.

Run once, after supabase/schema.sql:
    set SUPABASE_URL=https://YOUR-PROJECT.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=...          (Supabase -> Project Settings -> API -> service_role, keep it secret)
    python migration/seed.py

The service-role key bypasses row-level security, so it only ever lives in your environment on this
machine (and later in the refresh job). Never put it in the website or commit it to Git.
Safe to re-run: every row is an upsert.
"""
import json, os, glob, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.join(HERE, "artifact-export")

def env(name):
    v = os.environ.get(name, "").strip()
    if not v: sys.exit(f"Set {name} first (see the top of this file).")
    return v

URL = env("SUPABASE_URL").rstrip("/")
KEY = env("SUPABASE_SERVICE_ROLE_KEY")

def upsert(table, rows, conflict=None, batch=50):
    for i in range(0, len(rows), batch):
        body = json.dumps(rows[i:i + batch]).encode()
        q = f"?on_conflict={conflict}" if conflict else ""
        req = urllib.request.Request(f"{URL}/rest/v1/{table}{q}", data=body, method="POST", headers={
            "apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"})
        try:
            urllib.request.urlopen(req).read()
        except urllib.error.HTTPError as e:
            sys.exit(f"{table}: {e.code} {e.read().decode()[:500]}")
    print(f"  {table}: {len(rows)} rows")

def load(p): return json.load(open(p, encoding="utf-8"))

def main():
    epic = load(os.path.join(EXP, "meta", "epicmap.json"))
    form = {}
    for f in glob.glob(os.path.join(EXP, "statschunks", "*.json")):
        form.update(load(f)["players"])
    stats_at = max(load(f)["at"] for f in glob.glob(os.path.join(EXP, "statsruns", "*.json")))
    players = []
    for f in sorted(glob.glob(os.path.join(EXP, "players", "*.json"))):
        pid = os.path.basename(f)[:-5]; d = load(f)
        # no rating fields: Fortnite Tracker PR must not be re-uploaded; the refresh job's Storm Rating fills players.pr
        players.append({"id": pid, "name": d["name"], "region": d["region"],
                        "open": int(d["open"]), "note": d.get("note") or None, "listed": (d.get("listed") or "2026-10-04")[:10],
                        "epic": epic.get(pid), "form": form.get(pid) or d.get("form"), "active": True})
    s = load(os.path.join(EXP, "meta", "season.json"))
    season = {"n": s["n"], "name": s["name"], "start_at": s["start"], "end_at": s["end"],
              "depth": s.get("depth") or 250000, "ipo": s.get("ipo") or {}, "past": s.get("past") or []}
    events = load(os.path.join(EXP, "meta", "events.json"))
    sim = load(os.path.join(EXP, "meta", "simskill.json"))
    print("Uploading to", URL)
    upsert("players", players, "id")
    upsert("seasons", [season], "n")
    upsert("site_meta", [{"key": "events", "value": events},
                         {"key": "simskill", "value": sim},
                         {"key": "stats", "value": {"at": stats_at}}], "key")
    print("Done. Open the site and check the Market tab.")

if __name__ == "__main__":
    main()
