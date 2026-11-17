import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const live = process.argv.includes("--live");
const secret = process.env.PILOT_SECRET;
if (!secret) throw new Error("Set PILOT_SECRET to the pilot credential");

const cacheId = randomUUID();
async function run(id, step) {
  const response = await fetch(new URL(live ? "/live-benchmark" : "/benchmark", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ id, step, cache_id: cacheId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const details = response.headers.get("content-type")?.includes("application/json")
      ? await response.text() : "";
    throw new Error(`${step} returned HTTP ${response.status} ${details}`);
  }
  const result = await response.json();
  console.log(JSON.stringify(result));
  return result;
}

const id = randomUUID();
await run(id, "menu");
const cold = await run(id, "recommend");
const next = await run(id, "next");
const saved = await run(id, "save");
assert.ok(cold.title && next.title);
assert.notEqual(cold.title, next.title);
assert.equal(saved.title, next.title);
if (live) {
  const warmId = randomUUID();
  await run(warmId, "menu");
  const warm = await run(warmId, "recommend");
  assert.equal(warm.title, cold.title);
  assert.equal(cold.cache, "miss");
  assert.equal(warm.cache, "hit");
  assert.ok(cold.tmdb_calls > 0 && cold.estimated_subrequests_with_telegram < 50);
  assert.equal(warm.tmdb_calls, 0);
  assert.equal(next.tmdb_calls, 0);
  assert.equal(saved.tmdb_calls, 0);
}
