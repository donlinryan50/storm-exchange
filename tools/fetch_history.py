"""Rebuild data/div1_finals_history.txt (past seasons' Division 1 Week Finals, used by the Storm Rating) from Osirion's
official public API, the same source and rate limits as fetch_results.py.

    python tools/fetch_history.py <in.json> <out.txt>

in.json is the `build.py prep` input ({map, ids}); players are matched by stored Epic account id, then by name.
Output lines: window|player id|rank|date (date = the Final's scheduled day).
"""
import json, re, sys
import fetch_results as FR

SEASONS = (37, 39, 40, 41)   # the archived seasons the rating looks back over (build.py HIST_SEASON_START)

def main(in_json, out_txt):
    IN = json.load(open(in_json, encoding="utf-8"))
    exact = {e: pid for pid, e in IN["map"].items()}
    lower = {e.lower(): pid for pid, e in IN["map"].items()}
    ids = dict(IN.get("ids") or {})
    pat = re.compile(r"^S(\d+)_FNCSDivisionalCup_Division1_Week\dFinal_(EU|NAC)$")
    wins = {}
    for reg in ("EU", "NAC"):
        d, err = FR.get("/v1/tournaments", region=reg, includeHistoricData="true")
        if err: sys.exit(f"could not load the tournament list for {reg} ({err})")
        for t in d.get("tournaments", []):
            for w in t.get("eventWindows", []):
                m = pat.match(w.get("eventWindowId", ""))
                if not m or int(m[1]) not in SEASONS: continue
                loc = next((s for s in w.get("scoreLocations", []) if s.get("isMain")), None) or (w.get("scoreLocations") or [{}])[0]
                wins[w["eventWindowId"]] = (loc.get("leaderboardEventId") or t["eventId"], loc.get("leaderboardEventWindowId") or w["eventWindowId"], w["beginTime"][:10])
    lines, failed = [], []
    for i, (w, (ev, lw, day)) in enumerate(sorted(wins.items()), 1):
        rows, page = [], 0
        while True:
            d, err = FR.get("/v1/tournaments/leaderboard", leaderboardEventId=ev, leaderboardEventWindowId=lw, page=page)
            if err == 404: break
            if err: failed.append(w); rows = None; break
            lb = d.get("leaderboard") or {}
            for e in lb.get("entries", []):
                for p in e.get("players") or []:
                    acc, name = p.get("accountId"), p.get("username") or ""
                    pid = ids.get(acc) or exact.get(name) or lower.get(name.lower())
                    if pid: rows.append(f"{w}|{pid}|{e.get('rank')}|{day}")
            page += 1
            if not lb.get("entries") or page >= (lb.get("totalPages") or 0): break
        if rows is not None: lines += rows
        print(f"  [{i}/{len(wins)}] {w}: {len(rows or [])} of our players", flush=True)
    if failed: sys.exit(f"could not read {len(failed)} finals ({', '.join(failed)}); left {out_txt} unchanged")
    open(out_txt, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"wrote {out_txt}: {len(lines)} results from {len(wins)} finals")

if __name__ == "__main__":
    main(*sys.argv[1:3])
