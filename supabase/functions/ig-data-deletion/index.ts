// ig-data-deletion — Meta calls this (POST, signed_request form field) when a
// user requests deletion of their data. We verify Meta's signature, clear the
// clinic's stored Instagram token (token-only erasure — leads/conversations are
// retained), record a deletion request, and return the confirmation URL + code
// in the exact shape Meta requires.
//
// verify_jwt = false; authenticity comes from the signed_request HMAC.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function parseSignedRequest(signed: string, secret: string): Promise<Record<string, unknown> | null> {
  const dot = signed.indexOf(".");
  if (dot < 0) return null;
  const sigB64 = signed.slice(0, dot);
  const payloadB64 = signed.slice(dot + 1);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)));
  const provided = b64urlToBytes(sigB64);
  if (expected.length !== provided.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  try {
    const IG_APP_SECRET = (Deno.env.get("IG_APP_SECRET") ?? "").trim();
    const PORTAL_URL = (Deno.env.get("PORTAL_URL") ?? "").trim();
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const form = await req.formData();
    const signed = form.get("signed_request");
    if (typeof signed !== "string") return json({ error: "Missing signed_request" }, 400);

    const payload = await parseSignedRequest(signed, IG_APP_SECRET);
    if (!payload || !payload.user_id) return json({ error: "Bad signature" }, 400);
    const userId = String(payload.user_id);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Token-only erasure: sever Instagram access; retain the clinic's CRM data.
    await admin.from("clinics")
      .update({ page_access_token: null, token_expires_at: null, ig_connected_at: null })
      .eq("instagram_page_id", userId);

    // Record the request and hand Meta a trackable confirmation code + URL.
    const confirmationCode = crypto.randomUUID().replace(/-/g, "");
    await admin.from("ig_deletion_requests")
      .insert({ confirmation_code: confirmationCode, instagram_page_id: userId, status: "received" });

    return json({
      url: `${PORTAL_URL}/deletion-status.html?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  } catch (e) {
    console.error("ig-data-deletion error", String(e));
    return json({ error: "Server error" }, 500);
  }
});
