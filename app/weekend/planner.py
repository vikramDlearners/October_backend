"""Gathers everything about one weekend (weather, places, news) and asks for a recommendation."""

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, field

import httpx

from app.config import settings
from app.weekend.recommend import recommend
from app.weekend.sources import Location, local_news, nearby_places, search_radius_km, weekend_weather

OPENING_QUESTION = "What should I do this weekend? Let's find out. Where are you? (a city or area, or 'lat,lon')"
DURATION_QUESTION = "How much time do you have, including travel? (e.g. 3 hours, half day, full day, whole weekend)"

_WORD_NUMBERS = {"one": 1, "a": 1, "an": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "eight": 8, "ten": 10, "twelve": 12}


def parse_duration(text: str) -> tuple[str, float] | None:
    """Free text to (label, hours). Hours include travel, and drive how far away we look."""
    t = text.lower().strip()
    if re.search(r"\b(whole|entire|full|both)\s+(weekend|days)\b|^weekend$|\bovernight\b", t):
        return "the whole weekend", 36
    if re.search(r"\bhalf\s+(a\s+)?day\b", t):
        return "half a day", 4
    if re.search(r"\b(full|whole|entire)\s+day\b|\bday\s*trip\b", t):
        return "a full day", 9
    if match := re.search(r"(\d+(?:\.\d+)?|\b[a-z]+\b)\s*(hours?|hrs?|h|days?|d)\b", t):
        amount = _WORD_NUMBERS.get(match[1]) if not match[1][0].isdigit() else float(match[1])
        if amount:
            if match[2].startswith("d"):
                return (f"{amount:g} day{'s' if amount != 1 else ''}", 9 if amount <= 1 else 36)
            if 0 < amount <= 72:
                return f"{amount:g} hour{'s' if amount != 1 else ''}", float(amount)
    return None


def http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=20, headers={"user-agent": settings.user_agent}, follow_redirects=True)


async def plan_weekend(client: httpx.AsyncClient, loc: Location, duration: str, hours: float) -> dict:
    radius = search_radius_km(hours)
    weather, places, news = await asyncio.gather(
        weekend_weather(client, loc),
        nearby_places(client, loc, radius),
        local_news(client, loc),
    )
    return {
        "location": {"name": loc.name, "region": loc.region, "lat": loc.lat, "lon": loc.lon},
        "duration": duration,
        "hours": hours,
        "radius_km": radius,
        "weather": weather,
        "places": places,
        "news": news,
        "recommendation": await recommend(client, loc, duration, hours, weather, places, news),
    }


def summarize(plan: dict) -> str:
    rec = plan["recommendation"]
    if not rec["place"]:
        return rec["why"]
    place = rec["place"]
    lines = [f"Go to {place['name']} ({place['distance_km']} km away) on {rec['day']}" + (f", {rec['when']}." if rec["when"] else ".")]
    lines.append(rec["why"])
    lines += [f"• {step}" for step in rec["plan"]]
    if rec["bring"]:
        lines.append("Bring: " + ", ".join(rec["bring"]))
    lines += [f"📰 {note}" for note in rec["news_notes"]]
    if rec["backups"]:
        lines.append("Or: " + "; ".join(f"{b['name']} ({b['why']})" for b in rec["backups"]))
    return "\n".join(lines)


@dataclass
class Session:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    stage: str = "location"  # location -> duration -> done
    location: Location | None = None
    plan: dict | None = None
    touched: float = field(default_factory=time.monotonic)


class SessionStore:
    """In-memory, so conversations reset when the server restarts."""

    def __init__(self, ttl_seconds: int = 3600, max_sessions: int = 1000):
        self._sessions: dict[str, Session] = {}
        self._ttl = ttl_seconds
        self._max = max_sessions

    def get(self, session_id: str | None) -> Session | None:
        self._expire()
        session = self._sessions.get(session_id or "")
        if session:
            session.touched = time.monotonic()
        return session

    def create(self) -> Session:
        self._expire()
        if len(self._sessions) >= self._max:
            oldest = min(self._sessions.values(), key=lambda s: s.touched)
            del self._sessions[oldest.id]
        session = Session()
        self._sessions[session.id] = session
        return session

    def _expire(self) -> None:
        cutoff = time.monotonic() - self._ttl
        for sid in [sid for sid, s in self._sessions.items() if s.touched < cutoff]:
            del self._sessions[sid]


sessions = SessionStore()
