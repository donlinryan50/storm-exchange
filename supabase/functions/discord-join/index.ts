// Supabase Edge Function: discord-join
// Adds a signed-in Storm Exchange player to the Storm Exchange Discord server and gives them the
// "Verified Trader" role, right after they link Discord on the site.
//
// The browser sends the Discord access token it just received from linking (scope guilds.join).
// We check the caller is signed in, that their profile has a linked Discord account, and that the token
// really belongs to that same Discord account, then the bot adds them. The bot token never leaves the server.
//
// Secrets (Supabase -> Edge Functions -> Secrets): DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_VERIFIED_ROLE_ID (optional)
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically.
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://discord.com/api/v10";
const ALLOWED_ORIGINS = new Set([
  "https://stormexchange.app", "https://www.stormexchange.app",
  "https://storm-exchange.vercel.app", "http://127.0.0.1:5173",
]);

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://stormexchange.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const BOT = Deno.env.get("DISCORD_BOT_TOKEN"), GUILD = Deno.env.get("DISCORD_GUILD_ID");
  const ROLE = Deno.env.get("DISCORD_VERIFIED_ROLE_ID") ?? "";
  if (!BOT || !GUILD) return json({ error: "The Discord bot isn't set up yet." }, 503);

  try {
    // 1. who is calling? (their Supabase login, checked by Supabase)
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "Log in first." }, 401);
    const { data: prof } = await sb.from("profiles").select("discord_id").eq("id", user.id).maybeSingle();
    if (!prof?.discord_id) return json({ error: "Link your Discord account first." }, 400);

    // 2. the Discord token must belong to that same linked Discord account
    const { access_token } = await req.json().catch(() => ({}));
    if (typeof access_token !== "string" || access_token.length < 10 || access_token.length > 200) {
      return json({ error: "Missing Discord login. Try linking Discord again." }, 400);
    }
    const me = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!me.ok) return json({ error: "Discord didn't accept that login. Try linking again." }, 400);
    const du = await me.json();
    if (du.id !== prof.discord_id) return json({ error: "That Discord login doesn't match your linked account." }, 403);

    // 3. add them to the server (201 = joined, 204 = already a member)
    const bot = { Authorization: `Bot ${BOT}`, "Content-Type": "application/json" };
    const r = await fetch(`${API}/guilds/${GUILD}/members/${du.id}`, {
      method: "PUT", headers: bot, body: JSON.stringify({ access_token, ...(ROLE ? { roles: [ROLE] } : {}) }),
    });
    if (r.status === 201) return json({ joined: true });
    if (r.status === 204) {
      if (ROLE) await fetch(`${API}/guilds/${GUILD}/members/${du.id}/roles/${ROLE}`, { method: "PUT", headers: bot });
      return json({ joined: false, alreadyMember: true });
    }
    const detail = await r.text();
    console.error("discord add member failed", r.status, detail.slice(0, 300));
    return json({ error: r.status === 403 ? "The bot can't add members. Check its permissions and role order." : "Discord couldn't add you right now." }, 502);
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});
