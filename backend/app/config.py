from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ---- Spotify OAuth ----
    spotify_client_id: str = ""
    spotify_client_secret: str = ""
    app_public_url: str = "https://local-ai-machine.local:6111"
    spotify_redirect_uri: str = "https://local-ai-machine.local:6111/api/oauth/redirect"
    spotify_scopes: str = "user-read-private,user-read-email,playlist-read-private,playlist-read-collaborative,playlist-modify-public,playlist-modify-private"

    # ---- Database ----
    database_url: str = "sqlite:///./spotify_tracker.db"

    # ---- Inference / hosted models (OpenAI-compatible HTTP endpoint) ----
    inference_base_url: str = "http://host.docker.internal:11434/v1"
    inference_api_key: str = ""
    inference_model: str = "llama3.1:8b"
    inference_timeout_seconds: float = 60.0
    semantic_confidence_threshold: float = 0.85

    # ---- App ----
    worker_concurrency: int = 4
    secret_key: str = "change-me-to-a-random-string"

    @property
    def scopes_list(self) -> list[str]:
        return [s.strip() for s in self.spotify_scopes.split(",") if s.strip()]

    @property
    def spotify_configured(self) -> bool:
        # The credential file (bind-mounted) is the source of truth; env values
        # are only a fallback for backwards compatibility.
        from .spotify.credentials import configured as _file_configured
        if _file_configured():
            return True
        return bool(self.spotify_client_id.strip() and self.spotify_client_secret.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
