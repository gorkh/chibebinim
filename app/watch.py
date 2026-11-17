from dataclasses import dataclass
from typing import Protocol


class WatchProvider(Protocol):
    def get_watch_url(self, media_type: str, provider_media_id: str | None = None) -> str: ...


@dataclass(frozen=True)
class CCloudHomeProvider:
    home_url: str = "https://ccloud.sbs/"

    def get_watch_url(self, media_type: str, provider_media_id: str | None = None) -> str:
        return self.home_url
