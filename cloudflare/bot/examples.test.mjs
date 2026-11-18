import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, parseReferenceReply } from "./parse.mjs";
import { resemblesExcluded } from "./catalog.mjs";

const cases = [
  ["از کارگردان کیم کی دوک میخوام", { media_type: "movie", director_name: "کیم کی دوک" }],
  ["از کارگردا کیم کی دوک میخوام", { media_type: "movie", director_name: "کیم کی دوک" }],
  ["از کارگردان فیلم pieta", { media_type: "movie", director_of: "pieta", director_reference_type: "movie" }],
  ["یه فیلم از کارگردان «Kim Ki-duk» معرفی کن", { media_type: "movie", director_name: "Kim Ki-duk" }],
  ["یه فیلم معمایی زیر دو ساعت", { media_type: "movie", genres: ["mystery"], max_runtime_minutes: 119 }],
  ["یه فیلم معمایی کمتر از ۱۲۰ دقیقه", { media_type: "movie", genres: ["mystery"], max_runtime_minutes: 119 }],
  ["یه کمدی سبک برای آخر هفته", { genres: ["comedy"], mood: "light" }],
  ["یه سریال با حداکثر ۶ قسمت", { media_type: "tv", max_episodes: 6 }],
  ["یه فیلم فانتزی بعد از ۲۰۱۰", { media_type: "movie", genres: ["fantasy"], release_year_min: 2011 }],
  ["یه فیلم معمایی بدون ترسناک", { media_type: "movie", genres: ["mystery"], avoid_genres: ["horror"] }],
  ["یه فیلم معمایی که ترسناک نباشه", { media_type: "movie", genres: ["mystery"], avoid_genres: ["horror"] }],
  ["یه سریال شبیه Dark", { media_type: "tv", similar_to: ["Dark"] }],
  ["یه انیمه شبیه death nite", { genres: ["animation"], similar_to: ["death nite"] }],
  ["یه انیمه شبیه scavenger's reign", { genres: ["animation"], similar_to: ["scavenger's reign"] }],
  ["یه فیلم شبیه into the wild میخوام", { media_type: "movie", similar_to: ["into the wild"] }],
  ["فیلم فانتزی که شبیه ارباب حلقه ها نباشه", { media_type: "movie", genres: ["fantasy"], dissimilar_to: "ارباب حلقه ها" }],
  ["یه فیلم فانتزی که مثل «ارباب حلقه‌ها» نباشد", { media_type: "movie", genres: ["fantasy"], dissimilar_to: "ارباب حلقه ها" }],
  ["یه فیلم فانتزی، نه شبیه The Lord of the Rings", { media_type: "movie", genres: ["fantasy"], dissimilar_to: "The Lord of the Rings" }],
  ["فیلم فانتزی مثل LOTR نمی‌خوام", { media_type: "movie", genres: ["fantasy"], dissimilar_to: "LOTR" }],
  ["یه فیلم فانتزی شبیه ارباب حلقه ها", { media_type: "movie", genres: ["fantasy"], similar_to: ["ارباب حلقه ها"] }],
  ["یه فیلم شبیه Into the Wild و نه مثل The Revenant", { media_type: "movie", similar_to: ["Into the Wild"], dissimilar_to: "The Revenant" }],
  ["یه فیلم شبیه Into the Wild ولی شبیه The Revenant نباشه", { media_type: "movie", similar_to: ["Into the Wild"], dissimilar_to: "The Revenant" }],
  ["یه فیلم بدون صحنه خشونت", null],
];
for (const [input, expected] of cases) test(input, () => assert.deepEqual(parse(input), expected));

test("پاسخ به سؤال رفع ابهام", () => {
  assert.deepEqual(parseReferenceReply("اونی که کارگردانش sean Penn است"), { director: "sean Penn" });
  assert.deepEqual(parseReferenceReply("نسخهٔ ۲۰۰۷"), { year: 2007 });
});

test("حذف مجموعه و شباهت مشخص، با حفظ آثار هم‌ژانر", () => {
  const excluded = { id: "ref", collection_id: 1, keywords: ["fantasy", "magic", "elves", "quest"] };
  assert.ok(resemblesExcluded({ id: "ref" }, excluded));
  assert.ok(resemblesExcluded({ id: "sequel", collection_id: 1 }, excluded));
  assert.ok(resemblesExcluded({ id: "similar", keywords: ["elves", "quest"] }, excluded));
  assert.equal(resemblesExcluded({ id: "different", keywords: ["fantasy", "magic"] }, excluded), false);
});
