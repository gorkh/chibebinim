import labels from "./labels.json" with { type: "json" };

const persianDigits = "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩";
const normalize = (text) => text.replace(/[۰-۹٠-٩]/gu, ch => String(persianDigits.indexOf(ch) % 10))
  .replaceAll("ي", "ی").replaceAll("ك", "ک").replaceAll("‌", " ")
  .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").replace(/\s+/gu, " ").trim();
const bound = "بیشتر از|کمتر از|حداکثر|حداقل|بالاتر از|زیر|تا|بالای|بالا(?:تر)?|حدود";
const number = `(?:[0-9]+|${Object.keys(labels.numbers).join("|")})`;
const toNumber = (s) => labels.numbers[s] ?? Number(s);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseReferenceReply(text) {
  const value = normalize(text);
  const year = value.match(/(?<!\d)(?:18|19|20)\d{2}(?!\d)/u)?.[0];
  const director = value.match(/کارگردان(?:ش|شون|ی)?(?:\s+به\s+نام)?\s*[:：]?\s*(.+?)(?:\s+(?:است|بود|هست|باشه|ساخته)(?=\s|[.،!?؟]|$)|[.،!?؟]|$)/u)?.[1]?.trim();
  if ((!director || director.length > 100) && !year) return null;
  return { ...(director && director.length <= 100 ? { director } : {}), ...(year ? { year: Number(year) } : {}) };
}

export function parse(text) {
  const value = normalize(text);
  const directorRequest = value.match(/^(?:(?:یه|یک)\s+)?(?:فیلمی?\s+)?از\s+کارگردان?(?:ِ|ی)?\s+(?:(فیلم|سریال)\s+)?(.+?)(?:\s+(?:می\s*خوام|می\s*خواهم|پیشنهاد بده|معرفی کن))?[؟.!]?$/u);
  if (directorRequest) {
    const [, kind, raw] = directorRequest;
    const name = raw.replace(/^[«"]|[»"]$/gu, "").trim();
    if (!name || name.length > 140 || /(?:نباش|نمی\s*خوا|\s+(?:که|ولی|اما)\s)/u.test(name)) return null;
    return kind
      ? { media_type: "movie", director_of: name, director_reference_type: kind === "سریال" ? "tv" : "movie" }
      : { media_type: "movie", director_name: name };
  }
  const query = {};
  const refStart = '(?:شبیه|مثل|مشابه)(?:\\s+|(?=[A-Za-z«"]))(?:(?:فیلم|سریال|انیمه)\\s+)?';
  const title = '(?:[«"]([^»"]+)[»"]|((?:(?!\\s+(?:شبیه|مثل|مشابه|ولی|اما|بلکه)\\s)[^«»"،,.!?؟؛])+?))';
  const negative = '(?:نباشه|نباشد|نیست|نمی\\s*خوام|نمی\\s*خواهم)';
  const excluded = value.match(new RegExp(`(?<![\\p{L}\\p{N}])${refStart}${title}\\s+${negative}(?=\\s|[،,.!?؟؛]|$)`, "u"))
    ?? value.match(new RegExp(`(?<![\\p{L}\\p{N}])نه\\s+${refStart}${title}(?=[،,.!?؟؛]|\\s+(?:و |ولی |اما |بده|معرفی کن|پیشنهاد بده)|$)`, "u"));
  let remaining = excluded ? value.replace(excluded[0], "") : value;
  if (excluded) query.dissimilar_to = excluded.slice(1).find(Boolean).trim().slice(0, 140);
  const reference = remaining.match(/(?<![\p{L}\p{N}])(?:شبیه|مثل|مشابه)(?:\s+|(?=[A-Za-z«"]))(?:(?:فیلم|سریال|انیمه)\s+)?[«"]?(.+?)(?=[»"،,.!?؟؛]|\s+(?:و |که |ولی |اما |معرفی |پیشنهاد |بده|می\s*خوام|باشه)|$)/u);
  if (reference && !/نباش|نمی\s*خوا|نیست/u.test(reference[1])) remaining = remaining.replace(reference[0], "");
  else if (reference) return null;
  if (reference?.[1]?.trim()) query.similar_to = [reference[1].trim().slice(0, 140)];
  if (remaining.includes("فیلم") !== remaining.includes("سریال")) {
    query.media_type = remaining.includes("فیلم") ? "movie" : "tv";
  }
  for (const [genre, synonyms] of Object.entries(labels.synonyms)) {
    for (const word of synonyms) {
      const match = remaining.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(word)}(?![\\p{L}\\p{N}])`, "u"));
      if (!match) continue;
      const before = remaining.slice(0, match.index);
      const after = remaining.slice(match.index + word.length);
      const prefix = before.match(/(?:بدون|به جز|غیر از|نه)\s*$/u);
      const suffix = after.match(/^\s*(?:هم\s*)?(?:نباش[\p{L}]*|نمی\s*خوام|دوست ندار[\p{L}]*)/u);
      const field = prefix || suffix ? "avoid_genres" : "genres";
      (query[field] ??= []).push(genre);
      if (prefix || suffix) remaining = before.slice(0, prefix?.index ?? before.length) + after.slice(suffix?.[0].length ?? 0);
      break;
    }
  }
  const amount = new RegExp(`(?<bound>${bound})\\s+(?<n>${number})\\s*(?<unit>ساعت|دقیقه|قسمت|فصل)(?:\\s+و\\s+(?<extra>${number}|نیم)(?:\\s+دقیقه)?)?(?<neg>\\s+(?:نباشه|نش[هو]د))?`, "gu");
  for (const match of remaining.matchAll(amount)) {
    const {bound: op, n, unit, extra, neg} = match.groups;
    const lower = !neg && ["حداقل","بیشتر از","بالاتر از","بالای"].includes(op);
    if (op === "حدود" || (lower && ["قسمت","فصل"].includes(unit))) continue;
    let qty = toNumber(n);
    if (unit === "ساعت") qty = qty * 60 + (extra === "نیم" ? 30 : extra ? toNumber(extra) : 0);
    if (!neg && ["زیر","کمتر از","بیشتر از","بالاتر از","بالای"].includes(op)) qty += lower ? 1 : -1;
    if (qty < 1 || qty > 10000) return null;
    const field = unit === "قسمت" ? "max_episodes" : unit === "فصل" ? "max_seasons" :
      lower ? "min_runtime_minutes" : "max_runtime_minutes";
    query[field] = (lower ? Math.max : Math.min)(query[field] ?? qty, qty);
    remaining = remaining.replace(match[0], "");
  }
  if (/مینی\s*سریال/u.test(remaining)) query.max_seasons = 1;
  for (const match of remaining.matchAll(/(بعد از|قبل از|از سال|تا سال|سال)\s*((?:18|19|20)\d\d)/gu)) {
    const y = Number(match[2]);
    if (["بعد از","از سال","سال"].includes(match[1])) query.release_year_min = Math.max(query.release_year_min ?? 0, y + Number(match[1] === "بعد از"));
    if (["قبل از","تا سال","سال"].includes(match[1])) query.release_year_max = Math.min(query.release_year_max ?? 2100, y - Number(match[1] === "قبل از"));
    remaining = remaining.replace(match[0], "");
  }
  const rating = remaining.match(/(?:حداقل امتیاز|امتیاز(?: بالای| بالاتر از| حداقل))\s+(\d+(?:[.٫]\d+)?)/u);
  if (rating && !/imdb/i.test(remaining)) {
    query.min_rating = Number(rating[1].replace("٫", ".")) + (rating[0].includes("حداقل") ? 0 : .01);
    if (query.min_rating > 10) return null;
    remaining = remaining.replace(rating[0], "");
  }
  for (const [word, code] of Object.entries(labels.languages)) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(remaining)) {
      if (query.language && query.language !== code) return null;
      query.language = code;
    }
  }
  for (const [word, mood] of [["تاریک","dark"],["سبک","light"],["شاد","uplifting"],["پرتنش","intense"],["خفن","intense"]]) {
    if (remaining.includes(word)) { query.mood = mood; break; }
  }
  const uncertain = new RegExp(`${bound}|بدون|نباش|نمی\\s*خوا|غیر از|به جز|قسمت|فصل|دقیقه|ساعت|امتیاز|\\d|خشونت|دوبله|زیرنویس|کارگردان|بازیگر|جدید|قدیمی|صحنه|اسکار|نتفلیکس|پایان|مناسب|شبیه|مشابه|مثل|ریتم|فضای|براساس|واقعی`, "u");
  if (!Object.keys(query).some(field => field !== "dissimilar_to") || uncertain.test(remaining) ||
      query.min_runtime_minutes > query.max_runtime_minutes || query.release_year_min > query.release_year_max ||
      query.genres?.some(g => query.avoid_genres?.includes(g))) return null;
  return query;
}
