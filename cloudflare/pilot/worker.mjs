import { liveBenchmark } from "./live.mjs";

// Capacity pilot with synthetic sessions. No Telegram webhook or bot credentials.
const titles = ["Made in Abyss", "Primal"];

const steps = {
  menu: {
    sql: "INSERT INTO pilot_sessions (id, step) VALUES (?, 0) ON CONFLICT DO NOTHING RETURNING step",
    values: (id) => [id],
  },
  recommend: {
    sql: "UPDATE pilot_sessions SET step = 1 WHERE id = ? AND step = 0 RETURNING step",
    values: (id) => [id],
    title: titles[0],
  },
  next: {
    sql: "UPDATE pilot_sessions SET step = 2 WHERE id = ? AND step = 1 RETURNING step",
    values: (id) => [id],
    title: titles[1],
  },
  save: {
    sql: "INSERT INTO pilot_watchlist (session_id, title) " +
      "SELECT id, ? FROM pilot_sessions WHERE id = ? AND step = 2 " +
      "ON CONFLICT DO NOTHING RETURNING title",
    values: (id) => [titles[1], id],
    title: titles[1],
  },
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({ pilot: true, database_bound: Boolean(env.PILOT_DB) });
    }
    if (!["/benchmark", "/live-benchmark"].includes(path) || request.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    if (!env.PILOT_SECRET || request.headers.get("Authorization") !== `Bearer ${env.PILOT_SECRET}`) {
      return new Response(null, { status: 401 });
    }
    if (Number(request.headers.get("Content-Length")) > 512) {
      return new Response(null, { status: 413 });
    }
    const raw = await request.text();
    let input;
    try {
      input = raw.length <= 512 ? JSON.parse(raw) : null;
    } catch {
      input = null;
    }
    if (!input || typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id)
        || !Object.hasOwn(steps, input.step)) {
      return new Response(null, { status: 400 });
    }
    if (!env.PILOT_DB) {
      return new Response(null, { status: 503 });
    }
    if (path === "/live-benchmark") return liveBenchmark(env, input);
    const step = steps[input.step];
    const result = await env.PILOT_DB.prepare(step.sql).bind(...step.values(input.id)).run();
    if (!result.results.length) {
      return new Response(null, { status: 409 });
    }
    return Response.json({
      step: input.step,
      title: step.title ?? null,
      rows_read: result.meta.rows_read,
      rows_written: result.meta.rows_written,
    }, { headers: { "Cache-Control": "no-store" } });
  },
};
