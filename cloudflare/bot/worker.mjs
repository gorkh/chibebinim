import { CatalogError, findCandidates, rankItems } from "./catalog.mjs";
import { parse, parseReferenceReply } from "./parse.mjs";
import { interpret, needsModel } from "./language.mjs";
import logo from "./tmdb-logo.mjs";
import { button, cardButtons, cardText, ccloudDownload, clarify, escape, expired, fa, genres, home,
  mediaLabel, menu, options, quick, referenceLabel, settings, ui, unavailable } from "./ui.mjs";

const keyPattern = /^[a-f0-9]{32}$/;
const key = () => crypto.randomUUID().replaceAll("-", "");
const now = (offset = 0) => new Date(Date.now() + offset).toISOString().replace("T", " ").slice(0, 23);
const HOUR = 3600_000;
const CHAT_LIMIT = 600;
const guided = [button("انتخاب شرط‌ها با دکمه", "guided")];
const guidedGenres = [...quick, "animation"];
const guidedLimits = {
  movie: { "90": ["زیر ۹۰ دقیقه","max_runtime_minutes",89], "120": ["زیر دو ساعت","max_runtime_minutes",119] },
  tv: { "6": ["حداکثر ۶ قسمت","max_episodes",6], "10": ["حداکثر ۱۰ قسمت","max_episodes",10] },
};

class TelegramError extends Error {
  constructor(code) { super("Telegram API error"); this.code = code; }
}

function telegram(token) {
  return async (method, parameters) => {
    let body = JSON.stringify(parameters);
    let headers = {"Content-Type":"application/json"};
    if (parameters.photo instanceof Blob) {
      body = new FormData();
      for (const [name, value] of Object.entries(parameters)) {
        if (value instanceof Blob) body.append(name, value, "tmdb-logo.png");
        else body.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      headers = {};
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers, body, redirect: "manual",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new TelegramError(result?.error_code ?? response.status);
    return result.result;
  };
}

class Bot {
  constructor(db, sender, chatId, tmdbKey, reply, recommendLimit, ai, aiLimit) {
    this.db = db;
    this.id = sender;
    this.chatId = chatId;
    this.tmdbKey = tmdbKey;
    this.reply = reply;
    this.recommendLimit = recommendLimit;
    this.ai = ai;
    this.aiLimit = aiLimit;
  }
  sql(query, ...args) { return this.db.prepare(query).bind(...args); }
  first(query, ...args) { return this.sql(query, ...args).first(); }
  run(query, ...args) { return this.sql(query, ...args).run(); }
  async all(query, ...args) { return (await this.sql(query, ...args).all()).results; }
  async user(create) {
    let row = await this.first("SELECT id,last_active_at FROM users WHERE telegram_id=?", this.id);
    if (!row && create) row = await this.first(
      "INSERT INTO users(telegram_id,language_code,created_at,updated_at,last_active_at,onboarding_completed,is_blocked) VALUES(?,'fa',?,?,?,1,0) ON CONFLICT(telegram_id) DO UPDATE SET last_active_at=excluded.last_active_at RETURNING id",
      this.id, now(), now(), now(),
    );
    if (!row) return false;
    this.userId = row.id;
    if (row.last_active_at && row.last_active_at < now(-15 * 60_000)) await this.run(
      "UPDATE users SET last_active_at=?,is_blocked=0 WHERE id=?", now(), this.userId);
    return true;
  }
  event(name, data = {}) {
    return this.sql("INSERT INTO analytics_events (user_id,event_name,metadata_json,created_at) VALUES(?,?,?,?)",
      this.userId, name, JSON.stringify(data), now());
  }
  async diagnostic(status, fields = {}) {
    try { await this.event("bot_diagnostic", {status, ...fields}).run(); }
    catch { console.warn("bot_diagnostic_write_failed", status); }
  }
  async state() {
    const row = await this.first("SELECT document FROM worker_state WHERE user_id=?", this.userId);
    return row ? JSON.parse(row.document) : {};
  }
  setState(state) {
    return this.run("INSERT INTO worker_state(user_id,document) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET document=excluded.document",
      this.userId, JSON.stringify(state));
  }
  send(text, keyboard, html = false) {
    return this.reply("sendMessage", {
      chat_id: this.chatId, text, ...(html ? { parse_mode:"HTML" } : {}),
      ...(keyboard ? { reply_markup:{inline_keyboard:keyboard} } : {}),
    });
  }
  async quick(useGuide = false) {
    const nonce = key().slice(0,10);
    await this.setState({ mode:"type", nonce, useGuide });
    const types = Object.entries(ui.TYPES).filter(([type]) => !useGuide || type !== "any");
    return this.send("فیلم می‌خوای یا سریال؟", [...types.map(([type, label]) =>
      [button(label, `type:${nonce}:${type}`)]), home]);
  }
  async smart() {
    await this.setState({mode:"smart"});
    return this.send(ui.SMART, [guided,home]);
  }
  async profile() {
    const [weights, metrics] = await Promise.all([
      this.first("SELECT genre_weights_json FROM user_preferences WHERE user_id=?", this.userId),
      this.first("SELECT count(*) FILTER (WHERE preference='liked') liked, count(*) FILTER (WHERE is_watched) watched, (SELECT count(*) FROM watchlist WHERE user_id=?) saved FROM user_media_interactions WHERE user_id=?", this.userId, this.userId),
    ]);
    const top = Object.entries(JSON.parse(weights?.genre_weights_json ?? "{}")).filter(([,w]) => w > 0)
      .sort((a,b) => b[1] - a[1]).map(([g]) => genres[g]).filter(Boolean).slice(0,4);
    return this.send(`❤️ سلیقهٔ من\n\nپسندیده‌ها: ${fa(metrics.liked)}\nدیده‌ها: ${fa(metrics.watched)}\nفهرست تماشا: ${fa(metrics.saved)}${top.length ? `\nژانرهای محبوب: ${top.join("، ")}` : ""}`, [home]);
  }
  async watchlist(page) {
    const rows = await this.all(
      "SELECT m.id,m.metadata_json FROM watchlist w JOIN media m ON w.media_id=m.id WHERE w.user_id=? ORDER BY w.created_at DESC,m.id LIMIT 6 OFFSET ?",
      this.userId, page * 5,
    );
    const actions = rows.slice(0, 5).map(row => [button(mediaLabel(JSON.parse(row.metadata_json)).slice(0,64), `detail:${row.id}:${page}`)]);
    const nav = [];
    if (page > 0) nav.push(button("◀️ قبلی", `list:${page-1}`));
    if (rows.length > 5) nav.push(button("بعدی ▶️", `list:${page+1}`));
    if (nav.length) actions.push(nav);
    return this.send(rows.length ? "🔖 لیست تماشای من" : "چیزی در این صفحه از لیست تماشا نیست.", [...actions, home]);
  }
  async cardRow(id, fromList) {
    const sql = fromList ?
      "SELECT m.id media_id,m.metadata_json,'' explanation FROM watchlist w JOIN media m ON w.media_id=m.id WHERE w.user_id=? AND w.media_id=?" :
      "SELECT r.id,r.media_id,r.explanation,r.session_id,m.metadata_json FROM recommendations r JOIN media m ON r.media_id=m.id WHERE r.user_id=? AND r.id=?";
    return this.first(sql, this.userId, id);
  }
  status(id) {
    return this.first(
      "SELECT (SELECT preference FROM user_media_interactions WHERE user_id=? AND media_id=?) preference,(SELECT is_watched FROM user_media_interactions WHERE user_id=? AND media_id=?) is_watched, EXISTS(SELECT 1 FROM watchlist WHERE user_id=? AND media_id=?) saved",
      this.userId,id,this.userId,id,this.userId,id,
    );
  }
  async render(media, id, explanation, page = 0) {
    const status = await this.status(media.id);
    const keyboard = cardButtons(media, id, status, page);
    const message = cardText(media, explanation);
    if (media.poster_path && /^https:\/\/image\.tmdb\.org\//.test(media.poster_path)) {
      try {
        return await this.reply("sendPhoto", {chat_id:this.chatId,photo:media.poster_path,caption:message,
          parse_mode:"HTML",reply_markup:{inline_keyboard:keyboard}});
      } catch (error) { if (!(error instanceof TelegramError) || error.code !== 400) throw error; }
    }
    return this.send(message, keyboard, true);
  }
  media(media) {
    return this.sql("INSERT INTO media(id,source,external_id,media_type,metadata_json,metadata_updated_at,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,metadata_updated_at=excluded.metadata_updated_at",
      media.id, media.source, media.external_id, media.media_type, JSON.stringify(media), now(), now());
  }
  recommendation(id, session, mode, item, conditional = false) {
    const columns = "INSERT INTO recommendations(id,user_id,media_id,session_id,request_type,recommendation_score,explanation,recommended_at)";
    return this.sql(conditional ? `${columns} SELECT ?,?,?,?,?,?,?,? WHERE changes()>0` : `${columns} VALUES(?,?,?,?,?,?,?,?)`,
      id,this.userId,item.media.id,session,mode,item.score,item.explanation,now());
  }
  async recommend(query, mode, chosen, hint) {
    if (this.recommendLimit && !(await this.recommendLimit.limit({key: String(this.id)})).success) {
      return this.send("چند پیشنهاد پشت‌سرهم خواستی. یک دقیقه دیگه دوباره امتحان کن.");
    }
    const started = Date.now();
    const context = {mode, kind: query.media_type ?? "any", genres: query.genres ?? [],
      reference_search: Boolean(query.similar_to?.length),
      reference_exclusion: Boolean(query.dissimilar_to),
      director_search: query.director_of ? "by_title" : query.director_name ? "by_name" : null,
      follow_up: hint?.director ? "director" : hint?.year ? "year" : chosen ? "button" : null};
    let result;
    try { result = await findCandidates(this.db, this.tmdbKey, query, chosen, hint); }
    catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      await this.diagnostic("catalog_unavailable", {...context, elapsed_ms: Date.now() - started});
      return this.send(unavailable, [options, home]);
    }
    if (result.directorUnresolved) {
      await this.diagnostic("director_unresolved", context);
      return this.send("کارگردان رو با اطمینان پیدا نکردم. اسم انگلیسی‌اش رو بنویس یا بگو «از کارگردان فیلم …».", [options,home]);
    }
    if (result.exclusionUnresolved) {
      await this.diagnostic("exclusion_reference_unresolved", context);
      return this.send("مطمئن نشدم کدوم اثر رو می‌خوای کنار بذاری. همون درخواست رو با اسم کامل اثر یا سال ساختش بفرست.", [options,home]);
    }
    if (result.missing) {
      await this.diagnostic("reference_not_found", context);
      return this.send("عنوان مرجع رو پیدا نکردم. نام انگلیسی اثر را دقیق‌تر بنویس.", [options,home]);
    }
    if (result.choices) {
      const nonce = key().slice(0,10);
      await this.setState({mode:"ref",nonce,query,choices:result.choices.map(m => m.id)});
      await this.diagnostic(result.unmatchedHint ? "reference_hint_unmatched" : "reference_ambiguous",
        {...context, choices: result.choices.length});
      const prompt = result.unmatchedHint ? "با این مشخصات اثری در فهرست پیدا نکردم." : "منظورت کدوم اثره؟";
      return this.send(`${prompt}\nیکی از گزینه‌ها رو بزن یا سال ساخت یا اسم کارگردان رو بنویس.`, [...result.choices.map((m,i) => [button(referenceLabel(m), `ref:${nonce}:${i}`)]),home]);
    }
    const [history, interactions, prefs] = await Promise.all([
      this.all("SELECT media_id FROM recommendations WHERE user_id=? ORDER BY recommended_at DESC LIMIT 30",this.userId),
      this.all("SELECT media_id,preference,is_watched FROM user_media_interactions WHERE user_id=?",this.userId),
      this.first("SELECT genre_weights_json FROM user_preferences WHERE user_id=?",this.userId),
    ]);
    const queue = rankItems(result,query,history.map(r => r.media_id),interactions,JSON.parse(prefs?.genre_weights_json ?? "{}")).slice(0,20);
    const ref = result.reference;
    const resolved = {...context, reference: ref ? {title: ref.title, year: ref.release_date?.slice(0, 4) ?? null} : null};
    if (!queue.length) {
      await this.diagnostic("recommendation_empty", {...resolved, candidates: result.items.length});
      return this.send(ui.EMPTY,[guided,options,home]);
    }
    const session = key(), rec = key(), item = queue[0];
    if (hint && result.reference) item.explanation = `اثر مرجع: ${mediaLabel(result.reference)}\n${item.explanation}`;
    const safeQuery = {...query};
    delete safeQuery.similar_to;
    delete safeQuery.dissimilar_to;
    delete safeQuery.director_name;
    delete safeQuery.director_of;
    await this.db.batch([
      this.media(item.media),
      this.sql("INSERT INTO recommendation_sessions(id,user_id,request_json,candidates,request_type,current_position,created_at,expires_at) VALUES(?,?,?,?,?,1,?,?)",
        session,this.userId,JSON.stringify(safeQuery),JSON.stringify(queue),mode,now(),now(HOUR)),
      this.recommendation(rec,session,mode,item),
      this.sql("DELETE FROM worker_state WHERE user_id=?", this.userId),
      this.event("recommendation_viewed", {...resolved, recommendation_id: rec,
        media_id: item.media.id, title: item.media.title, candidates: queue.length, elapsed_ms: Date.now() - started}),
    ]);
    return this.render(item.media,rec,item.explanation);
  }
  async next(row) {
    const session = await this.first("SELECT * FROM recommendation_sessions WHERE id=? AND user_id=? AND expires_at>?",row.session_id,this.userId,now());
    const latest = await this.first("SELECT id FROM recommendations WHERE session_id=? AND user_id=? ORDER BY recommended_at DESC,id DESC LIMIT 1",row.session_id,this.userId);
    if (!session || latest?.id !== row.id) {
      await this.diagnostic("recommendation_button_expired");
      return this.send(expired,[options,home]);
    }
    const queue = JSON.parse(session.candidates);
    const old = session.current_position;
    let position = old;
    while (position < queue.length) {
      const item = queue[position++];
      const media = item.media ?? JSON.parse((await this.first("SELECT metadata_json FROM media WHERE id=?",item.media_id))?.metadata_json ?? "null");
      if (!media) continue;
      media.id ??= item.media_id;
      const status = await this.status(media.id);
      if (status.is_watched || status.preference === "disliked") continue;
      const rec = key();
      const [,updated, inserted] = await this.db.batch([
        this.media(media),
        this.sql("UPDATE recommendation_sessions SET current_position=? WHERE id=? AND user_id=? AND current_position=? RETURNING id",position,session.id,this.userId,old),
        this.recommendation(rec,session.id,session.request_type,{...item,media},true),
      ]);
      if (!updated.results.length || !inserted.meta.changes) return this.send(expired,[options,home]);
      await this.event("recommendation_next_clicked", {
        previous_recommendation_id: row.id, recommendation_id: rec, media_id: media.id, title: media.title,
      }).run();
      return this.render(media,rec,item.explanation);
    }
    await this.diagnostic("recommendation_queue_exhausted");
    return this.send(ui.EMPTY,[options,home]);
  }
  async feedback(row, action, msgId) {
    if (action === "save") {
      await this.run("INSERT OR IGNORE INTO watchlist(user_id,media_id,created_at) VALUES(?,?,?)",this.userId,row.media_id,now());
    } else {
      const watched = action === "watched";
      await this.run("INSERT INTO user_media_interactions(user_id,media_id,preference,is_watched,watched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,media_id) DO UPDATE SET preference=CASE WHEN excluded.is_watched THEN preference ELSE excluded.preference END,is_watched=MAX(is_watched,excluded.is_watched),watched_at=COALESCE(watched_at,excluded.watched_at),updated_at=excluded.updated_at",
        this.userId,row.media_id,watched ? "neutral" : action,Number(watched),watched ? now() : null,now(),now());
      if (!watched) await this.rebuildTaste();
    }
    await this.event(({save:"watchlist_added",liked:"movie_liked",disliked:"movie_disliked",watched:"movie_watched"})[action],
      {recommendation_id: row.id, media_id: row.media_id}).run();
    const media = JSON.parse(row.metadata_json);
    media.id = row.media_id;
    try { return await this.reply("editMessageReplyMarkup", {chat_id:this.chatId,message_id:msgId,
      reply_markup:{inline_keyboard:cardButtons(media,row.id,await this.status(row.media_id))}}); }
    catch (error) { if (!(error instanceof TelegramError) || error.code !== 400) throw error; }
  }
  async rebuildTaste() {
    await this.run(`INSERT INTO user_preferences(user_id,genre_weights_json,preferred_media_types_json,preferred_languages_json,settings_json,updated_at)
      SELECT ?,COALESCE(json_group_object(genre,weight),'{}'),'{}','{}','{}',? FROM (
        SELECT j.value genre, max(-3,min(3,sum(CASE WHEN i.preference='liked' THEN 1 ELSE -0.35 END))) weight
        FROM user_media_interactions i JOIN media m ON m.id=i.media_id JOIN json_each(m.metadata_json,'$.genres') j
        WHERE i.user_id=? AND i.preference IN ('liked','disliked') GROUP BY j.value
      ) WHERE true ON CONFLICT(user_id) DO UPDATE SET genre_weights_json=excluded.genre_weights_json,updated_at=excluded.updated_at`,
      this.userId,now(),this.userId);
  }
  async message(text) {
    const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1];
    if (["start","menu","cancel"].includes(cmd)) {
      await this.setState({});
      if (cmd === "start") await this.event("user_started").run();
      return this.send(cmd === "start" ? ui.WELCOME : "امشب چی ببینیم؟ 🍿",menu);
    }
    if (cmd === "recommend") return this.quick();
    if (cmd === "watchlist") return this.watchlist(0);
    if (cmd === "profile") return this.profile();
    if (cmd === "help") return this.send(ui.HELP,[[button("منبع اطلاعات","credits")],home]);
    if (cmd === "privacy") return this.send(ui.PRIVACY,settings);
    const state = await this.state();
    if (state.mode === "ref") {
      const fresh = text.length <= CHAT_LIMIT ? parse(text) : null;
      if (fresh?.director_name || fresh?.director_of) return this.recommend(fresh, "smart");
      const hint = text.length <= CHAT_LIMIT ? parseReferenceReply(text) : null;
      if (hint) return this.recommend(state.query, "smart", undefined, hint);
      await this.diagnostic("reference_hint_unrecognized", {mode:"smart"});
      return this.send("سال ساخت رو بنویس، مثلاً «۲۰۰۷»، یا بگو «کارگردانش Sean Penn است». از دکمه‌های پیام قبلی هم می‌تونی انتخاب کنی.", [home]);
    }
    if (!["smart", "interpret"].includes(state.mode)) return this.send("از منو نوع پیشنهاد رو انتخاب کن.",menu);
    if (state.mode === "interpret") await this.setState({mode:"smart"});
    const query = text.length <= CHAT_LIMIT ? parse(text) : null;
    if (this.ai && text.length <= CHAT_LIMIT && needsModel(text, query)) {
      if (!(await this.aiLimit.limit({key:String(this.id)})).success) {
        return this.send("درخواست‌های پیچیده رو کمی با فاصله بفرست. یک دقیقه دیگه امتحان کن.", [options,home]);
      }
      const result = await interpret(this.ai, text);
      if (result?.query) {
        const nonce = key().slice(0,10);
        await this.setState({mode:"interpret",query:result.query,nonce});
        const prompt = result.warning
          ? `${result.warning}\n\nاگه موافقی، فقط با این شرط‌ها می‌گردم:\n${result.summary}`
          : `این شرط‌ها رو فهمیدم. با همین‌ها بگردم؟\n${result.summary}`;
        return this.send(prompt,
          [[button(result.warning ? "با بقیهٔ شرط‌ها بگرد" : "بگرد",`interpret:${nonce}`),
            button("دوباره می‌نویسم","smart")],home]);
      }
      if (result?.message) return this.send(result.message, [guided,options,home]);
      return this.send("نتونستم شرط‌های این جمله رو دقیق دربیارم. می‌تونی نوع اثر، ژانر و محدودیتش رو با دکمه انتخاب کنی.", [guided,options,home]);
    }
    if (query) return this.recommend(query,"smart");
    await this.diagnostic(text.length > CHAT_LIMIT ? "request_too_long" : "request_unparsed", {mode:"smart"});
    return this.send(clarify,[guided,options,home]);
  }
  async callback(callback) {
    const [cmd,a,b] = callback.data.split(":");
    const state = await this.state();
    if (cmd === "interpret" && state.mode === "interpret" && a === state.nonce) {
      const consumed = await this.first("DELETE FROM worker_state WHERE user_id=? AND json_extract(document,'$.nonce')=? RETURNING user_id", this.userId, a);
      if (!consumed) return this.send(expired,[options,home]);
      await this.setState({mode:"smart"});
      return this.recommend(state.query,"smart");
    }
    const page = n => /^\d{1,5}$/.test(n ?? "") ? Number(n) : 0;
    if (cmd === "menu") { await this.setState({}); return this.send("امشب چی ببینیم؟ 🍿",menu); }
    if (cmd === "quick") return this.quick();
    if (cmd === "guided") return this.quick(true);
    if (cmd === "smart") return this.smart();
    if (cmd === "profile") return this.profile();
    if (cmd === "settings") return this.send("تنظیمات",settings);
    if (cmd === "ccloud_help") return this.send(
      "اگه CCloud رو داری، در کارت فیلم «کپی اسم فیلم» رو بزن. بعد CCloud رو از روی گوشی باز کن و اسم رو داخلش جست‌وجو کن. ممکنه فیلم اونجا موجود نباشه.\n\nاگه برنامه رو نداری، لینک دانلود پایین این پیامه.",
      [ccloudDownload,home]);
    if (cmd === "privacy") return this.send(ui.PRIVACY,settings);
    if (cmd === "credits") return this.reply("sendPhoto", {
      chat_id:this.chatId,photo:new Blob([Uint8Array.from(atob(logo), ch => ch.charCodeAt(0))], {type:"image/png"}),
      caption:ui.TMDB_CREDITS,reply_markup:{inline_keyboard:[[{text:"TMDB",url:"https://www.themoviedb.org/"}],home]},
    }).catch(error => { if (error instanceof TelegramError && error.code === 400) return this.send(ui.TMDB_CREDITS,[home]); throw error; });
    if (cmd === "list") return this.watchlist(page(a));
    if (cmd === "reset" || cmd === "erase") {
      const nonce = key().slice(0,12);
      await this.setState({mode:"confirm",nonce,action:cmd});
      return this.send(cmd === "erase" ? "همهٔ اطلاعات حسابت حذف بشه؟" : "سلیقه و بازخوردها از نو تنظیم بشن؟",
        [[button("تأیید می‌کنم",`confirm:${nonce}`),button("لغو","settings")]]);
    }
    if (cmd === "confirm" && state.mode === "confirm" && a === state.nonce) {
      if (state.action === "erase") {
        await this.run("DELETE FROM users WHERE id=?",this.userId);
        return this.send("اطلاعات حساب پاک شد. برای شروع دوباره /start بزن.");
      }
      await this.db.batch([
        this.sql("UPDATE user_media_interactions SET preference='neutral' WHERE user_id=?",this.userId),
        this.sql("UPDATE user_preferences SET genre_weights_json='{}',preferred_media_types_json='{}',preferred_languages_json='{}' WHERE user_id=?",this.userId),
        this.sql("DELETE FROM worker_state WHERE user_id=?",this.userId),
      ]);
      return this.send("سلیقه از نو تنظیم شد.",menu);
    }
    if (cmd === "type" && state.mode === "type" && a === state.nonce && Object.hasOwn(ui.TYPES,b)) {
      const nonce = key().slice(0,10);
      if (state.useGuide && !Object.hasOwn(guidedLimits, b)) return this.send(expired,[guided,home]);
      await this.setState({mode:"genre",nonce,type:b,useGuide:state.useGuide});
      const buttons = (state.useGuide ? guidedGenres : quick).map(genre => button(genres[genre],`genre:${nonce}:${genre}`));
      const rows = [];
      for (let i=0;i<buttons.length;i+=2) rows.push(buttons.slice(i,i+2));
      return this.send("امشب چه ژانری دوست داری؟",[...rows,[button(state.useGuide ? "ژانر فرقی نداره" : "🎲 سورپرایزم کن",`genre:${nonce}:any`)],home]);
    }
    if (cmd === "genre" && state.mode === "genre" && a === state.nonce && ((state.useGuide ? guidedGenres : quick).includes(b) || b === "any")) {
      const query = {media_type:state.type === "any" ? null : state.type,genres:b === "any" ? [] : [b]};
      if (!state.useGuide) return this.recommend(query,"quick");
      const nonce = key().slice(0,10);
      await this.setState({mode:"guided_limit",nonce,query});
      const rows = Object.entries(guidedLimits[query.media_type]).map(([value,[label]]) => [button(label,`guided_limit:${nonce}:${value}`)]);
      return this.send(query.media_type === "movie" ? "فیلم چقدر طول بکشه؟" : "سریال حداکثر چند قسمت باشه؟",
        [...rows,[button("فرقی نداره",`guided_limit:${nonce}:any`)],home]);
    }
    if (cmd === "guided_limit" && state.mode === "guided_limit" && a === state.nonce) {
      const limits = guidedLimits[state.query.media_type];
      if (b === "any" || Object.hasOwn(limits,b)) {
        const query = {...state.query};
        if (b !== "any") {
          const [,field,value] = limits[b];
          query[field] = value;
        }
        return this.recommend(query,"smart");
      }
    }
    if (cmd === "ref" && state.mode === "ref" && a === state.nonce && /^\d$/.test(b ?? "") && state.choices[Number(b)]) {
      return this.recommend(state.query,"smart",state.choices[Number(b)]);
    }
    if (cmd === "remove" && keyPattern.test(a ?? "")) {
      await this.run("DELETE FROM watchlist WHERE user_id=? AND media_id=?",this.userId,a);
      return this.watchlist(page(b));
    }
    const lookup = cmd === "copy" ? b : a;
    if (keyPattern.test(lookup ?? "") && ["copy","detail","next","liked","disliked","watched","save"].includes(cmd)) {
      const fromList = cmd === "detail" || (cmd === "copy" && a === "w");
      const row = await this.cardRow(lookup,fromList);
      if (row) {
        if (cmd === "next") return this.next(row);
        const media = JSON.parse(row.metadata_json);
        media.id = row.media_id;
        if (cmd === "detail") return this.render(media,null,"",page(b));
        if (cmd === "copy") return this.send(`<code>${escape(media.title.slice(0,256))}</code>`,null,true);
        return this.feedback(row,cmd,callback.message.message_id);
      }
    }
    return this.send(expired,[options,home]);
  }
}

export async function handleUpdate(env, update, reply) {
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const sender = callback?.from ?? message?.from;
  if (!message || message.chat?.type !== "private" || sender?.is_bot ||
      !Number.isSafeInteger(sender?.id) || sender.id <= 0 || sender.id !== message.chat.id ||
      !Number.isSafeInteger(update.update_id)) return;
  if (callback ? !/^[a-z0-9_:]{1,64}$/.test(callback.data ?? "") : !message.text?.trim()) return;
  if (env.USER_UPDATES_LIMIT && !(await env.USER_UPDATES_LIMIT.limit({key: String(sender.id)})).success) return;
  const db = env.BOT_DB;
  const claim = await db.prepare("INSERT INTO worker_updates(id) VALUES(?) ON CONFLICT DO NOTHING RETURNING id").bind(update.update_id).first();
  if (!claim) return;
  const bot = new Bot(db,sender.id,message.chat.id,env.TMDB_READ_TOKEN,reply,env.USER_RECOMMEND_LIMIT,env.AI,env.USER_AI_LIMIT);
  try {
    if (callback) {
      try { await reply("answerCallbackQuery",{callback_query_id:callback.id}); }
      catch (error) { if (!(error instanceof TelegramError) || error.code !== 400) throw error; }
    }
    if (!await bot.user(!callback)) return bot.send("برای شروع /start بزن.");
    return callback ? await bot.callback(callback) : await bot.message(message.text ?? "");
  } catch (error) {
    // The same transaction can have delivered a message before a network error; retry state safely where possible.
    if (bot.userId) await bot.diagnostic("update_failed", {
      category: error instanceof TelegramError ? "telegram" : "internal",
      ...(error instanceof TelegramError ? {code: error.code} : {}),
    });
    if (error instanceof TelegramError && error.code === 403) return;
    await db.prepare("DELETE FROM worker_updates WHERE id=?").bind(update.update_id).run();
    throw error;
  }
}

export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const row = await env.BOT_DB?.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE name='users'").first();
      return Response.json({ bot_schema: Boolean(row?.ok) });
    }
    if (path !== "/telegram" || request.method !== "POST") return new Response(null,{status:404});
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
      return new Response(null,{status:401});
    if (!env.BOT_TOKEN || !env.BOT_DB) return new Response(null,{status:503});
    let update;
    try { update = await request.json(); } catch { return new Response(null,{status:400}); }
    if (!update || typeof update !== "object") return new Response(null,{status:400});
    try { await handleUpdate(env,update,telegram(env.BOT_TOKEN)); }
    catch (error) {
      console.error("telegram_update_failed", error instanceof TelegramError ? `telegram_${error.code}` : "internal");
      return new Response(null,{status:503});
    }
    return new Response(null,{status:204});
  },
  async scheduled(_controller, env) {
    await env.BOT_DB.batch([
      env.BOT_DB.prepare("DELETE FROM worker_updates WHERE created_at < unixepoch()-172800"),
      env.BOT_DB.prepare("DELETE FROM worker_catalog WHERE expires_at < unixepoch()"),
    ]);
  },
};
