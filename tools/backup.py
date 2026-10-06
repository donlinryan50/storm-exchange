"""Export every Storm Exchange table to JSON files (a backup of trades, portfolios, prices and players).

    python tools/backup.py <out dir>

Uses the service-role key like supabase_sync.py. Sign-in accounts (emails, password hashes) live in Supabase Auth and
aren't included; they're covered by Supabase's own backups.
"""
import json, os, sys
import supabase_sync as s

TABLES = {   # table -> column to page by (stable order)
    "profiles": "id", "admins": "user_id", "players": "id", "seasons": "n", "market": "player_id",
    "portfolios": "user_id", "positions": "user_id", "trades": "id", "shocks": "id", "prsnaps": "id", "site_meta": "key",
}

def main(out):
    os.makedirs(out, exist_ok=True)
    for table, order in TABLES.items():
        rows = s.get_all(f"{table}?select=*&order={order}")
        with open(os.path.join(out, table + ".json"), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        print(f"{table}: {len(rows)} rows")

if __name__ == "__main__":
    main(sys.argv[1])
