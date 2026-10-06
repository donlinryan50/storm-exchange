"""Tests for the scoring code that moves live prices (tools/build.py) and the market-hours helpers.

    python -m unittest discover -s tests -v
"""
import json, math, os, sys, tempfile, unittest, io, contextlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import build as B
import supabase_sync as SS


def dump(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: json.dump(o, f)


def load(p):
    with open(p, encoding="utf-8") as f: return json.load(f)


class SoloMoves(unittest.TestCase):
    """FNCS Solo Qualifier rounds: graded by placement within tier, weighted by round."""

    def run_round(self, window, n_players=40, season_start="2026-10-01T00:00:00+00:00", began="2026-10-04T17:00:00Z"):
        d = tempfile.mkdtemp()
        players = {f"p{i:02d}": {"region": "NA", "open": 100, "pr": 100000 - i} for i in range(n_players)}
        for pid, p in players.items(): dump(f"{d}/players/{pid}.json", p)
        # rank = reverse of rating so placement order differs from tier order
        ev = {pid: {"ev": [{"id": window, "t": "2026-10-04", "rk": n_players - i, "b": began, "c": True}]}
              for i, pid in enumerate(players)}
        dump(f"{d}/stats/chunk_0.json", {"players": ev})
        dump(f"{d}/stats/run.json", {"done": [window]})
        dump(f"{d}/season.json", {"n": 1, "start": season_start})
        dump(f"{d}/prsnap.json", {"pr": {pid: p["pr"] for pid, p in players.items()}})
        with contextlib.redirect_stdout(io.StringIO()):
            B.shocks("-", f"{d}/season.json", f"{d}/stats", f"{d}/prsnap.json", f"{d}/players", f"{d}/out.json")
        return load(f"{d}/out.json")

    def test_graded_and_balanced(self):
        out = self.run_round("S42_FNCSSoloQualifiers_Qual2Round3_NAC")
        by_tier = {}
        for m in out["list"]:
            t = 1 if int(m["pid"][1:]) < 30 else 2
            by_tier.setdefault(t, []).append(m["f"])
        for t, fs in by_tier.items():
            u = B.SOLO_STEP[t]
            self.assertAlmostEqual(max(fs), 1 + u, places=5)                 # best finisher: full up move
            self.assertAlmostEqual(min(fs), 1 / (1 + u), places=5)           # worst: mirror-image down move
            self.assertAlmostEqual(sum(math.log(f) for f in fs), 0, places=4)  # as much green as red
        self.assertIn(out["list"][0]["w"], out["done"])

    def test_better_placement_never_moves_less(self):
        out = self.run_round("S42_FNCSSoloQualifiers_Qual2Round3_NAC")
        t1 = sorted(((int(m["why"].split("#")[1].split()[0]), m["f"]) for m in out["list"] if int(m["pid"][1:]) < 30))
        self.assertEqual([f for _, f in t1], sorted((f for _, f in t1), reverse=True))

    def test_round_weights(self):
        for rnd, w in ((1, 0.5), (2, 0.75), (3, 1.0)):
            name = f"S42_FNCSSoloQualifiers_Qual2Round{rnd}" + ("Day1" if rnd == 1 else "") + "_NAC"
            best = max(m["f"] for m in self.run_round(name)["list"] if int(m["pid"][1:]) < 30)
            self.assertAlmostEqual(best, 1 + B.SOLO_STEP[1] * w, places=5, msg=f"round {rnd}")

    def test_round_before_season_is_skipped(self):
        out = self.run_round("S42_FNCSSoloQualifiers_Qual2Round3_NAC", season_start="2026-10-05T00:00:00+00:00")
        self.assertEqual(out["list"], [])
        self.assertIn("S42_FNCSSoloQualifiers_Qual2Round3_NAC", out["done"])


class DivCupFinals(unittest.TestCase):
    def test_final_factor_table(self):
        self.assertEqual(B.final_factor(1, 1), 1.035)
        self.assertIsNone(B.final_factor(1, 8))
        self.assertEqual(B.final_factor(1, 11), 0.975)
        self.assertEqual(B.final_factor(2, 15), 1.10)
        self.assertEqual(B.final_factor(2, 31), 0.995)
        self.assertEqual(B.final_factor(3, 20), 1.10)
        self.assertIsNone(B.final_factor(3, 21))


class ResultsMerge(unittest.TestCase):
    """build.py stats: a re-read window replaces stored results; players found nowhere keep theirs."""

    def test_overwrite_and_keep(self):
        d = tempfile.mkdtemp()
        w = "S42_FNCSSoloQualifiers_Qual2Round1Day1_NAC"
        old = lambda rk: {"id": w, "t": "2026-10-05", "e": "x", "k": "fncs", "r": "NA", "rk": rk, "pts": 1, "m": 3, "mt": [], "c": False}
        dump(f"{d}/epicmap.json", {"a": "Alpha", "b": "Bravo", "c": "Charlie"})
        dump(f"{d}/prev/current.json", {"players": {"a": {"ev": [old(500)]}, "b": {"ev": [old(900)]}, "c": {"ev": [old(50)]}}})
        mt = "_".join(["1.2.300.0"] * 11)
        txt = "\n".join(["#DONE ", f"#WIN {w}|2026-10-05T23:00:00Z|2026-10-06T02:00:00Z|1|9000",
                         '#IDS {"acc-a": "a"}', f"a={w}|2026-10-05|120|300|0|{mt}",
                         f"b=S42_PerformanceEvaluation_Event6Round1_NAC|2026-10-02|5|400|0|{mt}"])
        with open(f"{d}/osirion.txt", "w", encoding="utf-8") as f: f.write(txt)
        with contextlib.redirect_stdout(io.StringIO()):
            B.stats(f"{d}/epicmap.json", f"{d}/prev", f"{d}/osirion.txt", f"{d}/stats")
        got = {}
        for f in os.listdir(f"{d}/stats"):
            if f.startswith("chunk_"): got.update(load(f"{d}/stats/{f}")["players"])
        ev = lambda p: {e["id"]: e for e in got[p]["ev"]}
        self.assertEqual(ev("a")[w]["rk"], 120)          # re-read: replaced with the final result
        self.assertTrue(ev("a")[w]["c"])
        self.assertNotIn(w, ev("b"))                      # found elsewhere this run but not in w: old partial entry dropped
        self.assertEqual(ev("c")[w]["rk"], 50)            # found in no window: kept (likely renamed)
        self.assertEqual(load(f"{d}/stats/epicids.json"), {"acc-a": "a"})


class MarketHours(unittest.TestCase):
    def test_window_names_and_moves_flag(self):
        self.assertEqual(SS.window_name("S42_FNCSSoloQualifiers_Qual2Round1Day1_EU"), "FNCS Solo Qualifier 2 Round 1 Day 1 (EU)")
        self.assertEqual(SS.window_name("S42_FNCSDivisionalCup_Division1_Week3Final_NAC"), "Division 1 Cup Week 3 Final (NA)")
        c = SS.closures([{"w": "S42_FNCSSoloQualifiers_Qual2Round2_NAC", "b": "2026-10-10T23:00:00Z", "end": "2026-10-11T02:00:00Z"},
                         {"w": "S42_PerformanceEvaluation_Event7Round1_EU", "b": "2026-10-08T16:00:00Z", "end": "2026-10-08T18:00:00Z"},
                         {"w": "S42_FNCSSolo_Final_Day1_EU", "b": None, "end": None}])["windows"]
        self.assertEqual([(x["r"], x["moves"]) for x in c], [("NA", True), ("EU", False)])


if __name__ == "__main__":
    unittest.main()
