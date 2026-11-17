FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /opt/bot
COPY pyproject.toml alembic.ini ./
COPY app ./app
COPY migrations ./migrations
RUN pip install . && groupadd --system bot && useradd --system --gid bot --no-create-home bot \
    && mkdir -p /opt/bot/data && chown bot:bot /opt/bot/data
USER bot
CMD ["sh", "-c", "alembic upgrade head && exec python -m app.main"]
