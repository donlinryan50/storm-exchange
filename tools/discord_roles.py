"""Keep Storm Exchange roles in the Discord server in sync with the website.

    python tools/discord_roles.py

  * "Verified Trader": everyone who has linked Discord on the site and is in the server.
  * "Top 10": the current season's top 10 Discord-linked traders by net worth (removed when they drop out).

Settings come from the environment or %USERPROFILE%\\.stormex\\supabase.env (same file as the Supabase key):
  DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_VERIFIED_ROLE_ID, DISCORD_TOP10_ROLE_ID (optional)
The bot needs the "Manage Roles" permission, and its own role must sit above both roles in Server Settings -> Roles.
Never prints the bot token.
"""
import json, os, sys, time, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supabase_sync as sbs

def setting(name):
    v = os.environ.get(name, "").strip()
    f = os.path.join(os.path.expanduser("~"), ".stormex", "supabase.env")
    if not v and os.path.exists(f):
        for line in open(f, encoding="utf-8-sig"):
            k, _, val = line.partition("=")
            if k.strip() == name: v = val.strip().strip('"')
    return v

BOT, GUILD = setting("DISCORD_BOT_TOKEN"), setting("DISCORD_GUILD_ID")
VERIFIED, TOP10 = setting("DISCORD_VERIFIED_ROLE_ID"), setting("DISCORD_TOP10_ROLE_ID")
API = "https://discord.com/api/v10"

def discord(method, path):
    for _ in range(5):
        req = urllib.request.Request(API + path, method=method, headers={
            "Authorization": f"Bot {BOT}", "User-Agent": "StormExchangeBot (https://stormexchange.app, 1.0)",
            "X-Audit-Log-Reason": "Storm Exchange role sync"})
        try:
            with urllib.request.urlopen(req) as r:
                txt = r.read().decode(); return r.status, (json.loads(txt) if txt else None)
        except urllib.error.HTTPError as e:
            if e.code == 429:   # rate limited: wait as Discord asks, then retry
                time.sleep(float(json.loads(e.read().decode() or "{}").get("retry_after", 1)) + .2); continue
            return e.code, None
    return 429, None

def main():
    if not (BOT and GUILD and VERIFIED):
        sys.exit("Discord role sync isn't set up (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_VERIFIED_ROLE_ID).")
    linked = {p["id"]: p["discord_id"] for p in sbs.get_all("profiles?select=id,discord_id&discord_id=not.is.null&order=id")}
    board = sorted((b for b in sbs.get_all("leaderboard?select=user_id,net_worth,prize_eligible&order=user_id") if b["prize_eligible"]),
                   key=lambda b: -float(b["net_worth"]))
    top10 = {linked[b["user_id"]] for b in board[:10] if b["user_id"] in linked}
    added = removed = missing = 0
    for did in linked.values():
        code, member = discord("GET", f"/guilds/{GUILD}/members/{did}")
        if code == 404: missing += 1; continue
        if code != 200: print(f"couldn't read a member ({code})"); continue
        have = set(member.get("roles", []))
        want = {VERIFIED} | ({TOP10} if TOP10 and did in top10 else set())
        for role in want - have:
            if discord("PUT", f"/guilds/{GUILD}/members/{did}/roles/{role}")[0] == 204: added += 1
        if TOP10 and TOP10 in have and did not in top10:
            if discord("DELETE", f"/guilds/{GUILD}/members/{did}/roles/{TOP10}")[0] == 204: removed += 1
        time.sleep(.25)
    print(f"discord roles: {len(linked)} linked traders, {missing} not in the server, {added} roles added, {removed} removed")

if __name__ == "__main__":
    main()
