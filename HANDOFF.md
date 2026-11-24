# Coding-agent handoff

Last reviewed: 2026-11-24. This document is portable across coding agents and
harnesses. It contains no credentials and does not depend on access to prior chats.
Start with AGENTS.md. This file describes repository state, not a live status check.

## Product and current deployment

«چی ببینم؟» is a Persian Telegram film/TV recommendation bot. Users choose guided
filters or write natural-language requests, confirm their interpreted conditions,
receive a verified catalog result, request another, and save/like/dislike/mark watched.
CCloud is an external viewing destination: availability is not checked and a title
may need to be copied and searched there. Do not claim it is available to watch.

Production: Cloudflare Worker `chibebin-bot`, D1 database of the same name.
Public health endpoint: https://chibebin-bot.raeimohsen.workers.dev/health
Telegram webhook path: `/telegram`. Account/database identifiers and rate-limit
bindings are in `cloudflare/bot/wrangler.jsonc`; they are identifiers, not secrets.
Last confirmed deployment from the previous session:
`9b5351af-d962-4806-9b98-855ef2f116a5` (2026-11-22), source commit `12b815e`.
Recheck before relying on this historical version. Production uses remote D1,
not the old local Python SQLite database.

## Source map and request flow

| Location | Responsibility |
| --- | --- |
| `cloudflare/bot/worker.mjs` | HTTP/webhook verification, Telegram calls, state machine, ownership, sessions, analytics, quotas and scheduled cleanup |
| `cloudflare/bot/language.mjs` | Workers AI interpretation, JSON/evidence validation, retry, clarification and request summaries |
| `cloudflare/bot/request-audit.mjs` | Coverage and consistency checks for interpreted requests |
| `cloudflare/bot/catalog.mjs` | TMDB calls, filtering, hydration, cache, similarity, collection exclusion and ranking |
| `cloudflare/bot/entities.mjs` | General person/title resolution, published aliases, ambiguity choices |
| `cloudflare/bot/knowledge.mjs` | Optional Wikidata multilingual names with corresponding TMDB identity properties |
| `cloudflare/bot/semantics.mjs` | Approximate moods/themes and editorial seeds |
| `cloudflare/bot/parse.mjs` | Legacy parser and narrow validation/reference-reply helpers; not primary free-text interpretation |
| `cloudflare/bot/ui.mjs`, `labels.json` | Persian copy, buttons and genre/language mappings |
| `cloudflare/bot/schema.sql` | Active D1 schema, including state, sessions, catalog and updates |
| `cloudflare/bot/*.test.mjs`, `verify.mjs` | Node unit and synthetic integration tests |
| `cloudflare/pilot/` | Evaluation tools, local synthetic flow adapter; not the production deployment config |
| `app/`, `migrations/`, `tests/` | Earlier Python implementation, its migrations and tests |
| `scripts/cloudflare_cutover.py`, `prepare_cloudflare_data.py` | Historical migration tools; inspect before use, do not rerun routinely |
| `scripts/bot_test_report.py` | Aggregate remote tester diagnostics |

Flow: Telegram update → deduplicate + acquire per-user lease → read state → guided
filters or AI interpretation → validate evidence/coverage → user confirmation →
resolve catalog identities (ask when ambiguous) → TMDB candidates → strict filters
and ranking → persist session/metadata → Telegram card. Next uses saved candidates
and verified constraints. Model search hints help search but do not prove identity.
Actor verification uses `combined_credits.cast`; director verification uses credits
with `job === "Director"`. Shared production paths handle names generally.

Model configured in source: `@cf/qwen/qwen3.8-27b` via the `AI` binding. Check the
source before assuming it remains unchanged. The model does not host the catalog.
Current internal daily AI budget is 8,000 neurons, reserved conservatively in D1;
external account usage (including evaluation tools) can exhaust the provider's
allowance independently. Inspect actual provider errors before diagnosing quota
exhaustion as a language-understanding failure.

## Working environment and secrets

Development has used Windows PowerShell, Node v24.18.0 and Wrangler v4.163.0.
Use Node 24+ for `node:sqlite`, JSON import attributes and the evaluation scripts.
Python 3.12+ and `.venv` are optional for old code and convenience scripts.
There is no root npm package.json; `.mjs` modules use Node built-ins. Wrangler is
invoked with npx; `--offline` requires it to be cached. On a fresh machine install
Wrangler 4.163.0 intentionally and authenticate to the correct Cloudflare account.

Secrets already configured on the live Worker: `BOT_TOKEN`, `TMDB_READ_TOKEN`,
`WEBHOOK_SECRET`. Do not overwrite them during deployment. Locally `.env` uses
`TELEGRAM_BOT_TOKEN` and `TMDB_API_KEY`; these names differ intentionally from
Worker bindings. Do not assume `.env` is loaded automatically by Node or Wrangler.
Wrangler local secrets use `.dev.vars` alongside the selected config. Obtain
credentials through a secure local channel, never through committed handoff files.
Cloudflare authentication is machine-specific and is not bundled with the repo.

## Offline checks — start here; no network or AI quota

Run from the repository root in PowerShell:

```powershell
node --test --test-reporter=dot cloudflare/bot/entities.test.mjs cloudflare/bot/language.test.mjs cloudflare/bot/examples.test.mjs cloudflare/bot/series.test.mjs
$env:BOT_TEST_TMDB_TOKEN='mock'
$env:BOT_TEST_AI_ONLY='1'
try { node cloudflare/bot/verify.mjs; if ($LASTEXITCODE -ne 0) { throw 'Integration checks failed' } }
finally { Remove-Item Env:BOT_TEST_TMDB_TOKEN, Env:BOT_TEST_AI_ONLY -ErrorAction SilentlyContinue }
git diff --check
```

The last recorded unit run passed 71 tests plus the synthetic integration checks.
The `BOT_TEST_AI_ONLY=1` switch is essential: without it `verify.mjs` continues
into real catalog checks. Fake keys are only valid for the mocked portion.
For Python-only changes also run `.venv/Scripts/python -m pytest -q` and Ruff.
Passing Python tests does not establish Worker correctness.

## Optional live evaluation — consumes real AI quota

Do not launch the entire case suite as a routine check. Prefer a few targeted
cases after offline validation. `cloudflare/pilot/language-eval.mjs` exposes a
local evaluation/inference bridge; it must not be published as a production API.

```powershell
npx --offline wrangler dev --config cloudflare/pilot/language-eval.wrangler.jsonc --port 8798
```

In a separate terminal provide a local `BOT_TEST_TMDB_TOKEN` securely, then run:

```powershell
node --use-env-proxy cloudflare/pilot/live-flow.mjs actor_action actor_director
```

This runs production logic with synthetic Telegram messages and in-memory SQLite,
actual TMDB and the localhost AI bridge. It does not message testers. The bridge
requires Cloudflare authentication. Inspect its config/entry point before adding
any local D1 setup; the live-flow adapter initializes its own in-memory schema.
Stop the local server afterwards. Do not edit imported code during a live run:
Wrangler reloads can interrupt requests and produce misleading failures.
If required, configure HTTP_PROXY/HTTPS_PROXY from the host's actual proxy settings;
do not hardcode a port or put proxy credentials in documentation.

## Deployment and verification

Only deploy when the session authorizes it. Validate first. Use the production
config, preserve existing secrets, and do not run migrations/imports unnecessarily:

```powershell
$env:WRANGLER_SEND_METRICS='false'
npx --offline wrangler deploy --config cloudflare/bot/wrangler.jsonc --keep-vars
Invoke-RestMethod https://chibebin-bot.raeimohsen.workers.dev/health
```

On Windows, use `npx.cmd` if PowerShell script policy blocks `npx`. Deployment may
require setting CLOUDFLARE_ACCOUNT_ID to the intended account and proxy variables.
Confirm the returned version ID. A health response proves basic HTTP service,
not a full Telegram/AI/catalog interaction. Check Telegram getWebhookInfo using a
secure script that prints only URL validation, pending count and error status;
never print the token-bearing request URL. Keep the existing webhook secret.
Do not switch to polling as a connectivity workaround.

D1 read-only example (authenticated):

```powershell
npx --offline wrangler d1 execute chibebin-bot --remote --config cloudflare/bot/wrangler.jsonc --command "SELECT COUNT(*) AS total_users FROM users;" --json
```

Use aggregate queries for reports. Session/recommendation cleanup means historical
totals may reflect retention, not permanent lifetime counters. Back up production
before any schema/data migration; inspect existing tables before applying changes.
Do not replay a local data snapshot over the active database.

## Known limits and next work

- Persian interpretation is probabilistic. Do not claim every request is understood.
- Hard conditions need catalog evidence; endings, dubbing/subtitles and some other
  requests cannot currently be verified. Keep supported parts and request consent
  before dropping unsupported conditions.
- Moods and themes use metadata/editorial seeds, not verified full-plot analysis.
- Collection IDs remove known film sequels. Title families cover many numbered
  continuations, same-name remakes and subtitled TV continuations. Different-name
  spin-offs/universes without shared collection data are not fully detected.
  Hobbit is a different TMDB collection from Lord of the Rings.
- Some TMDB TV genres require keyword checks; missing evidence can mean no result.
- CCloud app-opening behavior depends on platform/link support, and availability
  of the recommended title is unverified. Do not invent an app URL scheme.
- External API timeouts and free AI exhaustion have occurred. Distinguish these
  from parser, catalog and state-machine bugs using diagnostic status events.
- Actor-only and actor+genre/director live tests passed with Inception. Full actor
  TV live verification was interrupted by upstream failures/quota exhaustion;
  targeted actor_tv evaluation remains useful when quota is available.
- Pilot evaluations can consume the whole free AI allowance outside production's
  reservation system. A shared evaluation-budget guard is a useful future task.

For the next change: reproduce with a synthetic test; locate whether interpretation,
identity resolution, catalog filtering or state handling failed; fix the general
mechanism; add regression coverage; test offline; run only necessary live checks.
See SMART-RELIABILITY.md for detailed historical evidence, not current guarantees.
