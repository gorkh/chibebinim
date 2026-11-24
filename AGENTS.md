# Agent entry point — applies to the whole repository

Read `HANDOFF.md` before changing code. Read `SMART-RELIABILITY.md` for historical
test evidence and limitations. These instructions apply to any coding agent,
including DeepSeek. If your harness does not load AGENTS.md automatically, open it
explicitly. All paths below are relative to the repository root.

## Active system

- Production is **JavaScript Cloudflare Workers + D1**, entry point
  `cloudflare/bot/worker.mjs`, config `cloudflare/bot/wrangler.jsonc`.
- `app/`, Python tests and Docker are the earlier standalone polling implementation.
  They are not the production bot and changes there do not update production.
- Never start Python polling using the production Telegram token while the webhook
  is active. Do not run cutover/import scripts as a normal deployment step.
- User-facing copy and communication are Persian. Keep changes general rather than
  adding a special case for each actor, director, franchise or spelling reported.

## Invariants

- The language model interprets requests; TMDB verifies identities and facts.
  Never accept model-generated person IDs or unverified catalog facts.
- Preserve every supported condition; never silently discard an unsupported one.
  Ask for clarification or explicit agreement to relax conditions.
- Keep numeric/country/genre/cast/director constraints in final selection AND next
  recommendations. Mood/theme similarity is approximate, not a plot guarantee.
- Similar recommendations exclude the reference and its identifiable collection /
  title-family continuations. Do not replace this with genre-based exclusion.
- Preserve per-user leases, update deduplication, callback ownership, nonce checks,
  expiry, rate limits, budget reservation and privacy controls.
- Free service is a user requirement. Do not upgrade a plan, enable a paid model,
  or remove limits to make a test pass.

## Secrets and data

- Never print or commit `.env`, `.dev.vars*`, credentials, database dumps, raw
  user conversations, Telegram IDs or Cloudflare auth files.
- Environment variable NAMES are safe to document; values are not.
- Raw request drafts can exist temporarily in `worker_state`; do not copy them to
  analytics or logs. Cleanup expiry and user deletion must remain effective.
- Use aggregate queries for usage reports. Test locally with synthetic users.

## Before reporting completion

1. Inspect `git status` and existing changes; do not overwrite someone else's work.
2. Run the offline checks in HANDOFF.md relevant to the change.
3. Distinguish mock tests, real API tests, deployment and actual Telegram testing.
4. Document material limitations; never promise perfect Persian understanding.
5. A source change is not live until deployment succeeds. Git push is separate.
6. Keep README/HANDOFF current when architecture or operational steps change.

Do not treat historical deployment permission as authorization from a new owner.
For a new session, follow its user's requested scope and the harness permissions.
