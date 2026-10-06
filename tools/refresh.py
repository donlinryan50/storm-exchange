"""Storm Exchange refresh: tournament results (Osirion's official API), Storm Ratings, price moves, market hours and
Discord roles, in one command. Runs hourly on GitHub Actions (.github/workflows/refresh.yml) and works the same locally.

    python tools/refresh.py <work dir> [--force]

Supabase credentials come from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or ~/.stormex/supabase.env); see supabase_sync.py.
Exits non-zero if a step fails, after recording the failure in site_meta 'heartbeat' so the site can warn admins.
"""
import os, subprocess, sys

T = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(T, "..", "data")
HIST = os.path.join(D, "div1_finals_history.txt")

def run(*args, check=True):
    print("$ " + " ".join(os.path.basename(a) if os.path.isabs(a) else a for a in args), flush=True)
    r = subprocess.run([sys.executable, *args], cwd=T, text=True, capture_output=True, encoding="utf-8", errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    print(out.rstrip(), flush=True)
    if check and r.returncode: raise RuntimeError(f"{os.path.basename(args[0])} failed ({r.returncode})")
    return r.returncode, out

def main(W, force=False):
    os.makedirs(W, exist_ok=True)
    py = lambda name: os.path.join(T, name)
    sync = py("supabase_sync.py")
    _, decision = run(sync, "should-run")
    if decision.startswith("SKIP") and not force:
        run(sync, "heartbeat", "skipped"); print("No event right now - skipped"); return
    first_run = "first_run_today=True" in decision
    notes = []
    try:
        run(sync, "fetch", W)
        # results from Osirion's official public API (never the website)
        run(py("build.py"), "prep", f"{W}/meta/epicmap.json", f"{W}/statsrun.json", f"{W}/in.json")
        code, _ = run(py("fetch_results.py"), f"{W}/in.json", f"{W}/osirion.txt", check=False)
        stats = code == 0
        if stats:
            _, out = run(py("build.py"), "stats", f"{W}/meta/epicmap.json", f"{W}/prev", f"{W}/osirion.txt", f"{W}/stats")
            for line in out.splitlines():
                if line.startswith("# not found") or line.startswith("# could not read"): notes.append(line[2:])
            run(sync, "push-stats", W)
        else:
            notes.append("results fetch failed; ratings use stored results, no price moves this run")
        # Storm Rating (the archived Div 1 Finals history is rebuilt from the API when missing)
        if not os.path.exists(HIST):
            os.makedirs(D, exist_ok=True)
            run(py("fetch_history.py"), f"{W}/in.json", HIST, check=False)
        forms = f"{W}/stats" if stats else f"{W}/prev"
        run(py("build.py"), "rating", forms, HIST, os.path.join(D, "storm_rating_params.json"), f"{W}/out")
        run(sync, "push-pr", W)
        if stats:
            run(py("build.py"), "shocks", f"{W}/shk/prev.json", f"{W}/season.json", f"{W}/stats", f"{W}/out/prsnap.json",
                f"{W}/players", f"{W}/shk/out.json")
            run(sync, "push-shocks", W)
        if first_run: run(sync, "cleanup")
        run(py("discord_roles.py"), check=False)
    except Exception as e:
        run(sync, "heartbeat", f"failed: {e}", check=False)
        raise
    run(sync, "heartbeat", "ok" + (" - " + "; ".join(notes) if notes else ""), "1")

if __name__ == "__main__":
    main(sys.argv[1], "--force" in sys.argv)
