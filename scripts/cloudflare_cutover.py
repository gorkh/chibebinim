"""Import a final SQLite snapshot and switch Telegram to the production Worker."""

import json
import os
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

from app.config import Settings
from scripts.prepare_cloudflare_data import TABLES, dump, snapshot, verify

URL = "https://chibebin-bot.raeimohsen.workers.dev/telegram"
ACCOUNT = "96d457217004fa677125bffb5f8605a7"
CONFIG = "cloudflare/bot/wrangler.jsonc"


def telegram(method, token, **values):
    request = Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(values).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=12) as response:
        body = json.load(response)
    if not body.get("ok"):
        raise RuntimeError("Telegram operation rejected")
    return body["result"]


def d1(*arguments):
    request = [
        "npx.cmd",
        "--offline",
        "wrangler",
        "d1",
        "execute",
        "BOT_DB",
        "--remote",
        "--config",
        CONFIG,
        "--json",
        *arguments,
    ]
    env = os.environ | {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "WRANGLER_SEND_METRICS": "false"}
    result = subprocess.run(request, env=env, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError("D1 operation rejected")
    if "--file" in arguments:
        # Wrangler mixes human progress lines with JSON for remote imports.
        return None
    return json.loads(result.stdout)


def count_d1():
    query = "SELECT " + ", ".join(f"(SELECT count(*) FROM {table}) AS {table}" for table in TABLES)
    result = d1("--command", query)
    return result[0]["results"][0]


def run():
    token = dotenv_values(".env").get("TELEGRAM_BOT_TOKEN")
    secret = json.loads(Path("data/cloudflare-bot-webhook.json").read_text())["WEBHOOK_SECRET"]
    if not token or not secret:
        raise RuntimeError("Missing cutover configuration")
    webhook = telegram("getWebhookInfo", token)
    if webhook.get("url"):
        raise RuntimeError("There is already a Telegram webhook")
    imported_counts = count_d1()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    destination = Path("data") / f"cloudflare-cutover-{stamp}"
    destination.mkdir()
    backup, upload = destination / "bot-snapshot.db", destination / "d1-import.sql"
    source = Path(make_url(Settings().database_url).database)
    snapshot(source, backup)
    with sqlite3.connect(backup) as db:
        counts = dump(db, upload)
        verify(db, upload, counts)
    previous = os.environ.get("CHIBEBIN_PREVIOUS_IMPORT")
    if any(imported_counts.values()):
        if (
            not previous
            or Path(previous).name != previous
            or not previous.startswith("cloudflare-cutover-")
        ):
            raise RuntimeError("Production D1 is not empty")
        previous_sql = Path("data") / previous / "d1-import.sql"
        if imported_counts != counts or previous_sql.read_bytes() != upload.read_bytes():
            raise RuntimeError("The previously imported snapshot differs from the final snapshot")
    else:
        d1("--file", str(upload))
    if count_d1() != counts:
        raise RuntimeError("Imported row counts do not match the local snapshot")
    print(json.dumps({"data_import_verified": True, "row_counts": counts}), flush=True)
    try:
        telegram(
            "setWebhook",
            token,
            url=URL,
            secret_token=secret,
            drop_pending_updates=False,
            allowed_updates=["message", "callback_query"],
            max_connections=12,
        )
        info = telegram("getWebhookInfo", token)
        if info.get("url") != URL:
            raise RuntimeError("Webhook could not be verified")
    except Exception:
        info = telegram("getWebhookInfo", token)
        if info.get("url") == URL:
            telegram("deleteWebhook", token, drop_pending_updates=False)
        raise
    print(json.dumps({"webhook_verified": True, "pending_updates": info["pending_update_count"]}))


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        raise SystemExit(f"Cutover failed: {type(error).__name__}") from None
