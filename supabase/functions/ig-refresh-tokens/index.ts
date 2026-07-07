// ig-refresh-tokens — daily job that extends long-lived Instagram tokens before
// they expire. Instagram's ig_refresh_token grant renews a token that is at
// least 24h old and not yet expired, giving another ~60 days.
//
// verify_jwt = false; instead we require a shared secret header so only our
// pg_cron scheduler (or an operator) can invoke it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "Forbidden" }, 403);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const nowMs = Date.now();
  const in7Days = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  // Only tokens expiring within 7 days, connected more than 24h ago (Instagram
  // rejects refresh of tokens younger than a day).
  const { data: clinics, error } = await admin
    .from("clinics")
    .select("id,page_access_token,token_expires_at,ig_connected_at")
    .not("page_access_token", "is", null)
    .not("token_expires_at", "is", null)
    .lte("token_expires_at", in7Days)
    .lte("ig_connected_at", dayAgo);

  if (error) return json({ error: error.message }, 500);

  const results: Array<{ clinic_id: string; ok: boolean; detail?: string }> = [];

  for (const c of clinics ?? []) {
    try {
      const res = await fetch(
        "https://graph.instagram.com/refresh_access_token"
          + "?grant_type=ig_refresh_token"
          + `&access_token=${encodeURIComponent(c.page_access_token as string)}`,
      );
      const data = await res.json();
      if (!res.ok || !data.access_token) {
        results.push({ clinic_id: c.id, ok: false, detail: data?.error?.message ?? `status ${res.status}` });
        continue; // never let one clinic fail the whole batch
      }
      const expiresIn = Number(data.expires_in ?? 5184000);
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const { error: uErr } = await admin.from("clinics")
        .update({ page_access_token: data.access_token, token_expires_at: expiresAt })
        .eq("id", c.id);
      results.push({ clinic_id: c.id, ok: !uErr, detail: uErr?.message });
    } catch (e) {
      results.push({ clinic_id: c.id, ok: false, detail: String((e as Error)?.message ?? e) });
    }
  }

  return json({ checked: clinics?.length ?? 0, refreshed: results.filter((r) => r.ok).length, results });
});
