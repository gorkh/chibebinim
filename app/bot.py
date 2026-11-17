import logging
import re
from collections import OrderedDict
from html import escape
from importlib.resources import files
from time import monotonic
from uuid import uuid4

from aiogram import BaseMiddleware, Dispatcher, F, Router
from aiogram.dispatcher.flags import get_flag
from aiogram.enums import ChatAction, ChatType
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage, SimpleEventIsolation
from aiogram.types import BufferedInputFile, CallbackQuery, ErrorEvent, Message, Update

from app import ui
from app.catalog import CatalogUnavailable
from app.domain import GENRES, QUICK_GENRES, Request
from app.parser import MAX_INPUT, NeedClarification
from app.service import Card, ChooseReference, ReferenceMissing, Service, StaleCard
from app.watch import WatchProvider

log = logging.getLogger(__name__)
RETRY = "الان مشکلی پیش اومد. یه کم بعد دوباره امتحان کن."
NO_CATALOG = "کاتالوگ موقتاً در دسترس نیست. یه کم بعد دوباره امتحان کن."
CLARIFY = "نتونستم همهٔ شرط‌هات رو دقیق دربیارم. ساده‌تر بنویس یا پیشنهاد سریع رو امتحان کن."
EXPIRED = "این دکمه قدیمی شده. از منو دوباره شروع کن."


class Flow(StatesGroup):
    media_type = State()
    genre = State()
    smart = State()
    reference = State()
    confirm = State()


class UserMiddleware(BaseMiddleware):
    def __init__(self):
        self.buckets: OrderedDict[int, tuple[float, float]] = OrderedDict()

    async def __call__(self, handler, event, data):
        message = event.message if isinstance(event, CallbackQuery) else event
        sender = event.from_user
        service: Service = data["service"]
        if not isinstance(message, Message) or message.chat.type != ChatType.PRIVATE or not sender:
            if isinstance(event, CallbackQuery):
                await event.answer("از گفت‌وگوی خصوصی ربات استفاده کن.")
            return
        if not 0 < sender.id < 2**52:
            return
        clock = monotonic()
        while self.buckets and clock - next(iter(self.buckets.values()))[0] > 60:
            self.buckets.popitem(last=False)
        last, capacity = self.buckets.get(sender.id, (clock, 8.0))
        capacity = min(8.0, capacity + (clock - last) * 1.0)
        if capacity < 1:
            if isinstance(event, CallbackQuery):
                await event.answer("یه لحظه صبر کن و دوباره بزن.")
            return
        self.buckets[sender.id] = (clock, capacity - 1)
        self.buckets.move_to_end(sender.id)
        if len(self.buckets) > 10000:
            self.buckets.popitem(last=False)
        mark_started = get_flag(data, "onboarding", default=False)
        if isinstance(event, CallbackQuery) and not await self._acknowledge(event):
            return
        data["uid"] = await service.user(
            sender.id, started=mark_started, register=not isinstance(event, CallbackQuery)
        )
        if data["uid"] is None:
            await message.answer("این دکمه قدیمی شده. برای شروع /start بزن.")
            return
        try:
            return await handler(event, data)
        except TelegramForbiddenError:
            await service.blocked(data["uid"])
            log.info("event=telegram_user_blocked")

    @staticmethod
    async def _acknowledge(event):
        try:
            await event.answer()
        except TelegramBadRequest:
            # A query Telegram no longer accepts should not perform a mutation.
            return False
        return True


def dispatcher(service: Service, watch: WatchProvider) -> Dispatcher:
    dp = Dispatcher(
        storage=MemoryStorage(),
        events_isolation=SimpleEventIsolation(),
        service=service,
        watch=watch,
    )
    router = Router()
    middleware = UserMiddleware()
    router.message.middleware(middleware)
    router.callback_query.middleware(middleware)

    async def render(message: Message, uid: int, card: Card | None, **kwargs):
        if card is None:
            await message.answer(ui.EMPTY, reply_markup=ui.choose)
            return
        keys = ui.card_keys(card, service.settings.telegram_native_copy, watch, **kwargs)
        if card.media.poster_path:
            try:
                await message.answer_photo(
                    card.media.poster_path,
                    caption=ui.format_card(card, True),
                    parse_mode="HTML",
                    reply_markup=keys,
                )
            except TelegramBadRequest:
                await message.answer(ui.format_card(card), parse_mode="HTML", reply_markup=keys)
        else:
            await message.answer(ui.format_card(card), parse_mode="HTML", reply_markup=keys)
        if card.recommendation_id:
            await service.event(uid, "recommendation_viewed")

    async def quick(message: Message, state: FSMContext, uid: int):
        nonce = uuid4().hex[:10]
        await state.set_data({"nonce": nonce})
        await state.set_state(Flow.media_type)
        await service.event(uid, "quick_recommendation_started")
        await message.answer("فیلم می‌خوای یا سریال؟", reply_markup=ui.types(nonce))

    async def show_watchlist(message: Message, uid: int, page=0):
        items, page, pages = await service.watchlist(uid, page)
        if not items:
            await message.answer(
                "هنوز فیلمی ذخیره نکردی. هر وقت یه پیشنهاد خوشت اومد، دکمه ذخیره رو بزن تا اینجا بمونه.",
                reply_markup=ui.keyboard([ui.b("🎬 پیدا کردن فیلم", "quick")], ui.home),
            )
            return
        lines, rows = ["این فیلم‌ها رو برای بعداً ذخیره کردی 🍿", ""], []
        for index, media in enumerate(items, 1):
            n = ui.fa(index)
            lines.append(f"{n}. \u2068{ui.label(media)}\u2069 — {ui.TYPES[media.media_type]}")
            rows.append(
                [
                    ui.b(f"{n}. جزئیات", f"detail:{media.id}:{page}"),
                    ui.b(f"{n}. حذف", f"remove:{media.id}:{page}"),
                ]
            )
        nav = []
        if page:
            nav.append(ui.b("قبلی", f"list:{page - 1}"))
        if page + 1 < pages:
            nav.append(ui.b("بعدی", f"list:{page + 1}"))
        if nav:
            lines.extend(["", f"صفحهٔ {ui.fa(page + 1)} از {ui.fa(pages)}"])
            rows.append(nav)
        await message.answer("\n".join(lines), reply_markup=ui.keyboard(*rows, ui.home))

    async def show_profile(message: Message, uid: int):
        genres, kinds, liked, watched, saved = await service.profile(uid)
        top = [GENRES[g] for g in sorted(genres, key=genres.get, reverse=True) if genres[g] > 0][:4]
        lines = [
            "❤️ سلیقهٔ من",
            f"پسندیده: {ui.fa(liked)} | دیده: {ui.fa(watched)} | ذخیره: {ui.fa(saved)}",
        ]
        if top:
            lines.append("ژانرهای محبوب: " + "، ".join(top))
        else:
            lines.append("هنوز خیلی با سلیقه‌ات آشنا نشدم. چند تا فیلم انتخاب کن تا بهتر بشناسمت.")
        if liked >= 2 and kinds.get("movie", 0) != kinds.get("tv", 0):
            lines.append("نوع محبوب: " + ui.TYPES[max(kinds, key=kinds.get)])
        await message.answer("\n".join(lines), reply_markup=ui.keyboard(ui.home))

    async def recommend(message, state, uid, request, mode, choices=None):
        await message.bot.send_chat_action(message.chat.id, ChatAction.TYPING)
        try:
            result = await service.start(uid, request, mode, choices)
        except ReferenceMissing:
            await state.clear()
            await state.set_state(Flow.smart)
            await message.answer(
                "عنوان مرجع رو پیدا نکردم. اسم و سالش رو دوباره بنویس.", reply_markup=ui.choose
            )
            return
        except CatalogUnavailable:
            await state.clear()
            await message.answer(NO_CATALOG, reply_markup=ui.choose)
            return
        if isinstance(result, ChooseReference):
            nonce = uuid4().hex[:10]
            await state.set_state(Flow.reference)
            await state.set_data(
                dict(
                    nonce=nonce,
                    request=request.model_dump(),
                    mode=mode,
                    choices=choices or {},
                    title=result.title,
                    options=[m.id for m in result.options],
                )
            )
            rows = [
                [ui.b(ui.label(m) + " · " + ui.TYPES[m.media_type], f"ref:{nonce}:{i}")]
                for i, m in enumerate(result.options)
            ]
            await message.answer("منظورت کدوم عنوانه؟", reply_markup=ui.keyboard(*rows, ui.home))
            return
        await state.clear()
        await render(message, uid, result)

    @router.message(CommandStart(), flags={"onboarding": True})
    async def start(message: Message, state: FSMContext):
        await state.clear()
        await message.answer(ui.WELCOME, reply_markup=ui.menu)

    @router.message(Command("menu", "cancel"))
    async def main_menu(message: Message, state: FSMContext):
        await state.clear()
        await message.answer("امشب چی ببینیم؟ 🍿", reply_markup=ui.menu)

    @router.message(Command("recommend"))
    async def recommend_command(message: Message, state: FSMContext, uid: int):
        await quick(message, state, uid)

    @router.message(Command("watchlist"))
    async def watchlist_command(message: Message, state: FSMContext, uid: int):
        await state.clear()
        await show_watchlist(message, uid)

    @router.message(Command("profile"))
    async def profile_command(message: Message, state: FSMContext, uid: int):
        await state.clear()
        await show_profile(message, uid)

    @router.message(Command("help", "privacy"))
    async def info(message: Message):
        cmd = message.text.split()[0].split("@")[0]
        rows = [ui.home]
        if cmd == "/help" and service.settings.catalog_provider == "tmdb":
            rows.insert(0, [ui.b("منبع اطلاعات", "credits")])
        await message.answer(
            ui.HELP if cmd == "/help" else ui.PRIVACY, reply_markup=ui.keyboard(*rows)
        )

    @router.message(Flow.smart, F.text, ~F.text.startswith("/"))
    async def smart_text(message: Message, state: FSMContext, uid: int):
        description = message.text.strip()
        if len(description) > MAX_INPUT:
            await message.answer(f"درخواستت رو در حداکثر {ui.fa(MAX_INPUT)} نویسه بنویس.")
            return
        if len(description) < 3:
            await message.answer(CLARIFY, reply_markup=ui.choose)
            return
        await message.bot.send_chat_action(message.chat.id, ChatAction.TYPING)
        try:
            request = await service.interpret(uid, description)
        except NeedClarification:
            await message.answer(CLARIFY, reply_markup=ui.choose)
            return
        await recommend(message, state, uid, request, "smart")

    @router.message()
    async def unexpected(message: Message, state: FSMContext):
        current = await state.get_state()
        if current == Flow.smart.state:
            await message.answer("خواسته‌ات رو با متن بفرست یا /cancel بزن.")
        elif current:
            await message.answer("یکی از دکمه‌های مرحلهٔ فعلی رو بزن، یا با /cancel برگرد.")
        else:
            await message.answer(
                "از منو یکی از مسیرهای پیشنهاد رو انتخاب کن.", reply_markup=ui.menu
            )

    @router.callback_query()
    async def action(query: CallbackQuery, state: FSMContext, uid: int):
        msg, raw = query.message, query.data or ""
        if not isinstance(msg, Message) or not re.fullmatch(r"[a-z0-9_:]{1,64}", raw):
            return
        cmd, *parts = raw.split(":")
        progress = await state.get_data()
        current = await state.get_state()
        try:
            if cmd == "credits" and not parts and service.settings.catalog_provider == "tmdb":
                url = service.settings.tmdb_logo_url
                logo = (
                    str(url)
                    if url
                    else BufferedInputFile(
                        files("app").joinpath("tmdb-logo.png").read_bytes(),
                        filename="tmdb-logo.png",
                    )
                )
                try:
                    await msg.answer_photo(
                        logo, caption=ui.TMDB_CREDITS, reply_markup=ui.tmdb_links
                    )
                except TelegramBadRequest:
                    await msg.answer(ui.TMDB_CREDITS, reply_markup=ui.tmdb_links)
                return
            if not parts and cmd in {
                "menu",
                "quick",
                "smart",
                "profile",
                "settings",
                "privacy",
                "reset",
                "erase",
            }:
                await state.clear()
                if cmd == "menu":
                    await msg.answer("امشب چی ببینیم؟ 🍿", reply_markup=ui.menu)
                elif cmd == "quick":
                    await quick(msg, state, uid)
                elif cmd == "smart":
                    await state.set_state(Flow.smart)
                    await service.event(uid, "smart_recommendation_started")
                    await msg.answer(ui.SMART, reply_markup=ui.keyboard(ui.home))
                elif cmd == "profile":
                    await show_profile(msg, uid)
                elif cmd == "settings":
                    await msg.answer("تنظیمات", reply_markup=ui.settings)
                elif cmd == "privacy":
                    await msg.answer(ui.PRIVACY, reply_markup=ui.settings)
                else:
                    nonce = uuid4().hex[:12]
                    await state.set_state(Flow.confirm)
                    await state.set_data(dict(nonce=nonce, action=cmd))
                    question = (
                        "همهٔ اطلاعات حساب، تاریخچه و فهرست تماشا حذف بشه؟"
                        if cmd == "erase"
                        else "لایک و دیسلایک و سلیقه پاک بشه؟ فهرست و دیده‌ها می‌مونن."
                    )
                    await msg.answer(
                        question,
                        reply_markup=ui.keyboard(
                            [ui.b("تأیید می‌کنم", f"confirm:{nonce}"), ui.b("لغو", "settings")]
                        ),
                    )
                return

            if (cmd, len(parts)) in {("type", 2), ("genre", 2), ("ref", 2), ("confirm", 1)}:
                expected = {
                    "type": Flow.media_type,
                    "genre": Flow.genre,
                    "ref": Flow.reference,
                    "confirm": Flow.confirm,
                }[cmd]
                if current != expected.state or parts[0] != progress.get("nonce"):
                    raise StaleCard
                if cmd == "confirm":
                    await state.clear()
                    if progress["action"] == "erase":
                        await service.delete_user(uid)
                        await msg.answer("اطلاعات حساب پاک شد. برای شروع دوباره /start بزن.")
                    else:
                        await service.reset_taste(uid)
                        await msg.answer("سلیقه از نو تنظیم شد.", reply_markup=ui.menu)
                    return
                arg = parts[1]
                if cmd == "type" and arg in ui.TYPES:
                    nonce = uuid4().hex[:10]
                    await state.set_data(
                        dict(nonce=nonce, media_type=None if arg == "any" else arg)
                    )
                    await state.set_state(Flow.genre)
                    await msg.answer(
                        "امشب چه ژانری دوست داری؟", reply_markup=ui.genre_options(nonce)
                    )
                    return
                if cmd == "genre" and arg in [*QUICK_GENRES, "any"]:
                    await recommend(
                        msg,
                        state,
                        uid,
                        Request(
                            media_type=progress["media_type"], genres=[] if arg == "any" else [arg]
                        ),
                        "quick",
                    )
                    return
                if cmd == "ref" and arg.isdigit() and int(arg) < len(progress["options"]):
                    choices = {
                        **progress["choices"],
                        progress["title"]: progress["options"][int(arg)],
                    }
                    await recommend(
                        msg,
                        state,
                        uid,
                        Request.model_validate(progress["request"]),
                        progress["mode"],
                        choices,
                    )
                    return
                raise StaleCard

            def mid(token: str) -> bool:
                return bool(re.fullmatch(r"[a-f0-9]{32}", token))

            if cmd == "list" and len(parts) == 1 and parts[0].isdigit():
                await state.clear()
                await show_watchlist(msg, uid, int(parts[0]))
            elif (
                cmd in {"remove", "detail"}
                and len(parts) == 2
                and mid(parts[0])
                and parts[1].isdigit()
            ):
                page = int(parts[1])
                if cmd == "remove":
                    await service.remove_watch(uid, parts[0])
                    await show_watchlist(msg, uid, page)
                else:
                    await render(msg, uid, await service.card(uid, parts[0], True), page=page)
            elif (
                cmd in {"next", "liked", "disliked", "watched", "save"}
                and len(parts) == 1
                and mid(parts[0])
            ):
                if cmd == "next":
                    await render(msg, uid, await service.next(uid, parts[0]))
                else:
                    card = await service.feedback(uid, parts[0], cmd)
                    keys = ui.card_keys(card, service.settings.telegram_native_copy, watch)
                    try:
                        await msg.edit_reply_markup(reply_markup=keys)
                    except TelegramBadRequest:
                        # Markup may already match on repeated taps.
                        pass
            elif cmd == "copy" and len(parts) == 2 and parts[0] in {"r", "w"} and mid(parts[1]):
                card = await service.card(uid, parts[1], parts[0] == "w")
                await msg.answer(f"<code>{escape(card.media.title)}</code>", parse_mode="HTML")
                await service.event(uid, "title_copy_requested", method="message")
            else:
                raise StaleCard
        except StaleCard:
            await msg.answer(EXPIRED, reply_markup=ui.choose)

    @dp.errors()
    async def on_error(event: ErrorEvent):
        log.error("event=update_failed exception=%s", type(event.exception).__name__)
        update: Update = event.update
        msg = update.message or (update.callback_query and update.callback_query.message)
        if isinstance(msg, Message):
            try:
                await msg.answer(RETRY, reply_markup=ui.choose)
            except Exception as error:
                log.warning("event=error_notice_failed exception=%s", type(error).__name__)
        return True

    dp.include_router(router)
    return dp
