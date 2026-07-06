// ig-connect-start — begins the Instagram OAuth connect flow for the caller's
// clinic. The browser sends the logged-in user's JWT; we resolve their clinic,
// mint a one-time CSRF `state` tied to that clinic, and hand back the Instagram
// authorize URL to redirect to. No tokens involved here.
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
    const IG_APP_ID = Deno.env.get("IG_APP_ID")!;
    const IG_REDIRECT_URI = Deno.env.get("IG_REDIRECT_URI")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    // Resolve the caller's clinic under their own Row Level Security.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: clinicId, error: cErr } = await userClient.rpc("my_clinic_id");
    if (cErr || !clinicId) return json({ error: "No clinic linked to this account" }, 403);

    // Mint a one-time state bound to this clinic (CSRF + multi-tenant mapping).
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: stateRow, error: sErr } = await admin
      .from("ig_oauth_states").insert({ clinic_id: clinicId }).select("state").single();
    if (sErr || !stateRow) return json({ error: sErr?.message ?? "Could not start connect" }, 500);

    const url = "https://www.instagram.com/oauth/authorize"
      + "?force_reauth=true"
      + `&client_id=${encodeURIComponent(IG_APP_ID)}`
      + `&redirect_uri=${encodeURIComponent(IG_REDIRECT_URI)}`
      + "&response_type=code"
      + "&scope=" + encodeURIComponent("instagram_business_basic,instagram_business_manage_messages")
      + `&state=${encodeURIComponent(stateRow.state)}`;

    return json({ url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
