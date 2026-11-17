from datetime import UTC, datetime
from itertools import count

from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import (
    AnswerCallbackQuery,
    EditMessageReplyMarkup,
    SendChatAction,
    SendMessage,
    SendPhoto,
)
from aiogram.types import CallbackQuery, Chat, Message, Update, User

from app.bot import dispatcher
from app.watch import CCloudHomeProvider


class TelegramStub(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.ids = count(100)

    async def close(self):
        pass

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        if isinstance(method, (SendMessage, SendPhoto)):
            return Message(
                message_id=next(self.ids),
                date=datetime.now(UTC),
                chat=Chat(id=method.chat_id, type="private"),
                text=getattr(method, "text", None),
                caption=getattr(method, "caption", None),
                reply_markup=method.reply_markup,
            )
        assert isinstance(method, (SendChatAction, EditMessageReplyMarkup, AnswerCallbackQuery))
        return True

    async def stream_content(self, *args, **kwargs):
        if False:
            yield b""

    @property
    def last_message(self):
        return next(call for call in reversed(self.calls) if isinstance(call, SendMessage))


def button(message, prefix):
    return next(
        b
        for row in message.reply_markup.inline_keyboard
        for b in row
        if b.callback_data and b.callback_data.startswith(prefix)
    ).callback_data


async def test_telegram_flows(service, monkeypatch):
    updates, clock = count(1), count(1)
    monkeypatch.setattr("app.bot.monotonic", lambda: next(clock))
    tg = TelegramStub()
    bot = Bot("42:TEST_NOT_A_CREDENTIAL", session=tg)
    dp = dispatcher(service, CCloudHomeProvider())
    # Let unexpected application errors fail the test with their original traceback.
    dp.errors.handlers.clear()

    def message(num, user, text=None):
        return Message(
            message_id=num,
            date=datetime.now(UTC),
            chat=Chat(id=user.id, type="private"),
            from_user=user,
            text=text,
        )

    async def feed(text=None, callback=None, who=900):
        num = next(updates)
        user = User(id=who, is_bot=False, first_name="آزمایش")
        if callback is not None:
            value = Update(
                update_id=num,
                callback_query=CallbackQuery(
                    id=str(num),
                    from_user=user,
                    chat_instance=str(who),
                    data=callback,
                    message=message(num, user),
                ),
            )
        else:
            value = Update(update_id=num, message=message(num, user, text))
        await dp.feed_update(bot, value)
        return tg.last_message

    try:
        await feed("/start", who=901)
        start = await feed("/start")
        assert "امشب چی ببینیم" in start.text
        kind = await feed(callback=button(start, "quick"))
        genre = await feed(callback=button(kind, "type:")[:-5] + "movie")
        comedy = next(
            b.callback_data
            for row in genre.reply_markup.inline_keyboard
            for b in row
            if b.callback_data.endswith(":comedy")
        )
        card = await feed(callback=comedy)
        assert "کمدی" in card.text
        copy = next(
            b.copy_text for row in card.reply_markup.inline_keyboard for b in row if b.copy_text
        )
        assert copy.text in card.text
        copied = await feed(callback=button(card, "copy:"))
        assert copied.text == f"<code>{copy.text}</code>"
        link = next(b.url for row in card.reply_markup.inline_keyboard for b in row if b.url)
        assert link == "https://ccloud.sbs/"
        assert "در CCloud جست‌وجو کن" in card.text
        await feed(callback=button(card, "save:"))
        saved = await feed("/watchlist")
        assert "ذخیره کردی" in saved.text
        wrong = await feed(callback=button(card, "liked:"), who=901)
        assert "قدیمی" in wrong.text
        following = await feed(callback=button(card, "next:"))
        assert following.text != card.text and "کمدی" in following.text
        stale = await feed(callback=button(card, "next:"))
        assert "قدیمی" in stale.text

        await feed(callback="smart")
        smart = await feed("یه فیلم هیجان‌انگیز زیر دو ساعت")
        assert "هیجان‌انگیز" in smart.text and "دقیقه" in smart.text
        await feed(callback="erase")
        confirmation = button(tg.last_message, "confirm:")
        erased = await feed(callback=confirmation)
        assert "پاک شد" in erased.text
        stale = await feed(callback=confirmation)
        assert "قدیمی" in stale.text
        assert await service.user(900, register=False) is None
    finally:
        await dp.fsm.storage.close()
        await dp.fsm.events_isolation.close()
        await bot.session.close()
