// ig-account — returns the connected Instagram account's profile fields and
// recent media for the caller's clinic.
//
// Why an Edge Function: the Instagram access token must never reach the browser.
// This runs server-side, resolves the caller's clinic from their JWT, reads the
// token with the service role, calls the Graph API, and returns ONLY public
// profile + media JSON. It's what demonstrates the `instagram_business_basic`
// permission (profile fields + media list) for Meta App Review.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    // Resolve the caller's clinic under their own Row Level Security.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: clinicId, error: cErr } = await userClient.rpc("my_clinic_id");
    if (cErr || !clinicId) return json({ error: "No clinic linked to this account" }, 403);

    // Read the token with the service role — it is never returned to the client.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: clinic, error: tErr } = await admin
      .from("clinics").select("instagram_page_id,page_access_token").eq("id", clinicId).single();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!clinic?.page_access_token) return json({ not_connected: true });

    const token = clinic.page_access_token as string;
    const mediaFields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";

    // Instagram API with Instagram Login (graph.instagram.com) first; fall back
    // to the Facebook Graph host for Page-token style integrations. Whichever the
    // stored token belongs to, one of these resolves.
    const bases = ["https://graph.instagram.com/v21.0", "https://graph.facebook.com/v21.0"];
    let lastErr = "Could not reach the Instagram Graph API";
    for (const base of bases) {
      const isIg = base.includes("instagram.com");
      // An Instagram-Login token is always scoped to one account, so `me` is the
      // correct node on graph.instagram.com regardless of the stored id. The
      // Facebook fallback still needs the explicit Instagram business account id.
      const node = isIg ? "me" : (clinic.instagram_page_id || "me");
      const pFields = (isIg ? "user_id," : "") + "username,name,biography,followers_count,media_count,profile_picture_url";
      const pRes = await fetch(`${base}/${node}?fields=${pFields}&access_token=${token}`);
      const profile = await pRes.json();
      if (profile.error) { lastErr = profile.error.message ?? String(profile.error); continue; }

      const mRes = await fetch(`${base}/${node}/media?fields=${mediaFields}&limit=9&access_token=${token}`);
      const media = await mRes.json();

      return json({
        profile: { ...profile, id: profile.user_id ?? profile.id ?? clinic.instagram_page_id },
        media: Array.isArray(media?.data) ? media.data : [],
      });
    }
    return json({ error: lastErr }, 502);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
