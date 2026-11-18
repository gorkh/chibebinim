import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { handleUpdate } from "./worker.mjs";
import { mediaKey, rankItems, referenceChoices } from "./catalog.mjs";
import { parse, parseReferenceReply } from "./parse.mjs";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys=ON");
database.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
if (process.argv[2]) database.exec(readFileSync(process.argv[2], "utf8"));
let reads = 0;
let tmdbCalls = 0;
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        const run = async () => {
          reads++;
          const results = database.prepare(sql).all(...args);
          return { results, meta: database.prepare("SELECT changes() AS changes").get() };
        };
        return { run, all: run, first: async () => (await run()).results[0] ?? null };
      },
      first: async () => database.prepare(sql).get() ?? null,
    };
  },
  async batch(statements) {
    database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const url = new URL(args[0]);
  assert.equal(url.hostname, "api.themoviedb.org");
  tmdbCalls++;
  const [target, init] = args;
  const options = process.env.BOT_TEST_DIRECTOR_ONLY === "1" ? {...init, signal: AbortSignal.timeout(15000)} : init;
  return realFetch(target, options).then(response => {
    if (!response.ok) console.error("TMDB", url.pathname, response.status);
    return response;
  }, error => {
    console.error("TMDB", url.pathname, error.name, error.cause?.code ?? "");
    throw error;
  });
};
const token = process.env.BOT_TEST_TMDB_TOKEN;
if (!token) throw new Error("Set BOT_TEST_TMDB_TOKEN for the live catalog integration test");
const env = { BOT_DB: db, TMDB_READ_TOKEN: token, WEBHOOK_SECRET: "local-only" };
assert.equal(await mediaKey("tmdb", "tv", "123"), "6f2ee2159ec85a36877e374a8a19d2c9");
assert.equal(parse("یه فیلم هیجان انگیز زیر دو ساعت").max_runtime_minutes, 119);
assert.deepEqual(parseReferenceReply("اونی که کارگردانش sean Penn است"), { director: "sean Penn" });
assert.deepEqual(parseReferenceReply("نسخهٔ ۲۰۰۷"), { year: 2007 });
const deathQuery = parse("یه انیمه شبیه death nite");
const death = { id: "anime", title: "Death Note", aliases: ["Death Nite"], genres: ["animation"],
  themes: ["نبرد ذهنی"], keywords: ["psychological", "supernatural"] };
const remake = { id: "remake", title: "Death Note", aliases: [], genres: ["drama"] };
assert.equal(referenceChoices([remake, death], deathQuery, "death nite", "Death Note").selected.id, "anime");
const weak = { ...death, id: "school", title: "School-Live!", themes: [] };
const strong = { ...death, id: "monster", title: "Monster", keywords: [] };
const ranked = rankItems({ items: [weak, strong], reference: death, related: ["school"] },
  deathQuery, [], [], {});
assert.deepEqual(ranked.map(item => item.media.title), ["Monster"]);
assert.equal((await worker.fetch(new Request("https://test.invalid/telegram", { method: "POST" }), env)).status, 401);
assert.equal((await worker.fetch(new Request("https://test.invalid/health"), env)).status, 200);

let updateId = 900000;
const sent = [];
const actor = 194863021;
const call = async (method, data) => sent.push({ method, data });
const message = (user, text) => ({
  message_id: 7, chat: { id: user, type: "private" }, from: { id: user }, text,
});
async function input(text, callback = false, actorId = actor) {
  const payload = callback
    ? { callback_query: { id: String(updateId), from: { id: actorId }, message: message(actorId), data: text } }
    : { message: message(actorId, text) };
  const before = { reads, tmdbCalls };
  const update = { update_id: updateId++, ...payload };
  await handleUpdate(env, update, call);
  return { update, dbCalls: reads - before.reads, tmdbCalls: tmdbCalls - before.tmdbCalls };
}
const last = () => sent.at(-1)?.data;
function action(prefix) {
  const keyboard = last()?.reply_markup?.inline_keyboard ?? [];
  const hit = keyboard.flat().find(btn => btn.callback_data?.startsWith(prefix));
  assert.ok(hit, `Expected ${prefix} in reply buttons`);
  return hit.callback_data;
}

const floodActor = actor + 1;
env.USER_UPDATES_LIMIT = { limit: async ({key}) => ({success: key !== String(floodActor)}) };
const beforeFlood = sent.length;
const blockedUpdate = await input("/start", false, floodActor);
assert.equal(blockedUpdate.dbCalls, 0);
assert.equal(blockedUpdate.tmdbCalls, 0);
assert.equal(sent.length, beforeFlood);
assert.equal(database.prepare("SELECT count(*) AS n FROM worker_updates WHERE id=?").get(blockedUpdate.update.update_id).n, 0);
await input("/start");
await input("smart", true);
env.USER_RECOMMEND_LIMIT = { limit: async ({key}) => {
  assert.equal(key, String(actor));
  return {success: false};
} };
const blockedSearch = await input("یه فیلم فانتزی");
assert.equal(blockedSearch.tmdbCalls, 0);
assert.match(last().text, /یک دقیقه/);
delete env.USER_RECOMMEND_LIMIT;

let aiCalls = 0;
env.AI = {run: async () => {
  aiCalls++;
  return {response:JSON.stringify({director_name:"استیون اسپیلبرگ",media_type:"movie",max_runtime_minutes:119})};
}};
env.USER_AI_LIMIT = {limit: async () => ({success:true})};
env.USER_RECOMMEND_LIMIT = {limit: async () => ({success:false})};
await input("smart", true);
const interpreted = await input("از استیون اسپیلبرگ کارگردان یه فیلم زیر دو ساعت پیشنهاد بده");
assert.equal(interpreted.tmdbCalls, 0);
assert.match(last().text, /استیون اسپیلبرگ/);
assert.match(last().text, /۱۱۹/);
await input(action("interpret:"), true);
assert.match(last().text, /یک دقیقه/);
assert.equal(aiCalls, 1);
await input("یه فیلم معمایی زیر دو ساعت");
assert.equal(aiCalls, 1);
env.AI.run = async () => ({response:JSON.stringify({
  media_type:"movie", genres:["sci-fi"], unsupported:["ending"],
})});
const partial = await input("یه فیلم علمی تخیلی با پایان خوش");
assert.equal(partial.tmdbCalls, 0);
assert.match(last().text, /نوع پایان/);
assert.match(last().text, /علمی‌تخیلی/);
assert.ok(last().reply_markup.inline_keyboard.flat().some(b => b.text === "با بقیهٔ شرط‌ها بگرد"));
const pending = database.prepare("SELECT document FROM worker_state").get();
assert.deepEqual(JSON.parse(pending.document).query, {media_type:"movie",genres:["science_fiction"]});
await input(action("interpret:"), true);
assert.match(last().text, /یک دقیقه/);
await input("smart", true);
await input(action("guided"), true);
await input(action("type:"), true);
await input(action("genre:"), true);
const duration = last().reply_markup.inline_keyboard.flat().find(b => b.text === "زیر دو ساعت");
assert.ok(duration);
delete env.USER_RECOMMEND_LIMIT;
const previousFetch = globalThis.fetch;
globalThis.fetch = async (target) => {
  const url = new URL(target);
  assert.equal(url.pathname, "/3/discover/movie");
  assert.equal(url.searchParams.get("with_runtime.lte"), "119");
  assert.ok(url.searchParams.get("with_genres"));
  return Response.json({results:[]});
};
try {
  await input(duration.callback_data, true);
  assert.match(last().text, /پیدا نکردم/);
  assert.ok(action("guided"));
} finally {
  globalThis.fetch = previousFetch;
}
assert.equal(aiCalls, 1);
delete env.AI;
delete env.USER_AI_LIMIT;
delete env.USER_RECOMMEND_LIMIT;
if (process.env.BOT_TEST_AI_ONLY === "1") process.exit(0);

for (const query of ["از کارگردا کیم کی دوک میخوام", "از کارگردان فیلم pieta"]) {
  await input("smart", true);
  const search = await input(query);
  assert.match(last().caption ?? last().text, /Kim Ki[ -]duk/i);
  const session = database.prepare("SELECT candidates, request_json FROM recommendation_sessions ORDER BY rowid DESC LIMIT 1").get();
  const queue = JSON.parse(session.candidates);
  assert.ok(queue.every(({media}) => /Kim Ki[ -]duk/i.test(media.director_match)));
  if (query.endsWith("pieta")) assert.ok(queue.every(({media}) => !/^pietà?$/i.test(media.title)));
  assert.ok(!session.request_json.includes(query.endsWith("pieta") ? "pieta" : "کیم"));
  assert.ok(search.tmdbCalls <= 38);
  console.log(JSON.stringify({ directorRequest: queue[0].media.title, tmdbCalls: search.tmdbCalls }));
}
if (process.env.BOT_TEST_DIRECTOR_ONLY === "1") process.exit(0);

async function verifyFantasyExclusion() {
  await input("smart", true);
  const fantasy = await input("فیلم فانتزی که شبیه ارباب حلقه ها نباشه");
  assert.ok(last().reply_markup.inline_keyboard.flat().some(b => b.callback_data?.startsWith("next:")), last().text);
  const session = database.prepare("SELECT candidates, request_json FROM recommendation_sessions ORDER BY rowid DESC LIMIT 1").get();
  const queue = JSON.parse(session.candidates);
  assert.ok(queue.every(({media}) => media.media_type === "movie" && media.genres.includes("fantasy") &&
    !/^(?:The Lord of the Rings|The Hobbit)\b/i.test(media.title)));
  assert.ok(!session.request_json.includes("ارباب"));
  assert.ok(fantasy.tmdbCalls <= 38);
  console.log(JSON.stringify({ fantasyExclusion: queue[0].media.title, tmdbCalls: fantasy.tmdbCalls }));
}

await verifyFantasyExclusion();
await input("smart", true);
const cold = await input("یه انیمه شبیه Scavengers Reign");
assert.match(last().caption ?? last().text, /Made in Abyss/);
assert.ok(cold.tmdbCalls > 0 && cold.tmdbCalls <= 38);
const firstCard = action("next:");
await input(firstCard, true);
const save = action("save:");
const saved = await input(save, true);
const outgoingCount = sent.length;
await handleUpdate(env, saved.update, call);
assert.equal(sent.length, outgoingCount);
await input("/watchlist");
await input(action("detail:"), true);
await input(action("copy:w:"), true);
assert.ok(last().text.startsWith("<code>"));
await input("/profile");
await input("smart", true);
await input("این فقط جملهٔ ساختگی برای تست حریم خصوصی لاگ است");
assert.ok(database.prepare("SELECT count(*) AS n FROM analytics_events WHERE event_name='bot_diagnostic' AND json_extract(metadata_json,'$.status')='request_unparsed'").get().n);
assert.equal(database.prepare("SELECT count(*) AS n FROM analytics_events WHERE metadata_json LIKE '%جملهٔ ساختگی%'").get().n, 0);
const warm = await input("یه انیمه شبیه Scavengers Reign");
assert.equal(warm.tmdbCalls, 0);
await input("smart", true);
const deathNote = await input("یه انیمه شبیه death nite");
const deathRecommendation = last().caption ?? last().text;
assert.match(deathRecommendation, /Monster|Code Geass|Psycho-Pass/i);
assert.doesNotMatch(deathRecommendation, /School-Live!/i);
console.log(JSON.stringify({ deathNote: deathRecommendation.split("\n")[0], tmdbCalls: deathNote.tmdbCalls }));
await input("smart", true);
await input("یه فیلم شبیه into the wild میخوام");
assert.ok(action("ref:"));
assert.ok(!last().reply_markup.inline_keyboard.flat().some(b => b.text.endsWith("· سریال")));
await input("اونی که کارگردانش نام ساختگی است");
assert.match(last().text, /با این مشخصات/);
assert.ok(action("ref:"));
const followUp = await input("اونی که کارگردانش sean Penn است");
assert.ok(action("next:"));
assert.ok(followUp.tmdbCalls <= 38);
const documents = database.prepare("SELECT document FROM worker_catalog").all();
assert.ok(documents.map(row => JSON.parse(row.document).reference)
  .some(ref => ref?.title === "Into the Wild" && ref.release_date?.startsWith("2007") &&
    ref.media_type === "movie"));
const logged = database.prepare("SELECT metadata_json FROM analytics_events WHERE event_name='recommendation_viewed' ORDER BY id DESC LIMIT 1").get();
const metadata = JSON.parse(logged.metadata_json);
assert.equal(metadata.reference.title, "Into the Wild");
assert.equal(metadata.follow_up, "director");
assert.ok(metadata.recommendation_id && metadata.title);
assert.ok(!logged.metadata_json.includes("sean Penn"));
console.log(JSON.stringify({ directorFollowUp: "Into the Wild (2007)", tmdbCalls: followUp.tmdbCalls }));
for (const genre of ["thriller", "romance", "horror"]) {
  await input("/recommend");
  const typeButton = last().reply_markup.inline_keyboard.flat().find(b => b.callback_data?.endsWith(":tv"));
  assert.ok(typeButton);
  await input(typeButton.callback_data, true);
  const genreButton = last().reply_markup.inline_keyboard.flat().find(b => b.callback_data?.endsWith(":" + genre));
  assert.ok(genreButton);
  const result = await input(genreButton.callback_data, true);
  assert.ok(action("next:"));
  const media = database.prepare("SELECT m.metadata_json FROM recommendations r JOIN media m ON m.id = r.media_id ORDER BY r.rowid DESC LIMIT 1").get();
  const selected = JSON.parse(media.metadata_json);
  assert.equal(selected.media_type, "tv");
  assert.ok(selected.genres.includes(genre));
  assert.ok(selected.verified_genres.includes(genre));
  if (genre === "romance") assert.match(selected.title, /One Day|Crash Landing on You/);
  assert.ok(result.tmdbCalls <= 38);
  console.log(JSON.stringify({ quickTV: genre, title: selected.title, tmdbCalls: result.tmdbCalls }));
}
await input("/recommend");
await input(action("type:"), true);
await input(action("genre:"), true);
assert.ok(action("liked:"));
await input(action("liked:"), true);
await input("reset", true);
await input(action("confirm:"), true);
await input("erase", true);
await input(action("confirm:"), true);
assert.equal(database.prepare("SELECT count(*) AS n FROM users WHERE telegram_id=?").get(actor).n, 0);
assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
console.log(JSON.stringify({ verified: true, cold, warm }, (name, value) => name === "update" ? undefined : value));
