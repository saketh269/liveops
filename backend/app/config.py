from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LIVEOPS_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://liveops:liveops@localhost:5432/liveops"
    # Fernet key (urlsafe base64, 32 bytes) used to encrypt source secrets at rest.
    secret_key: str = ""
    redis_url: str | None = None  # None = in-memory state store (single process)
    redis_key_prefix: str = "liveops"  # all Redis keys start with this (no { or })
    redis_max_connections: int = 200  # per backend process; callers wait when all are busy
    cors_origins: list[str] = ["http://localhost:5173"]
    # Host names the portal answers to (Host header and WebSocket Origin). Add
    # your server's name here if you deliberately serve it beyond this machine.
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "[::1]", "backend", "testserver"]
    start_runners: bool = True  # tests switch this off
    log_level: str = "INFO"
    data_dir: str = "./data"  # uploaded files for csv_file sources (one sub-folder per source)
    max_upload_mb: int = 50
    # s3_files sources may use the server's own AWS credentials (instance role,
    # env vars) only if this is true AND the source opts in. Default: never.
    s3_allow_instance_role: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
