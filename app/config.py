import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "project")
    version: str = os.getenv("APP_VERSION", "0.1.0")
    environment: str = os.getenv("APP_ENV", "development")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
    ollama_url: str = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "gemma4:e4b").strip()
    # Ollama on this CPU-only box manages ~4 tokens/s, so give it room.
    ollama_timeout_seconds: float = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "300"))
    # Wikimedia (Wikidata, Wikipedia) rejects user agents without a contact URL.
    user_agent: str = os.getenv("USER_AGENT", "weekend-planner/0.1 (https://github.com/vikramDlearners/October_backend)")
    # Comma-separated origins allowed to call the API from a browser; "*" allows any.
    cors_origins: tuple[str, ...] = tuple(o.strip() for o in os.getenv("CORS_ORIGIN", "*").split(",") if o.strip())


settings = Settings()
