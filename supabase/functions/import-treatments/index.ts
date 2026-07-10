// import-treatments — pulls a clinic's treatment menu + prices from their booking
// platform and returns a cleaned, insert-ready treatment list (optionally writing
// it straight into the clinic's `treatments` table).
//
// Pipeline (proving end to end; no UI yet):
//   1) SOURCE   — either a booking URL (Fresha supported) or pasted price-list text.
//                 Fresha pages embed the full menu as JSON in __NEXT_DATA__, so a
//                 plain server-side fetch + parse works. Cloudflare-locked platforms
//                 (That-Time/MyTime) block server fetches → we return needs_fallback
//                 so the caller can switch to the paste input.
//   2) CLEANUP  — Claude standardises names (using category context to disambiguate
//                 e.g. "1ml" → "Face Filler 1ml"), fixes HTML junk and deliberate
//                 Botox obfuscations, parses prices/durations, and returns strict
//                 JSON matching the treatments schema. Falls back to a basic
//                 non-AI normaliser if ANTHROPIC_API_KEY isn't set.
//   3) INSERT   — with commit=true, rows are written to `treatments` for the clinic.
//
// The Instagram token and other secrets never touch this path. Read-only unless
// commit=true is explicitly passed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── types ────────────────────────────────────────────────────────────────────
interface RawItem {
  category?: string | null;
  name: string;
  caption?: string | null; // e.g. "30 min"
  price?: number | null; // "from" price in GBP
  formatted_price?: string | null; // e.g. "from £150"
  description?: string | null;
  variants?: string[] | null; // sub-option names, for context
}
interface Treatment {
  treatment_name: string;
  price_from: number | null;
  price_to: number | null;
  duration_mins: number | null;
  description: string | null;
  active: boolean;
}

// ── Fresha ───────────────────────────────────────────────────────────────────
function isChallengePage(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /attention required|just a moment|checking your browser|cf-challenge|verify you are human/i
    .test(body.slice(0, 4000));
}

// Fresha embeds the whole menu in <script id="__NEXT_DATA__">. Services are grouped
// by category at props.pageProps.data.location.services[] → { name, items[] }.
function parseFresha(html: string): RawItem[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const groups = data?.props?.pageProps?.data?.location?.services;
  if (!Array.isArray(groups)) return [];
  const out: RawItem[] = [];
  for (const g of groups) {
    const category = typeof g?.name === "string" ? g.name : null;
    const items = Array.isArray(g?.items) ? g.items : [];
    for (const it of items) {
      if (!it || typeof it.name !== "string") continue;
      out.push({
        category,
        name: it.name,
        caption: it.caption ?? null,
        price: typeof it?.retailPrice?.value === "number" ? it.retailPrice.value : null,
        formatted_price: it.formattedRetailPrice ?? null,
        description: it.description ?? null,
        variants: Array.isArray(it.variants)
          ? it.variants.map((v: any) => v?.name).filter((n: any) => typeof n === "string")
          : null,
      });
    }
  }
  return out;
}

// ── basic (no-AI) normaliser — used only when ANTHROPIC_API_KEY is missing ─────
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&pound;/g, "£").replace(/&#163;/g, "£").replace(/\s+/g, " ").trim();
}
function basicClean(items: RawItem[]): Treatment[] {
  return items.map((it) => {
    const mins = it.caption && /(\d+)\s*min/i.test(it.caption)
      ? parseInt(it.caption.match(/(\d+)\s*min/i)![1], 10) : null;
    let name = decodeEntities(it.name);
    if (it.category && /^\s*[\d.]+\s*ml\s*$/i.test(it.name)) {
      name = `${decodeEntities(it.category)} ${name}`;
    }
    return {
      treatment_name: name,
      price_from: typeof it.price === "number" ? it.price : null,
      price_to: null,
      duration_mins: mins,
      description: it.description ? decodeEntities(it.description) : null,
      active: true,
    };
  });
}

// ── Claude cleanup ─────────────────────────────────────────────────────────────
const CLEAN_SYSTEM =
  `You clean raw treatment/price data for a UK aesthetics clinic and return it insert-ready.
You receive EITHER structured items scraped from a booking page (each may include a category, name, caption, price, formatted_price, variants) OR a block of pasted price-list text.
Return ONLY a JSON array (no prose, no code fence). Each element:
{"treatment_name":string,"price_from":number|null,"price_to":number|null,"duration_mins":integer|null,"description":string|null,"active":true}
Rules:
- treatment_name: clear, human-readable, Title Case. Use the category to disambiguate vague names: category "Face Fillers" + name "1ml" => "Face Filler 1ml"; category "Lips" + "1ml" => "Lip Filler 1ml". Fix HTML entities (&amp; => &). Normalise deliberate Botox obfuscations ("B*tox","Btox","B*TOX","Btx") to "Anti-Wrinkle (Botox)"; keep the area/qty if present, e.g. "Anti-Wrinkle (Botox) - 2 Areas".
- price_from: numeric GBP only (strip "£", "from", commas). If a range like "£150-£250" is given, price_from=150, price_to=250; otherwise price_to=null.
- duration_mins: integer minutes if derivable ("30 min" => 30, "1 hr" => 60), else null.
- description: short and only if genuinely present in the input; else null. NEVER invent prices, treatments, durations, or medical claims.
- active: always true.
- Merge obvious exact duplicates. Skip rows that are clearly not treatments (e.g. a "£5 Video Consultation" booking deposit), but keep real bookable consultations.
Return the JSON array and nothing else.`;

function extractJsonArray(text: string): Treatment[] {
  // pull the first top-level [ ... ] out of the model response
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON array in model output (got: ${JSON.stringify(text.slice(0, 200))})`);
  }
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("model output not an array");
  return arr;
}

async function claudeClean(
  apiKey: string,
  payload: { items?: RawItem[]; text?: string },
): Promise<Treatment[]> {
  const userContent = payload.items
    ? `Structured scraped items (JSON):\n${JSON.stringify(payload.items)}`
    : `Pasted price list text:\n${payload.text}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Renaming/normalising a scraped price list is mechanical structured
      // cleanup, not reasoning-heavy — Haiku handles it well at ~1/3 the
      // Sonnet cost (this task doesn't need Sonnet-tier judgment).
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      system: CLEAN_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data?.content ?? []).map((b: any) => b?.text ?? "").join("");
  // A large scraped menu can exhaust max_tokens before Claude closes the JSON
  // array — surface that distinctly rather than the generic "no array" error.
  if (data?.stop_reason === "max_tokens") {
    throw new Error(
      `model output truncated at max_tokens before completing the JSON array (${payload.items?.length ?? 0} raw items)`,
    );
  }
  return extractJsonArray(text);
}

// sanity-filter whatever the cleanup step returns so we never insert garbage
function sanitise(rows: Treatment[]): Treatment[] {
  const out: Treatment[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = typeof r?.treatment_name === "string" ? r.treatment_name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // price_from/price_to/duration_mins are INTEGER columns — round to avoid insert errors
    const money = (v: unknown) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v) : null);
    const int = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : null);
    out.push({
      treatment_name: name.slice(0, 200),
      price_from: money(r.price_from),
      price_to: money(r.price_to),
      duration_mins: int(r.duration_mins),
      description: typeof r.description === "string" && r.description.trim()
        ? r.description.trim().slice(0, 2000) : null,
      active: true,
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const url: string | undefined = typeof body?.url === "string" ? body.url.trim() : undefined;
    const text: string | undefined = typeof body?.text === "string" ? body.text : undefined;
    const commit = body?.commit === true;

    // Resolve which clinic we're importing for. Normal calls: the signed-in user's
    // own clinic. Service-role calls (server-to-server / testing): an explicit
    // clinic_id in the body is trusted, since only the service key can reach here.
    let clinicId: string | null = null;
    const role = (() => {
      try { return JSON.parse(atob(authHeader.replace(/^Bearer\s+/i, "").split(".")[1]))?.role; }
      catch { return undefined; }
    })();
    if (role === "service_role") {
      clinicId = typeof body?.clinic_id === "string" ? body.clinic_id : null;
      if (!clinicId) return json({ error: "service-role call requires clinic_id" }, 400);
    } else {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data, error } = await userClient.rpc("my_clinic_id");
      if (error || !data) return json({ error: "No clinic linked to this account" }, 403);
      clinicId = data as string;
    }

    // ── 1) SOURCE ──────────────────────────────────────────────────────────────
    let rawItems: RawItem[] | null = null;
    let source = "";
    if (text && text.trim()) {
      source = "paste";
    } else if (url) {
      let host = "";
      try { host = new URL(url).hostname; } catch { return json({ error: "Invalid URL" }, 400); }
      if (!/(^|\.)fresha\.com$/i.test(host)) {
        // Only Fresha is wired up for URL import in this first version.
        return json({
          needs_fallback: true,
          reason: "unsupported_platform",
          message: "URL import currently supports Fresha only. Paste the price list text instead.",
        });
      }
      source = "fresha";
      const resp = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept": "text/html" }, redirect: "follow" });
      const html = await resp.text();
      if (isChallengePage(resp.status, html)) {
        return json({
          needs_fallback: true,
          reason: "blocked",
          message: "This booking site blocked the server fetch (bot protection). Paste the price list text instead.",
        });
      }
      rawItems = parseFresha(html);
      if (rawItems.length === 0) {
        return json({
          needs_fallback: true,
          reason: "no_data",
          message: "Couldn't find a treatment menu on that page. Paste the price list text instead.",
        });
      }
    } else {
      return json({ error: "Provide a booking `url` or price-list `text`." }, 400);
    }

    // ── 2) CLEANUP ───────────────────────────────────────────────────────────────
    let treatments: Treatment[];
    let cleanup: string;
    if (ANTHROPIC_API_KEY) {
      try {
        treatments = sanitise(await claudeClean(ANTHROPIC_API_KEY, rawItems ? { items: rawItems } : { text }));
        cleanup = "claude";
      } catch (e) {
        // A large/unusual menu can make Claude cleanup fail (truncation, no
        // JSON in the reply, etc). If we have structured scraped items, fall
        // back to the basic normaliser instead of failing the whole import —
        // worse quality names, but the clinic still gets something to edit.
        console.error("claudeClean failed:", (e as Error)?.message ?? e);
        if (!rawItems) throw e;
        treatments = sanitise(basicClean(rawItems));
        cleanup = "basic (Claude cleanup failed — used basic normaliser; edit treatment names if needed)";
      }
    } else if (rawItems) {
      treatments = sanitise(basicClean(rawItems));
      cleanup = "basic (ANTHROPIC_API_KEY not set — set it for full Claude cleanup)";
    } else {
      return json({ error: "Pasted text needs ANTHROPIC_API_KEY for cleanup." }, 400);
    }

    // ── 3) INSERT (only when explicitly committed) ────────────────────────────────
    let inserted = 0;
    if (commit && treatments.length) {
      const admin = createClient(SUPABASE_URL, SERVICE_KEY);
      const rows = treatments.map((t) => ({ ...t, clinic_id: clinicId }));
      const { data, error } = await admin.from("treatments").insert(rows).select("id");
      if (error) return json({ error: "Insert failed: " + error.message, treatments }, 500);
      inserted = data?.length ?? 0;
    }

    return json({
      source,
      cleanup,
      clinic_id: clinicId,
      raw_count: rawItems ? rawItems.length : null,
      cleaned_count: treatments.length,
      committed: commit,
      inserted,
      treatments,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
