import { parse } from "./parse.mjs";
import { needsModel, validateInterpretation } from "./language.mjs";
import { matches } from "./catalog.mjs";

// These are product requirements, written independently of parser output.
// This audit uses synthetic messages and media only. It makes no network calls.
const cases = [
  ["ژانر و مدت", "یه فیلم معمایی زیر دو ساعت",
    {media_type:"movie",genres:["mystery"],max_runtime_minutes:119}],
  ["شرط‌های عکس", "یه فیلم زیر یک ساعت و نیم اکشن مال قبل از سال ۲۰۰۰ آمریکایی",
    {media_type:"movie",genres:["action"],max_runtime_minutes:89,release_year_max:1999,country:"US"}],
  ["کارگردان با جملهٔ ترکیبی", "از کارگردان Steven Spielberg یه فیلم اکشن میخوام",
    {media_type:"movie",director_name:"Steven Spielberg",genres:["action"]}],
  ["جابه‌جایی واژهٔ کارگردان", "از استیون اسپیلبرگ کارگردان پیشنهاد بده",
    {director_name:"استیون اسپیلبرگ"}],
  ["ژانر بدون نام نوع اثر", "یه چیزی اکشن زیر دو ساعت",
    {genres:["action"],max_runtime_minutes:119}],
  ["قبل از سال", "فیلم قبل از سال ۲۰۰۰",
    {media_type:"movie",release_year_max:1999}],
  ["بعد از سال", "فیلم بعد از سال ۲۰۰۰",
    {media_type:"movie",release_year_min:2001}],
  ["چند ژانر همزمان", "فیلم معمایی و اکشن",
    {media_type:"movie",genres:["mystery","action"],all_genres:true}],
  ["نفی ژانر", "فیلم معمایی که ترسناک نباشه",
    {media_type:"movie",genres:["mystery"],avoid_genres:["horror"]}],
  ["سریال کوتاه", "مینی سریال جنایی حداکثر ۶ قسمت",
    {media_type:"tv",genres:["crime"],max_episodes:6,max_seasons:1}],
  ["شرطی که داده ندارد", "یه فیلم علمی تخیلی با پایان خوش", null],
  ["موضوع داستان", "یه فیلم درباره سفر در زمان", null],
];
const equal = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) &&
    actual.length === expected.length && expected.every(value => actual.includes(value));
  return actual === expected;
};
const results = cases.map(([name,text,expected]) => {
  const query = parse(text);
  const model = needsModel(text,query);
  const missing = expected ? Object.keys(expected).filter(field => !equal(query?.[field],expected[field])) : [];
  const status = model ? "needs_model_evaluation" : !expected || missing.length ? "gap" : "pass";
  return {name,text,status,route:model ? "model" : "parser",expected,actual:query,missing};
});

// An output can be syntactically valid while losing the requested year.
const incomplete = validateInterpretation({
  filters:{media_type:"movie",genres:["action"]},
  evidence:{media_type:"فیلم",genres:"اکشن"},unsupported:[],ambiguous:[],ignored:[],unrelated:false,
},"فیلم اکشن قبل از سال ۲۰۰۰");
results.push({
  name:"حذف شرط در خروجی مدل",
  text:"فیلم اکشن قبل از سال ۲۰۰۰",
  status:incomplete?.query && incomplete.query.release_year_max !== 1999 ? "gap" : "pass",
  actual:incomplete?.query,
  expected:{media_type:"movie",genres:["action"],release_year_max:1999},
});

const target = {media_type:"movie",genres:["action"],max_runtime_minutes:89,release_year_max:1999,country:"US"};
const valid = {media_type:"movie",genres:["action"],runtime_minutes:85,release_date:"1990-01-01",countries:["US"]};
for (const [name,media,expected] of [
  ["پذیرش اثر مطابق شرط",valid,true],
  ["رد سال نامعتبر",{...valid,release_date:"2026-01-01"},false],
  ["رد مدت نامعتبر",{...valid,runtime_minutes:100},false],
  ["رد کشور نامعتبر",{...valid,countries:["GB"]},false],
  ["رد اطلاعات ناقص",{...valid,runtime_minutes:null},false],
]) {
  const actual = matches(media,target);
  results.push({name,status:actual === expected ? "pass" : "gap",actual,expected});
}
const count = status => results.filter(row => row.status === status).length;
console.log(JSON.stringify({
  scope:"Local routing and constraint audit. Model inference, Telegram delivery, concurrency and live TMDB are not evaluated.",
  passed:count("pass"),gaps:count("gap"),requiresModelEvaluation:count("needs_model_evaluation"),results,
},null,2));
if (process.argv.includes("--check") && count("gap")) process.exitCode = 1;
