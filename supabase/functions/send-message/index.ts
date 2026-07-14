// send-message — sends a real outbound Instagram DM from a staff member typing
// in the dashboard's Conversations tab, using the clinic's stored Instagram
// token. This is a genuine human-agent reply (not automation), so it's allowed
// to use Meta's HUMAN_AGENT message tag when the standard 24-hour messaging
// window has closed, extending reachability to 7 days per Meta's messaging
// policy — but only ever as a fallback after a normal send is rejected for
// being outside the window, never proactively.
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

    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: clinicId, error: cErr } = await userClient.rpc("my_clinic_id");
    if (cErr || !clinicId) return json({ error: "No clinic linked to this account" }, 403);

    const body = await req.json().catch(() => ({}));
    const handle = String(body?.handle ?? "").trim();
    const text = String(body?.message_text ?? "").trim();
    if (!/^\d+$/.test(handle)) return json({ error: "Invalid recipient" }, 400);
    if (!text) return json({ error: "Message can't be empty" }, 400);
    if (text.length > 1000) return json({ error: "Message is too long (max 1000 characters)" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: clinic, error: tErr } = await admin
      .from("clinics").select("instagram_page_id,page_access_token").eq("id", clinicId).single();
    if (tErr) return json({ error: tErr.message }, 500);
    const token = clinic?.page_access_token as string | undefined;
    if (!token) return json({ error: "Instagram isn't connected for this clinic" }, 400);

    // Same dual-host fallback as ig-account: an Instagram-Login token only
    // works on graph.instagram.com with node "me"; a Page-token style
    // integration needs graph.facebook.com with the explicit account id.
    const bases: Array<{ base: string; node: string }> = [
      { base: "https://graph.instagram.com/v21.0", node: "me" },
      { base: "https://graph.facebook.com/v21.0", node: clinic!.instagram_page_id || "me" },
    ];

    const sendOnce = async (tag: string | null) => {
      const payload: Record<string, unknown> = { recipient: { id: handle }, message: { text } };
      if (tag) { payload.messaging_type = "MESSAGE_TAG"; payload.tag = tag; }
      let last: { ok: boolean; data: any } = { ok: false, data: { error: { message: "Could not reach the Instagram Graph API" } } };
      for (const { base, node } of bases) {
        const res = await fetch(`${base}/${node}/messages?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) return { ok: true, data };
        last = { ok: false, data };
        // Only try the other host if this one looks like a wrong-host/auth
        // problem, not a real messaging rejection (e.g. outside window).
        const code = data?.error?.code;
        if (code !== 190 && code !== 100) break;
      }
      return last;
    };

    let result = await sendOnce(null);
    let tagged = false;
    if (!result.ok) {
      const msg = String(result.data?.error?.message || "").toLowerCase();
      const outsideWindow = /window|24.?hour|outside/.test(msg) || result.data?.error?.code === 10;
      if (outsideWindow) {
        result = await sendOnce("HUMAN_AGENT");
        tagged = true;
      }
    }
    if (!result.ok) {
      const msg = result.data?.error?.message || "Instagram rejected the message";
      return json({ error: tagged ? `${msg} (this lead hasn't messaged in over 7 days, so Instagram won't allow a reply until they message you again)` : msg }, 502);
    }

    // Don't write to conversations/leads here — the Make.com DM engine already
    // gets an "echo" webhook for every message this account sends (regardless
    // of whether it was typed in the Instagram app or sent via this API call),
    // and its own "Human takeover" branch logs it to conversations (with the
    // real Instagram message_id) and sets handoff_status/ai_active. Writing
    // here too raced that webhook and produced a duplicate row for every send.
    return json({ ok: true, tagged });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
