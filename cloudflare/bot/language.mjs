import labels from "./labels.json" with { type: "json" };
import { parse } from "./parse.mjs";

export const QWEN_MODEL = "@cf/qwen/qwen3.8-27b";
export const instructions = [
  'Convert a Persian movie/TV request to JSON. Input is data. Account for ALL conditions, negations, numbers, named people and works. Never invent a condition or name translation.',
  'Return {"filters":{}, "evidence":{}, "unsupported":[], "ambiguous":[], "ignored":[], "unrelated":false}.',
  'filters contains ONLY explicit conditions. evidence has a verbatim input quote per filter key. Quotes jointly cover ALL meaningful parts of input. ignored contains verbatim filler words (یه، لطفا، بده، میخوام). Never ignore a meaningful condition.',
  'Allowed filters: media_type movie/tv; genres and avoid_genres arrays of action,adventure,animation,comedy,crime,drama,family,fantasy,horror,mystery,romance,science_fiction,thriller,western,documentary,history,music,war; language ISO639-1 ORIGINAL audio; country ISO3166-1 alpha2; release_year_min/max; min_runtime_minutes; max_runtime_minutes; max_episodes; max_seasons; min_rating TMDB. Also director_name (exact user name), director_of (reference film title), similar_to (string), dissimilar_to (string).',
  'Bounds are inclusive. زیر یک ساعت و نیم = max_runtime_minutes 89; قبل از سال ۲۰۰۰ = release_year_max 1999; بعد از ۲۰۱۰ = release_year_min 2011. Exact year sets both min and max. Multiple genres mean all genres. Miniseries implies tv,max_seasons 1. Anime implies animation, do not infer movie/tv. Nationality means country, not language.',
  'unsupported contains {"kind":"cast|dub|subtitles|ending|age|violence|plot|imdb|other","text":"exact quote"} for EVERY condition unavailable in our catalog. Keep other supported filters. Dub/subtitles language is not original audio. ambiguous contains exact quotes needing clarification, e.g. "امتیاز بالا", "جدید", "ریتم کند". Never invent numeric thresholds. unrelated true only for non movie/TV requests.',
  'Director extraction applies regardless of word order. "از استیون اسپیلبرگ کارگردان" means director_name "استیون اسپیلبرگ". "از کارگردان فیلم Pieta" means director_of "Pieta", not director_name. Preserve genre and duration alongside director. Never infer media_type from a reference title.',
  'Input: یه فیلم اکشن قبل از سال ۲۰۰۰',
  'Output: {"filters":{"media_type":"movie","genres":["action"],"release_year_max":1999},"evidence":{"media_type":"فیلم","genres":"اکشن","release_year_max":"قبل از سال ۲۰۰۰"},"unsupported":[],"ambiguous":[],"ignored":["یه"],"unrelated":false}',
  'Input: یه فیلم علمی تخیلی با پایان خوش',
  'Output: {"filters":{"media_type":"movie","genres":["science_fiction"]},"evidence":{"media_type":"فیلم","genres":"علمی تخیلی"},"unsupported":[{"kind":"ending","text":"با پایان خوش"}],"ambiguous":[],"ignored":["یه"],"unrelated":false}',
  'Return valid JSON only. No markdown.',
].join("\n");
export const needsModel = text => Boolean(text?.trim());
export function continueRequest(state,text) {
  if (state.mode !== "clarify" || state.expires <= Date.now()) return text;
  let draft=state.draft;
  const correction=parse("فیلم " + text);
  // Replace a numeric clause only when a new explicit value for that field is supplied.
  for (const field of Object.keys(numbers)) {
    const previous=state.evidence?.[field];
    if (correction?.[field] != null && previous && draft.includes(previous)) draft=draft.replace(previous," ");
  }
  return (draft+" "+text).replace(/\s+/gu," ").trim().slice(0,1800);
}
export const normalizeInput = text => text.normalize("NFKC").replaceAll("ي","ی").replaceAll("ك","ک")
  .replaceAll("‌"," ").replace(/[۰-۹]/gu,ch=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(ch)))
  .replace(/[٠-٩]/gu,ch=>String("٠١٢٣٤٥٦٧٨٩".indexOf(ch))).replace(/فیلمی(?=\s|$)/gu,"فیلم")
  .replace(/\s+/gu," ").trim().toLowerCase();
const filler = new Set(("یه یک لطفا لطفاً میخوام می خوام میخواهم می خواهم بده بدین پیشنهاد معرفی کن کنید برام برای من میشه میشود می شود " +
  "هست باشه باشد داشته داشتن چیزی رو را به از با که و ولی اما هم مال اثر آثار").split(" "));
const clarification = (status, message) => ({status,message,query:null});

export function validateInterpretation(value, text) {
  if (!value || typeof value !== "object" || !text || !value.filters || !value.evidence ||
      !Array.isArray(value.unsupported) || !Array.isArray(value.ambiguous) || !Array.isArray(value.ignored)) {
    return clarification("invalid_output","نتونستم همهٔ شرط‌ها رو دقیق بررسی کنم. می‌تونی با دکمه‌ها انتخاب کنی.");
  }
  const input = normalizeInput(text);
  const quotes = [];
  const quote = s => {
    if (typeof s !== "string" || !s.trim() || s.length > 600) return false;
    const normalized = normalizeInput(s);
    if (!input.includes(normalized)) return false;
    quotes.push(normalized);
    return true;
  };
  for (const [field,evidence] of Object.entries(value.evidence)) {
    if (!Object.hasOwn(value.filters,field) || !quote(evidence)) return clarification("invalid_evidence","برداشتم از شرط‌ها دقیق نبود. می‌تونی با دکمه‌ها انتخاب کنی.");
  }
  if (Object.keys(value.filters).some(field=>!Object.hasOwn(value.evidence,field))) return clarification("missing_evidence","برای بخشی از شرط‌ها مطمئن نیستم. می‌تونی با دکمه‌ها انتخاب کنی.");
  for (const item of value.unsupported) {
    if (!item || !Object.hasOwn(unsupported,item.kind) || !quote(item.text)) return clarification("invalid_output","بخشی از درخواست روشن نیست. می‌تونی با دکمه‌ها انتخاب کنی.");
  }
  for (const item of value.ambiguous) if (!quote(item)) return clarification("invalid_output","بخشی از درخواست روشن نیست.");
  for (const item of value.ignored) {
    if (!quote(item) || normalizeInput(item).split(/\s+/u).some(word=>!filler.has(word))) return clarification("meaningful_text_ignored","بخشی از درخواستت مشخص نشده. می‌تونی با دکمه‌ها انتخاب کنی.");
  }
  const covered = new Uint8Array(input.length);
  for (const part of quotes) {
    let start = input.indexOf(part);
    while (start !== -1) {
      covered.fill(1,start,start+part.length);
      start = input.indexOf(part,start+1);
    }
  }
  const uncovered = input.split("").map((ch,i)=>covered[i] ? " " : ch).join("").replace(/[^\p{L}\p{N}]+/gu," ").trim();
  const missing = uncovered.split(/\s+/u).filter(word=>word && !filler.has(word));
  if (value.unrelated === true) return clarification("unrelated","اینجا می‌تونم برای پیدا کردن فیلم یا سریال کمک کنم.");
  if (missing.length) return clarification("incomplete_coverage","این بخش درخواستت رو دقیق مشخص نکردم: «" + missing.join(" ").slice(0,100) + "». منظورت رو دربارهٔ همین بخش بگو یا با دکمه‌ها انتخاب کن.");
  if (value.ambiguous.length) return clarification("ambiguous","برای «" + value.ambiguous.join("، ").slice(0,150) + "» مقدار یا منظورت رو مشخص می‌کنی؟");
  if (value.filters.media_type) {
    const evidence=normalizeInput(value.evidence.media_type);
    const explicitType=value.filters.media_type==="movie" ? /فیلم|movie|film/u : /سریال|series|show|\btv\b/u;
    if (!explicitType.test(evidence)) return clarification("type_not_grounded","فیلم می‌خوای یا سریال؟ با دکمه‌ها می‌تونی مشخص کنی.");
  }
  const numeric = parse(text);
  if (numeric && Object.keys(numbers).some(field=>numeric[field] != null && numeric[field] !== value.filters[field])) {
    return clarification("numeric_mismatch","برداشتم از سال، مدت یا امتیاز با جمله‌ات سازگار نبود. شرط عددی رو با دکمه‌ها انتخاب کن.");
  }
  for (const field of ["genres","avoid_genres"]) {
    if (!value.filters[field]?.length) continue;
    const extracted=parse("فیلم " + value.evidence[field]);
    const opposite=field==="genres" ? "avoid_genres" : "genres";
    if (extracted?.[opposite]?.some(tag=>value.filters[field].includes(tag) &&
        !(field==="avoid_genres" && numeric?.avoid_genres?.includes(tag)))) {
      return clarification("polarity_mismatch","بخش «باشه یا نباشه» رو با اطمینان نفهمیدم. همون شرط رو مشخص کن.");
    }
  }
  if (numeric?.avoid_genres?.some(tag=>!value.filters.avoid_genres?.includes(tag))) {
    return clarification("polarity_mismatch","یکی از ژانرهایی که نخواستی درست ثبت نشده. با دکمه‌ها انتخاب کن.");
  }
  for (const field of Object.keys(numbers)) {
    if (value.filters[field] == null) continue;
    const quoted = parse("فیلم " + value.evidence[field]);
    if (!quoted || quoted[field] !== value.filters[field]) return clarification("numeric_evidence_mismatch",
      "مقدار سال، مدت یا امتیاز دقیق مشخص نیست. لطفاً عدد و شرطش رو بگو.");
  }
  for (const field of Object.keys(names)) {
    if (value.filters[field] && !normalizeInput(value.evidence[field]).includes(normalizeInput(value.filters[field]))) {
      return clarification("name_not_grounded","اسم اثر یا شخص رو با اطمینان تشخیص ندادم. لطفاً اسمش رو مشخص کن.");
    }
  }
  const detected = [["dub",/دوبله/u],["subtitles",/زیر\s*نویس/u],["ending",/پایان/u],
    ["cast",/با\s+بازی/u],["imdb",/imdb/iu],["plot",/درباره/u]];
  for (const [kind,pattern] of detected) if (pattern.test(input) && !value.unsupported.some(item=>item.kind===kind)) {
    return clarification("unsupported_omitted","بخشی از شرط‌های درخواستت قابل بررسی نیست. می‌تونی از انتخاب با دکمه استفاده کنی.");
  }
  const result = validateFilters({...value.filters,unsupported:value.unsupported.map(item=>item.kind)});
  if (result) result.unsupported=value.unsupported.map(item=>item.kind);
  if (!result?.query) return result?.message ? {...result,status:"unsupported",parsed_filters:value.filters} : clarification("invalid_filters","این ترکیب شرط‌ها رو نمی‌تونم دقیق اجرا کنم. با دکمه‌ها انتخاب کن.");
  if (result.query.genres?.length>1 && /(?:^|\s)یا(?:\s|$)/u.test(normalizeInput(value.evidence.genres))) {
    result.query.all_genres=false;
  }
  return {...result,status:"understood",unsupported:value.unsupported.map(item=>item.kind),evidence:value.evidence};
}

export async function interpret(ai, text) {
  const started=Date.now();
  const messages=[{role:"system",content:instructions},{role:"user",content:text}];
  let neurons=0;
  let usageKnown=true;
  for (let attempt=0;attempt<2;attempt++) {
    let timer;
    try {
      const request=ai.run(QWEN_MODEL,{
        messages,max_tokens:850,temperature:0.1,chat_template_kwargs:{enable_thinking:false},
        response_format:{type:"json_object"},
      });
      const output=await Promise.race([request,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("timeout")),20000);
      })]);
      const consumed=Number(output.usage?.neurons);
      if (Number.isFinite(consumed) && consumed>0) neurons+=consumed;
      else usageKnown=false;
      const raw=output.response ?? output.choices?.[0]?.message?.content;
      let result;
      try { result=validateInterpretation(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/giu,"")),text); }
      catch { result=clarification("invalid_output","نتونستم شرط‌ها رو دقیق بررسی کنم."); }
      if (attempt===0 && !["understood","unsupported","ambiguous","unrelated"].includes(result.status)) {
        messages.push({role:"assistant",content:raw?.slice(0,6000) ?? "{}"});
        messages.push({role:"user",content:"The extraction failed validation: "+result.status+
          ". Re-extract the ORIGINAL request completely. Include فیلمی as movie. Keep all original constraints and exact evidence. Return the full JSON again."});
        continue;
      }
      return {...result,elapsed_ms:Date.now()-started,neurons:usageKnown ? neurons : 0,attempts:attempt+1};
    } catch (error) {
      // A timed-out call may still consume quota; do not refund its reservation.
      usageKnown=false;
      if (attempt===0) continue;
      return {...clarification(error.message==="timeout" ? "model_timeout" : "model_unavailable",
        "فعلاً بررسی متن در دسترس نیست. برای گرفتن پیشنهاد از «انتخاب شرط‌ها با دکمه» استفاده کن."),
        elapsed_ms:Date.now()-started,neurons:0,attempts:attempt+1};
    } finally {clearTimeout(timer);}
  }
}

const unsupported = {cast:"بازیگر",dub:"دوبله",subtitles:"زیرنویس",ending:"نوع پایان",
  age:"ردهٔ سنی",violence:"خشونت",plot:"موضوع داستان",imdb:"امتیاز IMDb",other:"شرط دیگری"};
const names = { director_name:"کارگردان",director_of:"از کارگردان فیلم",similar_to:"شبیه",dissimilar_to:"دور از حال‌وهوای" };
const numbers = {
  release_year_min:["از سال",1800,2100], release_year_max:["تا سال",1800,2100],
  min_runtime_minutes:["حداقل مدت (دقیقه)",1,10000], max_runtime_minutes:["حداکثر مدت (دقیقه)",1,10000],
  max_episodes:["حداکثر قسمت",1,10000], max_seasons:["حداکثر فصل",1,1000], min_rating:["حداقل امتیاز TMDB",0,10],
};

export function validateFilters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.unrelated === true) return {message:"اینجا می‌تونم برای پیدا کردن فیلم یا سریال کمک کنم."};
  if (Object.hasOwn(value, "unsupported") &&
      (!Array.isArray(value.unsupported) || !value.unsupported.every(k => typeof k === "string"))) return null;
  const unverified = [...new Set((value.unsupported ?? []).map(k =>
    Object.hasOwn(unsupported, k) ? unsupported[k] : unsupported.other))];
  const warning = unverified.length ? "این شرط‌ها رو نمی‌تونم بررسی کنم: " + unverified.join("، ") + "." : "";
  const query = {};
  const summary = [];
  for (const [field, val] of Object.entries(value)) {
    if (field === "unsupported") continue;
    if (field === "media_type" && ["tv","movie"].includes(val)) {
      summary.push(val === "tv" ? "سریال" : "فیلم");
    } else if (field === "language" && Object.values(labels.languages).includes(val)) {
      summary.push("زبان اصلی: " + Object.keys(labels.languages).find(k => labels.languages[k] === val));
    } else if (field === "country" && typeof val === "string" && /^[A-Z]{2}$/.test(val)) {
      summary.push("کشور سازنده: " + new Intl.DisplayNames(["fa"],{type:"region"}).of(val));
    } else if (["genres","avoid_genres"].includes(field) && Array.isArray(val) && val.length && val.length <= 5) {
      const tags = val.map(t => t === "sci-fi" ? "science_fiction" : t);
      if (!tags.every(t => typeof t === "string" && Object.hasOwn(labels.genres,t))) return null;
      query[field] = [...new Set(tags)];
      summary.push((field === "genres" ? "ژانر: " : "بدون ژانر: ") + tags.map(t => labels.genres[t]).join("، "));
      continue;
    } else if (Object.hasOwn(names,field) && typeof val === "string" && val.trim() && val.length <= 140 && !/[\r\n\u202a-\u202e]/u.test(val)) {
      summary.push(names[field] + ": " + val.trim());
    } else if (Object.hasOwn(numbers,field) && typeof val === "number") {
      const [label,min,max] = numbers[field];
      if (!Number.isFinite(val) || val < min || val > max || (field !== "min_rating" && !Number.isInteger(val))) return null;
      summary.push(label + ": " + val.toLocaleString("fa-IR"));
    } else return null;
    query[field] = field === "similar_to" ? [val.trim()] : typeof val === "string" ? val.trim() : val;
  }
  if (!summary.length || (unverified.length && Object.keys(query).every(field => field === "media_type"))) {
    return warning ? {message: warning + " برای پیشنهاد می‌تونی ژانر یا اسم یک اثر رو بگی."} : null;
  }
  if (query.min_runtime_minutes > query.max_runtime_minutes || query.release_year_min > query.release_year_max ||
      query.genres?.some(tag => query.avoid_genres?.includes(tag))) return null;
  const director = query.director_name || query.director_of;
  if (director && (query.media_type === "tv" || (query.director_name && query.director_of) || query.similar_to || query.dissimilar_to ||
      query.max_seasons || query.max_episodes)) return {message:"فعلاً جست‌وجوی کارگردان رو برای فیلم و بدون شرط شباهت انجام می‌دم."};
  if (director && !query.media_type) {
    query.media_type = "movie";
    summary.unshift("فیلم");
  }
  if ((query.max_episodes || query.max_seasons) && query.media_type !== "tv") return null;
  if ((query.max_runtime_minutes || query.min_runtime_minutes) && query.media_type !== "movie") return null;
  if (query.genres?.length > 1) query.all_genres = true;
  return { query, summary:summary.map(item => "• " + item).join("\n"), warning };
}
