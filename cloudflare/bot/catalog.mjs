import labels from "./labels.json" with { type: "json" };
import fixture from "../../app/catalog.json" with { type: "json" };
import { preferences as semanticPreferences, semanticTags, matchesPreferences, editorialPreferenceScore } from "./semantics.mjs";
import { resolvePerson, resolveTitles } from "./entities.mjs";
import { knowledgeNames } from "./knowledge.mjs";

const MOVIE_IDS = Object.fromEntries(Object.entries(labels.movie_genres).filter(([id]) => +id < 10759));
const namespace = Uint8Array.from("6ba7b8119dad11d180b400c04fd430c8".match(/../g), (b) => parseInt(b, 16));
const encoder = new TextEncoder();
export const normalizeTitle = (s) => (s ?? "").normalize("NFKD").replace(/\p{M}|['’]/gu, "").replaceAll("ي", "ی").replaceAll("ك", "ک").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hex = (bytes) => [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
export async function mediaKey(source, kind, id) {
  const name = encoder.encode(`${source}:${kind}:${id}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  return hex(digest);
}
export const year = (m) => m.release_year ?? (Number(m.release_date?.slice(0, 4)) || null);
const quality = (m) => (((m.vote_average ?? 0) * (m.vote_count ?? 0) + 600) / (10 * ((m.vote_count ?? 0) + 100)));
const generic = new Set([
  "anime", "animation", "adult animation", "based on manga", "based on novel or book",
  "psychological", "supernatural", "thriller", "suspense", "mystery", "drama", "dark",
]);
// TMDB lists these for movies, but not as top-level TV genres.
const TV_GENRE_KEYWORDS = {
  romance: ["romance", "romantic comedy", "love story"],
  thriller: ["thriller", "psychological thriller", "crime thriller"],
  horror: ["horror", "supernatural horror", "folk horror", "body horror"],
};
const overlap = (a, b) => [...new Set(a)].filter(item => b.includes(item));
const distinct = (items) => [...new Map(items.map(item => [item.id, item])).values()];
const franchiseReferences = [
  { aliases: ["ارباب حلقه ها", "ارباب حلقه‌ها", "ارباب حلقهها", "lord of the rings", "the lord of the rings", "lotr"],
    title: "The Lord of the Rings: The Fellowship of the Ring", kind: "movie",
    relatedTitles: /^(?:the lord of the rings|the hobbit)(?=\s|$)/u },
];
const franchiseFor = name => franchiseReferences.find(f => f.aliases.some(a => normalizeTitle(a) === normalizeTitle(name)));
const canonicalTitle = name => fixture.find(m => m.aliases?.some(alias => normalizeTitle(alias) === normalizeTitle(name)))?.title ?? name;

export function resemblesExcluded(m, ref) {
  if (m.id === ref.id || (ref.collection_id && m.collection_id === ref.collection_id)) return true;
  const keywords = tags => (tags ?? []).map(normalizeTitle).filter(tag => !generic.has(tag) &&
    !["fantasy", "magic", "adventure", "friendship", "hero", "good versus evil", "good vs evil"].includes(tag));
  return overlap(m.themes ?? [], ref.themes ?? []).length >= 2 ||
    overlap(keywords(m.keywords), keywords(ref.keywords)).length >= 2;
}

export class CatalogError extends Error {}

async function entry(row, kind) {
  const title = kind === "tv" ? row.name : row.title;
  if (row.adult || !title || !Number.isSafeInteger(row.id)) return null;
  const released = (kind === "tv" ? row.first_air_date : row.release_date) || null;
  const curated = fixture.find(m => m.media_type === kind && m.release_year === Number(released?.slice(0, 4)) && normalizeTitle(m.title) === normalizeTitle(title));
  const fa = row.translations?.translations?.find(item => item.iso_639_1 === "fa")?.data;
  const keywords = (row.keywords?.results ?? row.keywords?.keywords ?? []).map(item => item.name).filter(Boolean);
  const mapped = (row.genre_ids ?? row.genres?.map(g => g.id) ?? []).flatMap(id => labels.movie_genres[id] ?? []);
  if (kind === "tv") {
    const tags = new Set(keywords.map(normalizeTitle));
    for (const [genre, terms] of Object.entries(TV_GENRE_KEYWORDS)) {
      if (curated?.genres.includes(genre) || terms.some(term => tags.has(term))) mapped.push(genre);
    }
  }
  const media = {
    id: await mediaKey("tmdb", kind, row.id), source: "tmdb", external_id: String(row.id),
    media_type: kind, title, release_date: released,
    original_title: (kind === "tv" ? row.original_name : row.original_title) || title,
    countries: [...new Set([...(row.origin_country ?? []), ...(row.production_countries ?? []).map(c => c.iso_3166_1)])],
    genres: [...new Set(mapped)],
    verified_genres: curated?.genres ?? [],
    aliases: curated?.aliases ?? [], themes: curated?.themes ?? [],
    keywords,
    collection_id: row.belongs_to_collection?.id ?? null,
    persian_title: (kind === "tv" ? fa?.name : fa?.title) || null,
    overview_fa: fa?.overview || curated?.overview_fa || null, overview_en: row.overview || null,
    original_language: row.original_language || null, runtime_minutes: row.runtime || null,
    seasons_count: row.number_of_seasons || null, episodes_count: row.number_of_episodes || null,
    vote_average: row.vote_count ? row.vote_average : null, vote_count: row.vote_count ?? 0,
    poster_path: /^[\/][\w.-]+$/.test(row.poster_path ?? "") ? `https://image.tmdb.org/t/p/w500${row.poster_path}` : null,
    rating_source: "TMDB", popularity: row.popularity ?? 0,
    source_url: `https://www.themoviedb.org/${kind}/${row.id}`,
  };
  media.semantic_tags=semanticTags(media);
  return media;
}

export function matches(m, q, details = true) {
  if (q._actor_id && !m.cast_ids?.includes(q._actor_id)) return false;
  if (q._director_id && !m.director_ids?.includes(q._director_id)) return false;
  if (q.media_type && m.media_type !== q.media_type) return false;
  if (q.language && m.original_language !== q.language) return false;
  if (details && q.country && !m.countries?.includes(q.country)) return false;
  if (details && !matchesPreferences(m,q)) return false;
  const wanted = (q.genres ?? []).filter(g => g !== "animation");
  if (q.genres?.includes("animation") && !m.genres.includes("animation")) return false;
  const mayNeedKeywords = !details && m.media_type === "tv" && wanted.some(g => Object.hasOwn(TV_GENRE_KEYWORDS, g));
  if (wanted.length && !overlap(wanted, m.genres).length && !mayNeedKeywords) return false;
  if (q.all_genres && !mayNeedKeywords && !wanted.every(tag => m.genres.includes(tag))) return false;
  if (q.avoid_genres?.length && (!m.genres.length || overlap(q.avoid_genres, m.genres).length ||
      (m.source === "tmdb" && m.media_type === "tv" && q.avoid_genres.some(g => !labels.tv_genres[g]?.length)))) return false;
  const bounds = [[year(m), q.release_year_min, q.release_year_max], [m.vote_average, q.min_rating, null]];
  if (details) bounds.push([m.runtime_minutes, q.min_runtime_minutes, q.max_runtime_minutes],
    [m.episodes_count, null, q.max_episodes], [m.seasons_count, null, q.max_seasons]);
  return bounds.every(([v, min, max]) => (min == null || (v != null && v >= min)) && (max == null || (v != null && v <= max)));
}

async function parallel(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += 6) out.push(...await Promise.all(items.slice(i, i + 6).map(fn)));
  return out;
}

function tmdb(token) {
  let calls = 0;
  const get = async (path, parameters = {}) => {
    if (!token || calls++ >= 38) throw new CatalogError();
    const url = new URL(`https://api.themoviedb.org/3/${path}`);
    url.search = new URLSearchParams({ language: "en-US", ...parameters });
    const headers = {};
    const key = token.trim();
    if (/^[\da-f]{32}$/i.test(key)) url.searchParams.set("api_key", key);
    else headers.Authorization = `Bearer ${key}`;
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 4000);
    try {
      const response = await fetch(url.href, { headers, redirect: "manual", signal: control.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogError();
      }
      return await response.json();
    } catch {
      throw new CatalogError();
    } finally { clearTimeout(timer); }
  };
  get.remaining = () => 38 - calls;
  return get;
}
const exact = (m, name) => [m.title, m.original_title, m.persian_title, ...m.aliases]
  .some(title => normalizeTitle(title) === normalizeTitle(name));

export function referenceChoices(candidates, q, name, canonical, chosen) {
  if (!candidates.length) return { missing: true };
  const exactMatches = candidates.filter(m => exact(m, name) || exact(m, canonical));
  const pool = exactMatches.length ? exactMatches : candidates;
  const animated = q.genres?.includes("animation") ? pool.filter(m => m.genres.includes("animation")) : [];
  const mediaOptions = animated.length ? animated : pool;
  const sameType = q.media_type ? mediaOptions.filter(m => m.media_type === q.media_type) : [];
  const choices = (sameType.length ? sameType : mediaOptions).slice(0, 8);
  const selected = pool.find(m => m.id === chosen) ??
    (exactMatches.length && choices.length === 1 ? choices[0] : null);
  return selected ? { selected } : { choices };
}

async function clarifyReference(choices, hint, get) {
  let matching = hint.year ? choices.filter(m => year(m) === hint.year) : choices;
  if (hint.director && matching.length) {
    const target = normalizeTitle(hint.director);
    if (!target) return [];
    const credits = await parallel(matching, m => get(`${m.media_type}/${m.external_id}/credits`));
    matching = matching.filter((_,i) => (credits[i].crew ?? []).some(person =>
      person.job === "Director" && [person.name, person.original_name].some(name => normalizeTitle(name) === target)));
  }
  return matching;
}

export async function findCandidates(db, key, q, chosen, hint) {
  const version = q.actor_name || q.director_name || q.director_of ? "people-v2" : (q.similar_to?.length || q.dissimilar_to) ? "entities-v1" :
    semanticPreferences(q).length ? "bot-v8" : q.country ? "bot-v7" : "bot-v5";
  const cacheKey = hex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", encoder.encode(JSON.stringify([version, q, chosen ?? null, hint ?? null])),
  )));
  const cache = await db.prepare("SELECT document FROM worker_catalog WHERE key=? AND expires_at>unixepoch()").bind(cacheKey).first();
  if (cache) return JSON.parse(cache.document);
  const get = tmdb(key);
  const lookupNames=kind=>async name=>{
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(kind+":"+normalizeTitle(name)))));
    const key="entity-names:"+digest;
    const cached=await db.prepare("SELECT document FROM worker_catalog WHERE key=? AND expires_at>unixepoch()").bind(key).first();
    if (cached) return JSON.parse(cached.document);
    try {
      const names=await knowledgeNames(name,kind);
      await db.prepare("INSERT INTO worker_catalog(key,document,expires_at) VALUES(?,?,unixepoch()+86400) ON CONFLICT(key) DO UPDATE SET document=excluded.document,expires_at=excluded.expires_at")
        .bind(key,JSON.stringify(names)).run();
      return names;
    } catch { throw new CatalogError(); }
  };
  let partialFailures=0;
  const optional=async (operation,fallback)=>{
    try { return await operation(); }
    catch(error) {
      if (!(error instanceof CatalogError)) throw error;
      partialFailures++;
      return fallback;
    }
  };
  const results = async (res, kind) => (await parallel(res.results ?? [], item => entry(item, kind))).filter(Boolean);
  const search = async (name, kind) => results(await get(`search/${kind}`, { query: name, include_adult: "false", language:/[\u0600-\u06ff]/u.test(name) ? "fa-IR" : "en-US" }), kind);
  const hydrate = (m) => get(`${m.media_type}/${m.external_id}`, { append_to_response: "translations,keywords" }).then(item => entry(item, m.media_type));
  let reference;
  let excluded;
  let directors = [];
  let recommended = [];
  let actor;
  let cast=[];
  if (q.actor_name) {
    if (Number.isSafeInteger(q._actor_id) && q._actor_id>0) {
      const person=await get("person/"+q._actor_id);
      if (!person.adult && person.id===q._actor_id) actor=person;
    } else {
      const resolved=await resolvePerson(get,q.actor_name,q.search_hints?.actor_name,lookupNames("person"),"Acting");
      if (resolved.peopleChoices) return {peopleChoices:resolved.peopleChoices,personField:"actor_name"};
      actor=resolved.selected;
    }
    if (!actor) return {actorUnresolved:true};
    const credits=await get("person/"+actor.id+"/combined_credits");
    cast=(await parallel((credits.cast ?? []).filter(row=>["movie","tv"].includes(row.media_type)),
      row=>entry(row,row.media_type))).filter(Boolean).map(media=>({...media,cast_ids:[actor.id],cast_match:actor.name}));
    q={...q,_actor_id:actor.id};
  }
  if (q.director_name || q.director_of) {
    const directorOf = q.director_of;
    if (directorOf) {
      const [, name, releaseYear] = directorOf.match(/^(.+?)(?:\s+\(?((?:18|19|20)\d\d)\)?)?$/u);
      const canonical = canonicalTitle(name);
      const kind = q.director_reference_type ?? "movie";
      const options = (await resolveTitles(search,canonical,q.search_hints?.director_of,kind,lookupNames(kind)))
        .filter(m => !releaseYear || year(m) === Number(releaseYear));
      if (!options.some(m=>exact(m,name) || exact(m,canonical))) {
        const person=await resolvePerson(get,name,q.search_hints?.director_of,lookupNames("person"));
        const choices=person.peopleChoices ?? (person.selected ? [person.selected] : []);
        if (choices.length) {
          const directorQuery={...q,director_name:name,search_hints:{director_name:q.search_hints?.director_of}};
          delete directorQuery.director_of;
          delete directorQuery.director_reference_type;
          return {peopleChoices:choices,directorQuery};
        }
      }
      const resolved = referenceChoices(options, {}, name, canonical, chosen);
      let { selected } = resolved;
      if (hint && resolved.choices) {
        const matching = await clarifyReference(resolved.choices, hint, get);
        if (matching.length === 1) [selected] = matching;
        else return { choices: matching.length ? matching : resolved.choices, unmatchedHint: !matching.length };
      }
      if (!selected) return resolved;
      reference = selected;
      const credits = await get(`${kind}/${selected.external_id}/credits`);
      directors = (credits.crew ?? []).filter(p => p.job === "Director" && Number.isSafeInteger(p.id)).slice(0, 4);
    } else if (Number.isSafeInteger(q._director_id) && q._director_id>0) {
      const person=await get("person/"+q._director_id);
      if (!person.adult && person.id===q._director_id) directors=[person];
    } else {
      const resolved=await resolvePerson(get,q.director_name,q.search_hints?.director_name,lookupNames("person"));
      if (resolved.peopleChoices) return {peopleChoices:resolved.peopleChoices,personQuery:q};
      if (!resolved.selected) return {directorUnresolved:true};
      directors=[resolved.selected];
    }
    if (!directors.length) return { directorUnresolved: true };
    const credits = await parallel(directors, p => get(`person/${p.id}/movie_credits`));
    const films = (await parallel(credits.flatMap(r => (r.crew ?? []).filter(m => m.job === "Director")),
      row => entry(row, "movie"))).filter(Boolean);
    const marked=films.map(media=>({...media,
      cast_ids:actor && cast.some(item=>item.id===media.id) ? [actor.id] : [],cast_match:actor?.name,
      director_ids:directors.filter((_,i)=>credits[i].crew?.some(row=>
        row.job==="Director" && String(row.id)===media.external_id)).map(person=>person.id)}));
    const candidates = distinct(marked).filter(m => m.id !== reference?.id && matches(m, q, false))
      .sort((a,b) => quality(b) - quality(a)).slice(0, 10);
    const detailed = await parallel(candidates, async m => {
      try {
        const details=await hydrate(m);
        return details ? {...details,cast_ids:m.cast_ids,cast_match:m.cast_match,director_ids:m.director_ids} : null;
      }
      catch (error) {
        if (!(error instanceof CatalogError)) throw error;
        // The filmography already verified the director.
        return m;
      }
    });
    const items = detailed.filter(m => m && matches(m, q)).map(m => ({
      ...m,
      director_match: directors.filter((_, i) => credits[i].crew?.some(row =>
        row.job === "Director" && String(row.id) === m.external_id)).map(p => p.name).join("، "),
      director_ids:directors.filter((_,i)=>credits[i].crew?.some(row=>
        row.job==="Director" && String(row.id)===m.external_id)).map(person=>person.id),
    }));
    const document = { items, related: [],actorId:actor?.id,directorId:directors.length===1 ? directors[0].id : null };
    await saveCatalog(db, cacheKey, document);
    return document;
  }
  if (actor) {
    const candidates=distinct(cast).filter(media=>matches(media,q,false))
      .sort((a,b)=>quality(b)-quality(a)).slice(0,Math.min(14,get.remaining()));
    const items=(await parallel(candidates,async media=>{
      const detailed=await optional(()=>hydrate(media),media);
      return detailed ? {...detailed,cast_ids:[actor.id],cast_match:actor.name} : null;
    })).filter(media=>media && matches(media,q));
    if (!items.length && partialFailures) throw new CatalogError();
    const document={items,related:[],actorId:actor.id};
    await saveCatalog(db,cacheKey,document);
    return document;
  }
  if (q.dissimilar_to) {
    const [, name, releaseYear] = q.dissimilar_to.match(/^(.+?)(?:\s+\(?((?:19|20)\d\d)\)?)?$/u);
    const franchise = franchiseFor(name);
    const canonical = franchise?.title ?? canonicalTitle(name);
    const kinds = franchise ? [franchise.kind] : ["movie", "tv"];
    const options = (await Promise.all(kinds.map(kind => resolveTitles(search,canonical,q.search_hints?.dissimilar_to,kind,lookupNames(kind))))).flat()
      .filter(m => !releaseYear || year(m) === Number(releaseYear));
    const pool = !franchise && q.media_type && options.some(m => m.media_type === q.media_type)
      ? options.filter(m => m.media_type === q.media_type) : options;
    const resolved=referenceChoices(pool,{},name,canonical,chosen);
    if (resolved.choices) return resolved;
    if (!resolved.selected) return {exclusionUnresolved:true};
    excluded = await hydrate(resolved.selected) ?? resolved.selected;
    excluded.franchise = franchise;
  }
  if (q.similar_to?.length) {
    const parts = q.similar_to[0].match(/^(.+?)(?:\s+\(?((?:19|20)\d\d)\)?)?$/u);
    const name = parts[1];
    const canonical = franchiseFor(name)?.title ?? canonicalTitle(name);
    const options = distinct((await Promise.all(["tv", "movie"].map(kind => resolveTitles(search,canonical,q.search_hints?.similar_to,kind,lookupNames(kind))))).flat())
      .filter(m => !parts[2] || year(m) === Number(parts[2]));
    const resolved = referenceChoices(options, q, name, canonical, chosen);
    let { selected } = resolved;
    if (hint && (selected || resolved.choices)) {
      const choices = selected ? [selected] : resolved.choices;
      const matches = await clarifyReference(choices, hint, get);
      if (matches.length !== 1) return { choices: matches.length ? matches : choices, unmatchedHint: !matches.length };
      [selected] = matches;
    }
    if (!selected) return resolved;
    reference = await hydrate(selected) ?? selected;
    const similar = await get(`${reference.media_type}/${reference.external_id}/recommendations`);
    recommended = (await results(similar, reference.media_type)).filter(m => matches(m, q, false)).slice(0, 12);
    const curated = fixture.filter(m => m.title !== reference.title && overlap(m.themes ?? [], reference.themes).length).slice(0, 4);
    const named = await parallel(curated, async (m) => (await search(m.title, m.media_type))
      .find(x => exact(x, m.title) && year(x) === m.release_year && matches(x, q, false)));
    recommended = [...named.filter(Boolean), ...recommended];
  }
  const discover = async (kind) => {
    const query = { include_adult: "false", sort_by: "popularity.desc" };
    const date = kind === "tv" ? "first_air_date" : "primary_release_date";
    if (q.release_year_min) query[`${date}.gte`] = `${q.release_year_min}-01-01`;
    if (q.release_year_max) query[`${date}.lte`] = `${q.release_year_max}-12-31`;
    if (q.language) query.with_original_language = q.language;
    if (q.country) query.with_origin_country = q.country;
    if (kind === "movie") {
      if (q.max_runtime_minutes) query["with_runtime.lte"] = q.max_runtime_minutes;
      if (q.min_runtime_minutes) query["with_runtime.gte"] = q.min_runtime_minutes;
    }
    const wanted = q.genres ?? [];
    const keywordGenres = kind === "tv" ? wanted.filter(g => Object.hasOwn(TV_GENRE_KEYWORDS, g)) : [];
    if (wanted.includes("animation")) query.with_genres = "16";
    else if (wanted.length) {
      const groups = wanted.map(g => kind === "tv" ? labels.tv_genres[g] ?? [] :
        Object.keys(MOVIE_IDS).filter(id => MOVIE_IDS[id].includes(g)));
      if (groups.every(group => group.length)) query.with_genres = [...new Set(groups.flat())].join("|");
    }
    const selected=semanticPreferences(q);
    if (selected.length) {
      if (get.remaining()<18) return [];
      const terms=[...new Set(selected.flatMap(item=>item.terms))].slice(0,4);
      const ids=(await parallel(terms,async term=>{
        const response=await optional(()=>get("search/keyword",{query:term}),null);
        return response?.results?.find(item=>normalizeTitle(item.name)===normalizeTitle(term))?.id;
      })).filter(Boolean);
      const discovered=ids.length
        ? await optional(async()=>results(await get(`discover/${kind}`,{...query,with_keywords:ids.join("|")}),kind),[]) : [];
      const seeds=distinct(selected.flatMap(item=>item.seeds)
        .filter(([,type])=>type===kind).map(([title,type,release_year])=>({id:title+release_year,title,media_type:type,release_year}))).slice(0,3);
      const known=await parallel(seeds,async seed=>(await optional(()=>search(seed.title,kind),[])).find(m=>
        exact(m,seed.title) && year(m)===seed.release_year && matches(m,q,false)));
      return distinct([...known.filter(Boolean),...discovered]);
    }
    if (!keywordGenres.length) return results(await get(`discover/${kind}`, query), kind);
    const terms = keywordGenres.flatMap(g => TV_GENRE_KEYWORDS[g]).slice(0, 4);
    const keywordIds = (await parallel(terms, async term => {
      const keywords = await get("search/keyword", { query: term });
      return keywords.results?.find(item => normalizeTitle(item.name) === term)?.id;
    })).filter(Boolean);
    const byKeyword = keywordIds.length
      ? await results(await get("discover/tv", {...query, with_keywords: keywordIds.join("|")}), kind) : [];
    const mappedGenres = wanted.filter(g => !keywordGenres.includes(g));
    if (mappedGenres.length && !wanted.includes("animation")) {
      const ids = mappedGenres.flatMap(g => labels.tv_genres[g] ?? []);
      if (ids.length) byKeyword.push(...await results(await get("discover/tv", {...query, with_genres: ids.join("|")}), kind));
    }
    const local = fixture.filter(m => m.media_type === "tv" && overlap(m.genres, keywordGenres).length)
      .filter(m => matches(m, q, false)).slice(0, 3);
    const known = await parallel(local, async m => (await search(m.title, kind))
      .find(x => exact(x, m.title) && year(x) === m.release_year));
    return distinct([...known.filter(Boolean), ...byKeyword]);
  };
  const broad = (await Promise.all((q.media_type ? [q.media_type] : ["tv", "movie"]).map(discover))).flat()
    .filter(m => matches(m, q, false)).sort((a,b) =>
      Number(matches(b, q)) - Number(matches(a, q)) || quality(b) - quality(a)).slice(0, 12);
  const candidates = distinct([...recommended, ...broad]).filter(m => m.id !== reference?.id &&
      (!excluded || (m.id !== excluded.id && !excluded.franchise?.relatedTitles.test(normalizeTitle(m.title)))))
    .slice(0, Math.min(26, get.remaining()));
  const items = (await parallel(candidates,async media=>{
    const hydrated=await optional(()=>hydrate(media),null);
    // A seed can still satisfy all requested constraints using official search metadata.
    return hydrated ?? (semanticPreferences(q).length && matches(media,q) ? media : null);
  })).filter(m => m && matches(m, q) && (!excluded || !resemblesExcluded(m, excluded)));
  if (!items.length && partialFailures) throw new CatalogError();
  const document = { items, reference, related: recommended.map(m => m.id) };
  await saveCatalog(db, cacheKey, document);
  return document;
}

async function saveCatalog(db, cacheKey, document) {
  await db.prepare("INSERT INTO worker_catalog(key,document,expires_at) VALUES (?,?,unixepoch()+3600) ON CONFLICT(key) DO UPDATE SET document=excluded.document, expires_at=excluded.expires_at")
    .bind(cacheKey, JSON.stringify(document)).run();
}

const moodGenres = { dark: ["crime","mystery","thriller","horror"], intense: ["action","thriller","crime","horror"],
  light: ["comedy","family","animation"], uplifting: ["comedy","family","adventure"] };
export function rankItems(result, q, history, interactions, preferences) {
  const {items, reference, related} = result;
  const target = [...new Set([...(q.genres ?? []), ...(moodGenres[q.mood] ?? [])])];
  const keywordGenres = (q.genres ?? []).filter(g => Object.hasOwn(TV_GENRE_KEYWORDS, g));
  const recent = new Set(history);
  return items.filter(m => !interactions.some(x => x.media_id === m.id && (x.is_watched || x.preference === "disliked")))
    .map(m => {
      const shared = overlap(m.genres, reference?.genres ?? []);
      const themes = overlap(m.themes, reference?.themes ?? []);
      const refKeywords = reference?.keywords.map(tag => tag.toLowerCase()).filter(tag => !generic.has(tag)) ?? [];
      const keywords = overlap(m.keywords.map(tag => tag.toLowerCase()), refKeywords);
      if (reference?.themes.length && !themes.length && keywords.length < 2) return null;
      const genreScore = shared.length / Math.max(1, new Set([...m.genres, ...(reference?.genres ?? [])]).size);
      const thematic = Math.max(themes.length / Math.max(1, reference?.themes.length ?? 0), keywords.length / Math.max(1, refKeywords.length));
      const similarity = (reference?.themes.length || refKeywords.length) ? 0.2 * genreScore + 0.8 * thematic : genreScore;
      const preferred = m.genres.filter(g => preferences[g] > 0);
      const selected = overlap(m.genres, q.genres ?? []);
      let explanation = "این عنوان با شرط‌هایی که انتخاب کردی جور درمیاد.";
      if (themes.length) explanation = `مثل عنوان مرجع، سراغ «${themes.slice(0, 2).join("» و «")}» می‌ره.`;
      else if (keywords.length) explanation = `برچسب‌های مشترک با عنوان مرجع: ${keywords.slice(0, 2).join("، ")}`;
      else if (shared.length || selected.length || preferred.length) explanation = `ژانر «${labels.genres[(shared[0] ?? selected[0] ?? preferred[0])]}» رو داره.`;
      if (m.director_match) explanation += `\nکارگردان: ${m.director_match}`;
      if (m.cast_match) explanation += "\nبا بازی "+m.cast_match;
      const qualitative=semanticPreferences(q);
      if (qualitative.length) explanation += "\nاز نظر برچسب‌ها یا انتخاب تحریری به «" + qualitative.map(item=>item.label).join("، ") + "» نزدیکه.";
      const taste = m.genres.reduce((sum, tag) => sum + (preferences[tag] ?? 0), 0) / Math.max(1, m.genres.length);
      const score = 0.15 * quality(m) + 0.3 * editorialPreferenceScore(m,q) +
        (target.length ? 0.35 * overlap(m.genres, target).length / target.length : 0)
        + 0.25 * (taste + 3) / 6 + (reference ? 0.6 * similarity + (related.includes(m.id) ? 0.02 : 0) : 0);
      const verified = !reference && m.media_type === "tv" && keywordGenres.length
        ? (m.verified_genres ?? []).reduce((n, g, i) => n + (keywordGenres.includes(g) ? (i === 0 ? 2 : 1) : 0), 0)
        : 0;
      return { media: m, explanation, score, verified };
    }).filter(Boolean).sort((a,b) => b.verified - a.verified ||
      Number(recent.has(a.media.id)) - Number(recent.has(b.media.id)) || b.score - a.score ||
      b.media.popularity - a.media.popularity);
}
