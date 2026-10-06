# Storm Exchange

A Fortnite pro-player stock market: bet up or down on pros, climb the season leaderboard.

```
web/              the website (plain HTML/CSS/JS, no build step)
  index.html  styles.css  app.js
  config.js       your Supabase URL + public anon key (safe to publish)
supabase/
  schema.sql      database tables, security rules and server-side trading (run once)
migration/
  seed.py         uploads players, a year of tournament stats, events and Season 1
tools/            hourly refresh (refresh.py), results/rating/price-move builders, backup
tests/            tests for the scoring rules
.github/workflows refresh (hourly), backup (nightly), tests
vercel.json       hosting settings + security headers
```

## How it's secured

- **Accounts:** username + password through Supabase Auth (passwords are hashed by Supabase, never stored by us).
  Logging in with a username is checked server-side, and 5 wrong passwords lock that username for 15 minutes.
  Email is only used to confirm the account and reset passwords; it's never shown.
- **Discord:** "Link Discord" logs in to Discord itself, so linked accounts are verified. Linked
  traders' real Discord name and avatar show on the leaderboard.
- **Trades run on the server.** The browser can only *read* the market. Every trade goes through the
  `trade()` database function, which prices the order, checks gold bars, the 40% cap and position rules,
  and updates everything in one transaction. Nobody can edit their own gold bars or positions.
- **Row-level security** is on for every table. Admin actions check an `admins` table.
- **Secrets:** the website only contains the public *anon* key. The *service_role* key (full access)
  is only ever set as an environment variable on your machine for `seed.py` and the refresh job.
- **Headers:** `vercel.json` sets a strict Content-Security-Policy, HSTS (HTTPS only), no framing,
  no sniffing. The Supabase library is pinned to an exact version with an integrity hash.

## Setup (about 30 minutes)

### 1. Supabase (database + logins)
1. Create a free account at <https://supabase.com> and a **New project** (pick a region near your players,
   save the database password somewhere safe).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. It should finish with "Success".
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `web/config.js`.
4. **Authentication → Sign In / Providers**:
   - **Email**: leave enabled, keep "Confirm email" on.
   - Turn on **Allow manual linking** (needed for "Link Discord").
5. **Authentication → URL Configuration**:
   - Site URL: your website address (use `http://127.0.0.1:5173` until you deploy, then change it).
   - Redirect URLs: add `http://127.0.0.1:5173` and, after deploying, your live address.

### 2. Discord login
1. Go to <https://discord.com/developers/applications> → **New Application** → name it "Storm Exchange".
2. **OAuth2**: copy the **Client ID**, click **Reset Secret** and copy the **Client Secret**.
   Under **Redirects** add: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
3. In Supabase: **Authentication → Sign In / Providers → Discord** → enable, paste the Client ID and
   Client Secret → Save. (Type these into Supabase yourself; the secret never goes in the website.)

### 3. Load the data
In a terminal in this folder (Command Prompt shown; the service_role key is under Project Settings → API):
```
set SUPABASE_URL=https://YOUR-PROJECT.supabase.co
set SUPABASE_SERVICE_ROLE_KEY=paste-the-service_role-key
python migration\seed.py
```
It uploads 394 players, their tournament results, the event schedule and Season 1.

### 4. Try it locally
```
python -m http.server 5173 --directory web --bind 127.0.0.1
```
Open <http://127.0.0.1:5173>, create an account, confirm the email, log in, link Discord and make a trade.

### 5. Make yourself an admin
Supabase **SQL Editor**:
```sql
insert into admins (user_id) select id from profiles where username = 'YOUR-USERNAME';
```
Reload the site: the admin tools (list a player, season end date, Discord invite) appear at the bottom
of the Market tab, and the **Test run** button appears in the nav.

### 6. Put it online (Vercel)
1. Create a repository on <https://github.com/new> (private is fine).
2. In this folder:
   ```
   git init
   git add .
   git commit -m "Storm Exchange"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/storm-exchange.git
   git push -u origin main
   ```
3. At <https://vercel.com/new>, import the repository. Framework preset: **Other**. Leave the build command
   empty; `vercel.json` serves the `web` folder. Click **Deploy**.
4. Copy the live address (like `storm-exchange.vercel.app`) into Supabase → Authentication → URL
   Configuration (Site URL and Redirect URLs).
5. Optional: Vercel → your project → **Domains** to add a custom domain like `stormexchange.gg`.

### 7. Before a public launch
- **Email:** Supabase's built-in email sender only allows a few emails per hour. Connect a real sender
  (Authentication → Emails → SMTP Settings, e.g. Resend or Postmark) so sign-up and reset emails always arrive.
- **Prizes:** keep entry free. Paid entry for cash prizes can fall under gambling or sweepstakes laws.

## Hourly refresh (GitHub Actions)
`.github/workflows/refresh.yml` runs `tools/refresh.py` every hour. Most hours it checks the schedule and stops; when a
tournament is on or results are pending it does the full refresh:
- **Tournament results** from Osirion's official public API (`tools/fetch_results.py`, <https://fnapi.osirion.gg>,
  under its [API Terms](https://osirion.gg/legal/license), paced under the 60 requests/minute limit) → `players.form`.
  Never scrape the Osirion website itself: its Terms of Service forbid it.
- **Storm Rating**: our own player rating from those results plus past seasons' Division 1 Finals
  (`tools/fetch_history.py`, from the same API; settings in `data/storm_rating_params.json`). No Fortnite Tracker data.
- **Tournament price moves** (Div Cup Finals, FNCS Solo Qualifier rounds) → `shocks`, applied to prices by the database.
- **Market hours**: the round schedule → `site_meta.closures`; `trade()` refuses trades on a region's players while its
  round is played and until its price moves are posted (`supabase/market_hours.sql`).
- **Discord roles** (`discord_roles.py`) and a heartbeat the site uses to warn admins if the refresh stops.

Repository secrets (Settings → Secrets and variables → Actions): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`BACKUP_PASSPHRASE`, and optionally `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_VERIFIED_ROLE_ID`,
`DISCORD_TOP10_ROLE_ID`. Run it by hand from the Actions tab (Refresh → Run workflow). Locally:
`python tools/refresh.py <work dir>` reads the key from `%USERPROFILE%\.stormex\supabase.env`, never from the repo.

## Backups and tests
- `.github/workflows/backup.yml` exports every table nightly (`tools/backup.py`), encrypts it with `BACKUP_PASSPHRASE`
  and keeps it 30 days as a workflow artifact. Restore: download it, then
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in stormex-backup.tar.gz.enc -out backup.tar.gz`.
- `tests/test_build.py` checks the scoring rules that move prices. They run on every push and before every refresh:
  `python -m unittest discover -s tests -v`.

## Legal pages
`web/terms.html` and `web/privacy.html`, linked from the footer and the sign-up form. New accounts must confirm they're
13+ and accept them (`supabase/site_updates.sql`). There are no prizes yet; the database keeps an unused
`confirm_prize_eligibility()` for when they're added (they'll need Official Prize Rules and a legal review first).
