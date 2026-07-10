# Standing PM directives

These are lessons learned the hard way — apply them proactively, before shipping, not after the user notices a bill or a bug.

## Think through cost, failure modes, and quality before proposing/shipping — not after

On 2026-07-10, the treatment-import feature shipped with three avoidable problems, all found by the user in production rather than caught before:
1. It used `claude-sonnet-4-6` for a mechanical data-cleaning task (renaming/normalizing a scraped price list) that a cheaper model handles fine.
2. The "preview then confirm" UI re-ran the entire fetch-and-Claude-cleanup pipeline on confirm, silently doubling cost and latency for a result that was already computed.
3. There was no handling for Claude hitting `max_tokens` mid-array — a failure mode that still burns the full output-token cost before failing, which is worse than a plain error.

None of these required hindsight to catch — they're checklist items for any change that calls an LLM API. Before shipping (or presenting a plan for) code that calls Claude:

- **Model choice**: pick the cheapest model that can actually do the task. Don't reach for Sonnet/Opus by default for mechanical work — extraction, renaming, classification, structured cleanup — Haiku-tier is usually enough. Reserve the expensive model for what actually needs its reasoning (e.g. the live DM-reply/lead-scoring engine, which needs to sound human and handle nuance).
- **Preview/confirm and any two-step flows**: never let the second step re-run an expensive call if the first step already produced the result the user is confirming. Store and reuse it.
- **Token ceilings**: know what happens when `max_tokens` is hit mid-generation — a truncated response that still bills full output tokens is a worse failure than a clean error, and it should degrade gracefully (fallback path), not just die.
- **Recurring vs. one-time cost**: when discussing cost with the user, be precise about which one you're describing. A per-message cost (e.g. the DM engine, which runs on every customer message across every clinic) scales with client count and volume; a one-time-per-clinic action (e.g. treatment import at onboarding) does not — don't let a one-time action's dollar figure imply a false read on scaling risk, and don't undersell genuine per-message scaling risk either.

The standard to hold: work through the "what could go wrong / what's the cheapest way to do this well" pass myself, by default, before it ships — not just when explicitly asked to optimize afterward.
