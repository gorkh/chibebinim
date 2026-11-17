from html import escape

from aiogram.types import CopyTextButton, InlineKeyboardButton, InlineKeyboardMarkup

from app.domain import GENRES, QUICK_GENRES, Media
from app.service import Card
from app.watch import WatchProvider

HOME = "🏠 منوی اصلی"
TYPES = {"movie": "🎬 فیلم", "tv": "📺 سریال", "any": "🎲 فرقی نداره"}
CCLOUD_NOTICE = (
    "اسم فیلم یا سریال رو کپی کن و در CCloud جست‌وجو کن. ممکنه این عنوان اونجا موجود نباشه."
)
WELCOME = (
    "سلام! 👋\n\nمن کمکت می‌کنم متناسب با سلیقه و حال‌وهوات، "
    "یه فیلم یا سریال خوب پیدا کنی.\n\nامشب چی ببینیم؟ 🍿"
)
SMART = (
    "بهم بگو چه فیلم یا سریالی دوست داری.\n\n"
    "مثلاً:\n• یه فیلم معمایی زیر دو ساعت\n• یه کمدی سبک برای آخر هفته\n"
    "• یه سریال شبیه Dark\n\nهرچی دوست داری بنویس 👇"
)
HELP = (
    "با /recommend پیشنهاد بگیر، با /watchlist ذخیره‌هات رو ببین و با /profile "
    "سلیقه‌ات رو مرور کن. با /cancel هم هر مرحله‌ای رو می‌تونی لغو کنی.\n"
    "برای انتخاب هوشمند، نوع اثر و شرط‌هایی مثل ژانر یا مدت رو واضح بنویس.\n"
    "حریم خصوصی: /privacy"
)
EMPTY = "فعلاً پیشنهاد بیشتری با این شرایط پیدا نکردم. دوست داری ژانر یا محدودیت‌هات رو تغییر بدیم؟"
PRIVACY = (
    "شناسهٔ تلگرام، تاریخچهٔ پیشنهاد، بازخورد، فهرست تماشا و رویدادهای استفاده رو "
    "برای کارکرد ربات نگه می‌داریم. در حالت هوشمند آنلاین، متن درخواست برای تحلیل "
    "به سرویس AI تنظیم‌شده فرستاده می‌شه. متن خام درخواست در دیتابیس ربات ذخیره نمی‌شه.\n"
    "از تنظیمات می‌تونی داده‌های مرتبط با حسابت رو حذف کنی. داده‌های عمومی فیلم‌ها "
    "و آمار فنی بدون شناسهٔ کاربر باقی می‌مونن. نسخه‌های پشتیبان طبق سیاست گرداننده نگهداری می‌شن."
)


def fa(value: int | str | float) -> str:
    return str(value).translate(str.maketrans("0123456789.", "۰۱۲۳۴۵۶۷۸۹٫"))


def b(text: str, data: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=data)


def keyboard(*rows: list[InlineKeyboardButton]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=list(rows))


home = [b(HOME, "menu")]
menu = keyboard(
    [b("🎬 پیشنهاد سریع", "quick"), b("🧠 انتخاب هوشمند", "smart")],
    [b("🔖 لیست تماشای من", "list:0"), b("❤️ سلیقه من", "profile")],
    [b("⚙️ تنظیمات", "settings")],
)
choose = keyboard([b("🎬 پیشنهاد سریع", "quick"), b("🧠 انتخاب هوشمند", "smart")], home)
settings = keyboard(
    [b("تنظیم مجدد سلیقه", "reset"), b("حریم خصوصی", "privacy")],
    [b("حذف اطلاعات من", "erase")],
    home,
)

TMDB_CREDITS = (
    "منبع اطلاعات و تصاویر: The Movie Database\n"
    "This product uses the TMDB API but is not endorsed or certified by TMDB."
)
tmdb_links = keyboard(
    [InlineKeyboardButton(text="وب‌سایت TMDB", url="https://www.themoviedb.org/")], home
)


def types(nonce: str) -> InlineKeyboardMarkup:
    return keyboard(*([b(label, f"type:{nonce}:{kind}")] for kind, label in TYPES.items()), home)


def genre_options(nonce: str) -> InlineKeyboardMarkup:
    buttons = [b(GENRES[g], f"genre:{nonce}:{g}") for g in QUICK_GENRES]
    return keyboard(
        *(buttons[i : i + 2] for i in range(0, len(buttons), 2)),
        [b("🎲 سورپرایزم کن", f"genre:{nonce}:any")],
        home,
    )


def card_keys(card: Card, copy: bool, watch: WatchProvider, page: int = 0) -> InlineKeyboardMarkup:
    key = card.recommendation_id or card.media.id
    kind = "r" if card.recommendation_id else "w"
    destination = InlineKeyboardButton(
        text="🔎 برو به CCloud برای جست‌وجو", url=watch.get_watch_url(card.media.media_type)
    )
    rows = []
    if card.recommendation_id:
        rows = [
            [
                b("❤️ پسندیدم" + (" ✓" if card.preference == "liked" else ""), f"liked:{key}"),
                b(
                    "👎 نمی‌پسندم" + (" ✓" if card.preference == "disliked" else ""),
                    f"disliked:{key}",
                ),
            ],
            [
                b("✅ قبلاً دیدم" + (" ✓" if card.watched else ""), f"watched:{key}"),
                b("🔖 ذخیره شد" if card.saved else "🔖 ذخیره کن", f"save:{key}"),
            ],
            [b("🔄 پیشنهاد بعدی", f"next:{key}"), destination],
        ]
    else:
        rows = [
            [destination, b("حذف از لیست", f"remove:{key}:{page}")],
            [b("بازگشت به لیست", f"list:{page}")],
        ]
    title = card.media.title
    if copy and 0 < len(title) <= 256:
        rows.append(
            [
                InlineKeyboardButton(text="📋 کپی اسم فیلم", copy_text=CopyTextButton(text=title)),
                b("نمایش اسم برای کپی", f"copy:{kind}:{key}"),
            ]
        )
    else:
        rows.append([b("📋 کپی اسم فیلم", f"copy:{kind}:{key}")])
    return keyboard(*rows, home)


def label(media: Media) -> str:
    title = media.persian_title or media.title
    return f"{title[:85]} ({fa(media.year)})" if media.year else title[:85]


def format_card(card: Card, compact: bool = False) -> str:
    media = card.media
    mark = f"<b>\u2066{escape(media.title[:110])}\u2069</b>"
    if media.persian_title and media.persian_title != media.title:
        mark = f"<b>{escape(media.persian_title[:80])}</b>\n{mark}"
    if media.year:
        mark += f" ({fa(media.year)})"
    lines = [mark, TYPES[media.media_type]]
    if media.original_title != media.title:
        lines.append(f"عنوان اصلی: \u2068{escape(media.original_title[:80])}\u2069")
    if media.genres:
        lines.append("ژانر: " + "، ".join(GENRES[g] for g in media.genres[:8]))
    if media.runtime_minutes:
        lines.append(f"مدت: {fa(media.runtime_minutes)} دقیقه")
    if media.seasons_count or media.episodes_count:
        values = [
            f"{fa(n)} {unit}"
            for n, unit in ((media.seasons_count, "فصل"), (media.episodes_count, "قسمت"))
            if n
        ]
        lines.append("، ".join(values))
    if media.vote_average is not None and media.rating_source:
        lines.append(
            f"امتیاز \u2066{escape(media.rating_source)}\u2069: {fa(media.vote_average)} از ۱۰"
        )
    if overview := media.overview_fa or media.overview_en:
        limit = 230 if compact else 650
        preview = overview[:limit]
        if len(overview) > limit:
            preview = preview.rsplit(" ", 1)[0] + "…"
        lines.extend(["", f"\u2068{escape(preview)}\u2069"])
    if card.explanation:
        lines.extend(["", escape(card.explanation)])
    lines.extend(["", CCLOUD_NOTICE])
    return "\n".join(lines)
