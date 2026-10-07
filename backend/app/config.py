from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LIVEOPS_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://liveops:liveops@localhost:5432/liveops"
    # Fernet key (urlsafe base64, 32 bytes) used to encrypt source secrets at rest.
    secret_key: str = ""
    redis_url: str | None = None  # None = in-memory state store (single process)
    cors_origins: list[str] = ["http://localhost:5173"]
    start_runners: bool = True  # tests switch this off
    log_level: str = "INFO"
    data_dir: str = "./data"  # uploaded files for csv_file sources (one sub-folder per source)
    max_upload_mb: int = 50


@lru_cache
def get_settings() -> Settings:
    return Settings()
