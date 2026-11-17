// A capacity test for one fixed smart recommendation, with real TMDB and D1 calls.
const TMDB_LIMIT = 38;
const TG_REQUEST_ALLOWANCE = 2;
const CACHE_SECONDS = 3600;
const DETAIL_LIMIT = 12;
const MOVIE_ANIMATION = 16;
const REFERENCE = "Scavengers Reign";
const CURATED = [
  { title: "Made in Abyss", kind: "tv", year: 2017, theme: 1 },
  { title: "Nausicaä of the Valley of the Wind", kind: "movie", year: 1984, theme: 2 / 3 },
  { title: "Primal", kind: "tv", year: 2019, theme: 1 / 3 },
];
const generic = new Set(["anime", "animation", "based on manga", "adult animation"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const titleOf = (row) => row.title ?? row.name;
const yearOf = (row) => Number((row.release_date ?? row.first_air_date ?? "").slice(0, 4));
const normalize = (name) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const mediaId = (row) => `${row.kind}:${row.id}`;
const genreIds = (row) => row.genre_ids ?? row.genres?.map((genre) => genre.id) ?? [];

class CatalogError extends Error {}

function catalogClient(token, totals) {
  token = token?.trim();
  return async (route, params = {}) => {
    if (!token) throw new CatalogError("tmdb_secret_missing");
    if (totals.tmdb_calls >= TMDB_LIMIT) throw new CatalogError("tmdb_budget_exhausted");
    totals.tmdb_calls++;
    const url = new URL(`https://api.themoviedb.org/3/${route}`);
    url.search = new URLSearchParams({ language: "en-US", ...params });
    const headers = { Accept: "application/json" };
    if (/^[\da-f]{32}$/i.test(token)) url.searchParams.set("api_key", token);
    else headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(url.href, { headers, redirect: "manual", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogError(`tmdb_http_${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if (controller.signal.aborted) throw new CatalogError("tmdb_timeout");
      if (/header/i.test(error?.message ?? "")) throw new CatalogError("tmdb_invalid_header");
      throw new CatalogError("tmdb_network_error");
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function inBatches(items, operation) {
  const rows = [];
  for (let offset = 0; offset < items.length; offset += 6) {
    rows.push(...await Promise.all(items.slice(offset, offset + 6).map(operation)));
  }
  return rows;
}

function quality(row) {
  const votes = Number(row.vote_count) || 0;
  return ((Number(row.vote_average) || 0) * votes + 600) / (10 * (votes + 100));
}

function keywords(row) {
  const terms = row.keywords?.results ?? row.keywords?.keywords ?? [];
  return new Set(terms.map(({ name }) => name.toLowerCase()).filter((name) => !generic.has(name)));
}

async function recommendations(get) {
  const search = async (kind, query) =>
    (await get(`search/${kind}`, { query, include_adult: "false" })).results ?? [];
  const list = await search("tv", REFERENCE);
  const reference = list.find((row) => row.name === REFERENCE && yearOf(row) === 2023);
  if (!reference) throw new CatalogError("tmdb_reference_missing");
  const getDetails = async ({ kind, id }) => ({
    ...await get(`${kind}/${id}`, { append_to_response: "translations,keywords" }), kind,
  });

  const [metadata, related, movies, series, ...curated] = await inBatches([
    () => getDetails({ kind: "tv", id: reference.id }),
    () => get(`tv/${reference.id}/recommendations`),
    () => get("discover/movie", { with_genres: "16", include_adult: "false" }),
    () => get("discover/tv", { with_genres: "16", include_adult: "false" }),
    ...CURATED.map((item) => async () => {
      const found = (await search(item.kind, item.title)).find((row) =>
        yearOf(row) === item.year && normalize(titleOf(row) ?? "") === normalize(item.title));
      return found ? { ...found, kind: item.kind, theme: item.theme } : null;
    }),
  ], (operation) => operation());

  const fromList = (list, kind) => (list.results ?? []).map((row) => ({ ...row, kind }));
  const animated = (row) => !row.adult && genreIds(row).includes(MOVIE_ANIMATION) &&
    !(row.kind === "tv" && row.id === reference.id);
  const suggested = fromList(related, "tv");
  const discovery = [...fromList(movies, "movie"), ...fromList(series, "tv")]
    .filter(animated).sort((a, b) => quality(b) - quality(a)).slice(0, DETAIL_LIMIT);
  const pool = [
    ...curated.filter(Boolean),
    ...suggested.filter(animated).slice(0, DETAIL_LIMIT),
    ...discovery,
  ];
  const byId = new Map();
  for (const item of pool) {
    if (!byId.has(mediaId(item))) byId.set(mediaId(item), item);
  }
  const refGenres = new Set(genreIds(metadata));
  const refKeywords = keywords(metadata);
  const detailed = await inBatches([...byId.values()], getDetails);
  return detailed.filter(animated).map((item) => {
    const tags = keywords(item);
    const common = [...tags].filter((tag) => refKeywords.has(tag)).length;
    const genres = genreIds(item);
    const intersection = genres.filter((g) => refGenres.has(g)).length;
    const union = new Set([...genres, ...refGenres]).size;
    const theme = byId.get(mediaId(item)).theme ?? 0;
    const similarity = 0.2 * intersection / Math.max(1, union) +
      0.8 * Math.max(theme, common / Math.max(1, refKeywords.size));
    return { id: mediaId(item), title: titleOf(item), score: 0.8 * similarity + 0.2 * quality(item) };
  }).filter((item) => item.title).sort((a, b) => b.score - a.score).slice(0, 8);
}

export async function liveBenchmark(env, input) {
  if (!uuid.test(input.id) || typeof input.cache_id !== "string" || !uuid.test(input.cache_id)) {
    return new Response(null, { status: 400 });
  }
  const totals = { tmdb_calls: 0, d1_calls: 0, rows_read: 0, rows_written: 0 };
  const statement = (sql, ...bindings) => env.PILOT_DB.prepare(sql).bind(...bindings);
  const count = (result) => {
    totals.rows_read += result.meta.rows_read ?? 0;
    totals.rows_written += result.meta.rows_written ?? 0;
    return result.results;
  };
  const query = async (sql, ...bindings) => {
    totals.d1_calls++;
    return count(await statement(sql, ...bindings).run());
  };
  const batch = async (statements) => {
    totals.d1_calls++;
    return (await env.PILOT_DB.batch(statements)).map(count);
  };
  const fail = (status) => new Response(null, { status });
  const success = (title = null, cache = null) => Response.json({
    step: input.step, title, cache, ...totals,
    estimated_subrequests_with_telegram: totals.tmdb_calls + totals.d1_calls + TG_REQUEST_ALLOWANCE,
  }, { headers: { "Cache-Control": "no-store" } });
  const { id, cache_id: cacheId } = input;
  const onlySession = "id = ? AND cache_id = ?";

  if (input.step === "menu") {
    const rows = await query(
      "INSERT INTO pilot_live_sessions (id, cache_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id",
      id, cacheId,
    );
    return rows.length ? success() : fail(409);
  }
  if (input.step === "recommend") {
    const eligible = await query(`SELECT id FROM pilot_live_sessions WHERE ${onlySession} AND step = 0`, id, cacheId);
    if (!eligible.length) return fail(409);
    const now = Math.floor(Date.now() / 1000);
    const [cached] = await query(
      "SELECT titles FROM pilot_live_cache WHERE id = ? AND expires_at > ?", cacheId, now,
    );
    let titles;
    try {
      titles = cached ? JSON.parse(cached.titles) : await recommendations(catalogClient(env.PILOT_TMDB_TOKEN, totals));
    } catch (error) {
      if (error instanceof CatalogError) {
        return Response.json({ ...totals, error: error.message }, { status: 502 });
      }
      throw error;
    }
    if (titles.length < 2) return Response.json(totals, { status: 422 });
    const encoded = JSON.stringify(titles);
    const first = titles[0];
    const operations = [
      statement(`UPDATE pilot_live_sessions SET step = 1, titles = ? WHERE ${onlySession} AND step = 0 RETURNING id`, encoded, id, cacheId),
      statement(
        "INSERT INTO pilot_live_history (session_id, position, media_id, title) " +
        `SELECT id, 0, ?, ? FROM pilot_live_sessions WHERE ${onlySession} AND step = 1 ON CONFLICT DO NOTHING`,
        first.id, first.title, id, cacheId,
      ),
    ];
    if (!cached) operations.unshift(statement(
      "INSERT INTO pilot_live_cache (id, titles, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET titles = excluded.titles, expires_at = excluded.expires_at",
      cacheId, encoded, now + CACHE_SECONDS,
    ));
    const rows = await batch(operations);
    return rows[cached ? 0 : 1].length ? success(first.title, cached ? "hit" : "miss") : fail(409);
  }
  if (input.step === "next") {
    const [session] = await query(`SELECT titles FROM pilot_live_sessions WHERE ${onlySession} AND step = 1`, id, cacheId);
    if (!session) return fail(409);
    const second = JSON.parse(session.titles)[1];
    const [changed] = await batch([
      statement(`UPDATE pilot_live_sessions SET step = 2 WHERE ${onlySession} AND step = 1 RETURNING id`, id, cacheId),
      statement(
        "INSERT INTO pilot_live_history (session_id, position, media_id, title) " +
        `SELECT id, 1, ?, ? FROM pilot_live_sessions WHERE ${onlySession} AND step = 2 ON CONFLICT DO NOTHING`,
        second.id, second.title, id, cacheId,
      ),
    ]);
    return changed.length ? success(second.title) : fail(409);
  }
  if (input.step === "save") {
    const rows = await query(
      "INSERT INTO pilot_live_watchlist (session_id, media_id, title) " +
      "SELECT h.session_id, h.media_id, h.title FROM pilot_live_history h JOIN pilot_live_sessions s ON s.id = h.session_id " +
      "WHERE s.id = ? AND s.cache_id = ? AND s.step = 2 AND h.position = 1 ON CONFLICT DO NOTHING RETURNING title",
      id, cacheId,
    );
    return rows.length ? success(rows[0].title) : fail(409);
  }
  return fail(400);
}
