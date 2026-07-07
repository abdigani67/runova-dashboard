// ig-connect-callback — Instagram redirects the clinic's browser here after they
// grant access. There is no JWT on this request; it is authenticated by the
// one-time `state` we minted in ig-connect-start. We exchange the code for a
// long-lived token, store it server-side against the clinic, subscribe to
// message webhooks, and bounce the browser back to the portal.
//
// verify_jwt = false (Instagram cannot send a Supabase JWT).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const PORTAL_URL = (Deno.env.get("PORTAL_URL") ?? "").trim();
  const redirect = (q: string) =>
    new Response(null, { status: 302, headers: { Location: `${PORTAL_URL}/?${q}` } });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // Trim to defend against secrets pasted with stray leading/trailing whitespace.
    const IG_APP_ID = (Deno.env.get("IG_APP_ID") ?? "").trim();
    const IG_APP_SECRET = (Deno.env.get("IG_APP_SECRET") ?? "").trim();
    const IG_REDIRECT_URI = (Deno.env.get("IG_REDIRECT_URI") ?? "").trim();

    const url = new URL(req.url);
    if (url.searchParams.get("error")) {
      console.error("ig-connect-callback: user denied or error", url.searchParams.get("error"));
      return redirect("connect_error=1");
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return redirect("connect_error=1");

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Validate the one-time state → clinic mapping, then consume it.
    const { data: stateRow } = await admin
      .from("ig_oauth_states").select("clinic_id,created_at").eq("state", state).single();
    if (!stateRow) return redirect("connect_error=1");
    await admin.from("ig_oauth_states").delete().eq("state", state);
    const ageMs = Date.now() - new Date(stateRow.created_at).getTime();
    if (ageMs > 10 * 60 * 1000) return redirect("connect_error=1");
    const clinicId = stateRow.clinic_id;

    // Exchange the authorization code for a short-lived token.
    const form = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: IG_REDIRECT_URI,
      code,
    });
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const shortData = await shortRes.json();
    if (!shortRes.ok || !shortData.access_token || !shortData.user_id) {
      console.error("ig-connect-callback: code exchange failed", shortData?.error_message ?? shortRes.status);
      return redirect("connect_error=1");
    }
    const shortToken = shortData.access_token as string;
    const userId = String(shortData.user_id);

    // Upgrade to a long-lived (~60 day) token.
    const longRes = await fetch(
      "https://graph.instagram.com/access_token"
        + "?grant_type=ig_exchange_token"
        + `&client_secret=${encodeURIComponent(IG_APP_SECRET)}`
        + `&access_token=${encodeURIComponent(shortToken)}`,
    );
    const longData = await longRes.json();
    if (!longRes.ok || !longData.access_token) {
      console.error("ig-connect-callback: long-lived exchange failed", longData?.error?.message ?? longRes.status);
      return redirect("connect_error=1");
    }
    const longToken = longData.access_token as string;
    const expiresIn = Number(longData.expires_in ?? 5184000);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Store the token server-side against the clinic. Never returned to a browser.
    const { error: uErr } = await admin.from("clinics").update({
      page_access_token: longToken,
      instagram_page_id: userId,
      token_expires_at: expiresAt,
      ig_connected_at: new Date().toISOString(),
    }).eq("id", clinicId);
    if (uErr) {
      console.error("ig-connect-callback: clinic update failed", uErr.message);
      return redirect("connect_error=1");
    }

    // Subscribe the app to this account's message webhooks (best-effort — a
    // failure here shouldn't undo a successful connection).
    try {
      const subRes = await fetch(
        `https://graph.instagram.com/v21.0/${encodeURIComponent(userId)}/subscribed_apps`
          + "?subscribed_fields=messages"
          + `&access_token=${encodeURIComponent(longToken)}`,
        { method: "POST" },
      );
      if (!subRes.ok) console.error("ig-connect-callback: webhook subscribe non-200", await subRes.text());
    } catch (e) {
      console.error("ig-connect-callback: webhook subscribe threw", String(e));
    }

    return redirect("connected=1");
  } catch (e) {
    console.error("ig-connect-callback: unexpected error", String(e));
    return redirect("connect_error=1");
  }
});
