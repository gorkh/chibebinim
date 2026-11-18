import labels from "./labels.json" with { type: "json" };
import { year } from "./catalog.mjs";

export const { genres, quick, ui } = labels;
export const button = (text, callback_data) => ({ text, callback_data });
export const home = [button(ui.HOME, "menu")];
export const ccloudDownload = [{text:"⬇️ سایت دانلود CCloud",url:"https://ccloud.sbs/"}];
export const options = [button("🎬 پیشنهاد سریع", "quick"), button("🧠 انتخاب هوشمند", "smart")];
export const menu = [
  options, [button("🔖 لیست تماشای من", "list:0"), button("❤️ سلیقه من", "profile")],
  [button("⚙️ تنظیمات", "settings")],
];
export const settings = [
  [button("تنظیم مجدد سلیقه", "reset"), button("حریم خصوصی", "privacy")],
  [button("حذف اطلاعات من", "erase")], home,
];
export const expired = "این دکمه دیگه فعال نیست. دوباره از منو شروع کن.";
export const clarify = "نتونستم همهٔ شرط‌هات رو دقیق دربیارم. ساده‌تر بنویس یا پیشنهاد سریع رو امتحان کن.";
export const unavailable = "کاتالوگ موقتاً در دسترس نیست. کمی بعد دوباره امتحان کن.";
export const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
export const fa = (x) => String(x).replace(/[0-9.]/g, char => char === "." ? "٫" : "۰۱۲۳۴۵۶۷۸۹"[Number(char)]);
export const mediaLabel = (m) => `${m.persian_title || m.title}${year(m) ? ` (${fa(year(m))})` : ""}`;
export function referenceLabel(media) {
  const kind = media.genres.includes("animation")
    ? (media.media_type === "movie" ? "انیمیشن سینمایی" : "سریال انیمیشنی")
    : (media.media_type === "movie" ? "فیلم" : "سریال");
  return `${mediaLabel(media).slice(0, 42)} · ${kind}`;
}

export function cardButtons(media, rec, status, page = 0) {
  const key = rec ?? media.id;
  const kind = rec ? "r" : "w";
  const ccloud = button("راهنمای تماشا در CCloud", "ccloud_help");
  const rows = rec ? [
    [button("❤️ پسندیدم" + (status.preference === "liked" ? " ✓" : ""), `liked:${key}`),
      button("👎 نمی‌پسندم" + (status.preference === "disliked" ? " ✓" : ""), `disliked:${key}`)],
    [button("✅ قبلاً دیدم" + (status.is_watched ? " ✓" : ""), `watched:${key}`),
      button(status.saved ? "🔖 ذخیره شد" : "🔖 ذخیره کن", `save:${key}`)],
    [button("🔄 پیشنهاد بعدی", `next:${key}`), ccloud],
  ] : [
    [ccloud, button("حذف از لیست", `remove:${key}:${page}`)],
    [button("بازگشت به لیست", `list:${page}`)],
  ];
  const copy = button("نمایش اسم برای کپی", `copy:${kind}:${key}`);
  rows.push(media.title.length <= 256 ? [
    { text: "📋 کپی اسم فیلم", copy_text: { text: media.title } }, copy,
  ] : [copy], home);
  return rows;
}

export function cardText(media, explanation) {
  const title = `<b>${escape(mediaLabel(media).slice(0, 220))}</b>`;
  const lines = [title];
  if (media.persian_title && media.persian_title !== media.title) lines.push(escape(media.title.slice(0, 100)));
  if (media.genres.length) lines.push(`ژانر: ${media.genres.map(g => genres[g]).filter(Boolean).join("، ")}`);
  if (media.runtime_minutes) lines.push(`مدت: ${fa(media.runtime_minutes)} دقیقه`);
  if (media.vote_average != null) lines.push(`امتیاز ${escape(media.rating_source || "TMDB")}: ${fa(media.vote_average)}`);
  const summary = media.overview_fa || media.overview_en;
  if (summary) lines.push(escape(summary.slice(0, 360)));
  if (explanation) lines.push(escape(explanation.slice(0, 150)));
  lines.push(ui.CCLOUD_NOTICE);
  return lines.join("\n\n");
}
