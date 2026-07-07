// ig-usernames — resolves numeric Instagram sender IDs (from messaging webhooks)
// to real @usernames for display in the dashboard. The Instagram messaging API
// only gives us numeric IGSIDs; this looks up the usernames server-side using
// the clinic's stored token (never exposed to the browser) and returns a plain
// { id: username } map.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

    // Only resolve handles for the caller's own clinic.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: clinicId, error: cErr } = await userClient.rpc("my_clinic_id");
    if (cErr || !clinicId) return json({ error: "No clinic linked to this account" }, 403);

    const body = await req.json().catch(() => ({}));
    const handles: string[] = Array.isArray(body?.handles) ? body.handles : [];
    // Only numeric Instagram-scoped IDs are resolvable; ignore anything else.
    const ids = [...new Set(handles.map(String).filter((h) => /^\d+$/.test(h)))];
    if (ids.length === 0) return json({ resolved: {} });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: clinic } = await admin
      .from("clinics").select("page_access_token").eq("id", clinicId).single();
    const token = clinic?.page_access_token as string | undefined;
    if (!token) return json({ resolved: {} }); // not connected — nothing to resolve

    const resolved: Record<string, string> = {};
    // Batch up to 50 ids per Graph call.
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const res = await fetch(
          "https://graph.instagram.com/v21.0/?ids=" + encodeURIComponent(chunk.join(","))
            + "&fields=username&access_token=" + encodeURIComponent(token),
        );
        const data = await res.json();
        if (data && !data.error) {
          for (const id of chunk) {
            const u = data?.[id]?.username;
            if (u) resolved[id] = String(u);
          }
        }
      } catch (_e) { /* skip this chunk on error, keep going */ }
    }

    return json({ resolved });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
