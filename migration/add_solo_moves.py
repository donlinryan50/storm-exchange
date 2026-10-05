"""One-off: add FNCS Solo Qualifier price moves to tools/build.py (shocks mode)."""
import os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "build.py")
s = open(p, encoding="utf-8").read()

def rep(a, b):
    global s
    assert s.count(a) == 1, a[:70]
    s = s.replace(a, b)

rep('''SHOCK_MISS = {1: 0.95, 2: 0.9875, 3: 0.9965}    # played that week's Division 1 session but missed the Final, by tier''',
r'''SHOCK_MISS = {1: 0.95, 2: 0.9875, 3: 0.9965}    # played that week's Division 1 session but missed the Final, by tier
# FNCS Solo Qualifier rounds: within each tier and region, the top third of the pros who played move up and the
# bottom third move down by the mirror-image amount (x(1+u) vs x1/(1+u)), so every round adds as much green as red
# and the heatmaps stay balanced. Solo moves don't count toward form-tier promotions/demotions (Div Cups only).
SOLO_STEP = {1: 0.03, 2: 0.04, 3: 0.05}''')

rep(r'''    todo = []
    for w in sorted(finished - set(prev["done"])):
        m = re.match(r"S\d+_FNCSDivisionalCup_Division1_Week(\d)Final_(EU|NAC)$", w)
        if not m: continue''',
r'''    todo = []
    for w in sorted(finished - set(prev["done"])):
        q = re.match(r"S\d+_FNCSSoloQualifiers_Qual(\d)Round(\d)(?:Day\d)?_(EU|NAC)$", w)
        if q:
            days = [e["t"] for e in ev.get(w, {}).values() if e.get("t")]
            if not days: continue
            if min(days) < season["start"][:10]: prev["done"].append(w); continue   # before this season: skip for good
            todo.append((w, f"Q{q[1]} Round {q[2]}", "solo")); continue
        m = re.match(r"S\d+_FNCSDivisionalCup_Division1_Week(\d)Final_(EU|NAC)$", w)
        if not m: continue''')

rep('''print(f"# shocks: no new Div Cup Finals ({len(prev['list'])} this season)"); return''',
    '''print(f"# shocks: no new Div Cup Finals or solo rounds ({len(prev['list'])} this season)"); return''')

rep('''        r = "EU" if w.endswith("_EU") else "NA"
        finalists = ev.get(w, {})''',
'''        r = "EU" if w.endswith("_EU") else "NA"
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
        finalists = ev.get(w, {})''')

rep('''print(f"# shocks: {len(todo)} new Div Cup Final(s), {len(added)} price moves: "''',
    '''print(f"# shocks: {len(todo)} new Div Cup Final(s)/solo round(s), {len(added)} price moves: "''')

open(p, "w", encoding="utf-8").write(s)
print("ok")
