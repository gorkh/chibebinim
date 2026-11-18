import { instructions, QWEN_MODEL } from "../bot/language.mjs";
const models = ["@cf/google/gemma-4-26b-a4b-it", QWEN_MODEL];
const cases = [
  ["از استیون اسپیلبرگ کارگردان پیشنهاد بده", { director_name: "استیون اسپیلبرگ" }],
  ["از کیم کی دوک یه فیلم میخوام", { media_type: "movie", director_name: "کیم کی دوک" }],
  ["از کارگردان فیلم Pieta یه چیزی بده", { director_of: "Pieta" }],
  ["یه فیلم از اسپیلبرگ بده که زیر دو ساعت باشه", { media_type: "movie", director_name: "اسپیلبرگ", max_runtime_minutes: 119 }],
  ["فانتزی باشه ولی شبیه ارباب حلقه‌ها نباشه", { genres: ["fantasy"], dissimilar_to: "ارباب حلقه‌ها" }],
  ["یه انیمه شبیه death nite", { genres: ["animation"], similar_to: "death nite" }],
  ["یه مینی‌سریال جنایی حداکثر ۶ قسمتی", { media_type: "tv", genres: ["crime"], max_episodes: 6, max_seasons: 1 }],
  ["فیلم معمایی کره‌ای بعد از ۲۰۱۰", { media_type: "movie", genres: ["mystery"], language: "ko", release_year_min: 2011 }],
  ["فیلم معمایی ولی ترسناک نباشه", { media_type: "movie", genres: ["mystery"], avoid_genres: ["horror"] }],
  ["یه فیلم با بازی Tom Hanks و دوبله فارسی", { media_type: "movie", unsupported: ["cast", "dub"] }],
  ["یه فیلم مثل Dark که پایان خوش داشته باشه", { media_type: "movie", similar_to: "Dark", unsupported: ["ending"] }],
  ["راستی قیمت دلار امروز چنده؟", { unrelated: true }],
  ["از نولان فیلمی می‌خوام که ترسناک نباشه و حداکثر ۹۰ دقیقه باشه", { media_type: "movie", director_name: "نولان", avoid_genres: ["horror"], max_runtime_minutes: 90 }],
  ["یه سریال شبیه Dark که دوبله داشته باشه", { media_type: "tv", similar_to: "Dark", unsupported: ["dub"] }],
  ["فیلمی با بازی لیلا حاتمی", { media_type: "movie", unsupported: ["cast"] }],
  ["یه فیلم کمدی که زیرنویس فارسی داشته باشه", { media_type: "movie", genres: ["comedy"], unsupported: ["subtitles"] }],
];
const normalize = value => {
  if (typeof value === "string") return value.normalize("NFKC").toLowerCase().replace(/‌/gu, " ").replace(/\s+/gu, " ").trim();
  if (Array.isArray(value)) return value.map(normalize).sort();
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
};

export default {
  async fetch(request, env) {
    const params = new URL(request.url).searchParams;
    const id = Number(params.get("model") ?? 0);
    const only = params.get("case");
    const batch = params.get("batch");
    if (request.method !== "POST" || !models[id]) return new Response(null, {status: 404});
    const results = [];
    for (const [index, [input, expected]] of cases.entries()) {
      if (only !== null && Number(only) !== index) continue;
      if (batch !== null && Math.floor(index / 4) !== Number(batch)) continue;
      try {
        const output = await env.AI.run(models[id], {
          messages: [{role: "system", content: instructions}, {role: "user", content: input}],
          max_tokens: 180, temperature: 0.1, chat_template_kwargs: {enable_thinking: false},
        });
        const raw = output.response ?? output.choices?.[0]?.message?.content;
        const actual = JSON.parse(raw?.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
        results.push({index, input, expected, actual, usage: output.usage,
          pass: JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))});
      } catch (error) {
        results.push({index, input, pass: false, error: String(error.message).slice(0, 250)});
      }
    }
    return Response.json({model: models[id], passed: results.filter(r => r.pass).length, results});
  },
};
