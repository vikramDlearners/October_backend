"""Turns location, duration, weather, places and news into one recommendation: Gemini, then Ollama, then simple rules."""

import json
import logging

import httpx

from app.config import settings
from app.weekend.sources import Location, is_indoor, is_rainy

log = logging.getLogger(__name__)

SCHEMA = {
    "type": "object",
    "properties": {
        "place": {"type": "string", "description": "Exact name of one candidate place"},
        "day": {"type": "string", "description": "YYYY-MM-DD, one of the weekend days"},
        "when": {"type": "string", "description": "Time window, e.g. 07:00-11:00"},
        "why": {"type": "string"},
        "plan": {"type": "array", "items": {"type": "string"}},
        "bring": {"type": "array", "items": {"type": "string"}},
        "news_notes": {"type": "array", "items": {"type": "string"}},
        "backups": {
            "type": "array",
            "items": {"type": "object", "properties": {"name": {"type": "string"}, "why": {"type": "string"}}, "required": ["name", "why"]},
        },
    },
    "required": ["place", "day", "when", "why", "plan", "bring", "news_notes", "backups"],
}


def build_prompt(loc: Location, duration: str, hours: float, weather: list[dict], places: list[dict], news: list[dict]) -> str:
    compact_places = [
        {k: v for k, v in p.items() if k in ("name", "kind", "distance_km", "description") and v}
        for p in places
    ]
    headlines = [f"{n['title']} ({n['published'] or 'recent'})" for n in news]
    return f"""You help someone decide what to do this weekend. Recommend exactly ONE place near them.

They are in: {loc.label}
Time they have: {duration} (about {hours:g} hours, including travel)

Weekend weather at their location:
{json.dumps(weather)}

Candidate places nearby (distance from them in km):
{json.dumps(compact_places, ensure_ascii=False)}

Local news from the last week:
{json.dumps(headlines, ensure_ascii=False) if headlines else "none found"}

Rules:
- "place" must be the exact name of one candidate. Travel there and back must fit in the time they have.
- Pick the weekend day and time window with the best weather for that place; prefer indoor places if both days are rainy, and avoid midday heat above 33°C for outdoor places.
- "plan" is 3-5 short timed steps, starting from leaving home.
- "news_notes": only headlines that matter for this trip (festivals, closures, traffic, protests, weather warnings). Empty if none.
- "backups": two other candidates with one-line reasons.
- Keep every string short and concrete.

Reply with JSON only."""


async def recommend(client: httpx.AsyncClient, loc: Location, duration: str, hours: float, weather: list[dict], places: list[dict], news: list[dict]) -> dict:
    if not places:
        return _rules(weather, places, "rules (no places found nearby)")
    prompt = build_prompt(loc, duration, hours, weather, places, news)
    attempts = []
    if settings.gemini_api_key:
        attempts.append((settings.gemini_model, _ask_gemini))
    attempts.append((f"{settings.ollama_model} (Ollama)", _ask_ollama))
    failures = []
    for label, ask in attempts:
        try:
            result = _validate(await ask(client, prompt), weather, places)
            result["decided_by"] = label
            return result
        except Exception as exc:  # any model failure falls through to the next option
            log.warning("%s failed: %s", label, exc)
            failures.append(label.split(" ")[0])
    return _rules(weather, places, f"rules ({', '.join(failures)} unavailable)")


async def _ask_gemini(client: httpx.AsyncClient, prompt: str) -> dict:
    resp = await client.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent",
        headers={"x-goog-api-key": settings.gemini_api_key},
        json={
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json", "responseSchema": SCHEMA},
        },
        timeout=90,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini returned {resp.status_code}: {resp.text[:200]}")
    parts = resp.json()["candidates"][0]["content"]["parts"]
    return _parse("".join(p.get("text", "") for p in parts if not p.get("thought")))


async def _ask_ollama(client: httpx.AsyncClient, prompt: str) -> dict:
    resp = await client.post(
        f"{settings.ollama_url}/api/generate",
        json={
            "model": settings.ollama_model,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "format": SCHEMA,
            "options": {"temperature": 0.4, "num_predict": 600},
        },
        timeout=settings.ollama_timeout_seconds,
    )
    resp.raise_for_status()
    return _parse(resp.json()["response"])


def _parse(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start : end + 1])


def _find_place(name: str, places: list[dict]) -> dict | None:
    wanted = name.strip().lower()
    for place in places:
        candidate = place["name"].lower()
        if candidate == wanted or candidate in wanted or wanted in candidate:
            return place
    return None


def _validate(reply: dict, weather: list[dict], places: list[dict]) -> dict:
    place = _find_place(str(reply.get("place", "")), places)
    if place is None:
        raise ValueError(f"recommended place {reply.get('place')!r} is not a candidate")
    days = {d["date"] for d in weather}
    day = reply.get("day") if reply.get("day") in days else (weather[0]["date"] if weather else None)
    return {
        "place": _place_out(place),
        "day": day,
        "when": str(reply.get("when", "")),
        "why": str(reply.get("why", "")),
        "plan": [str(s) for s in reply.get("plan", [])][:6],
        "bring": [str(s) for s in reply.get("bring", [])][:6],
        "news_notes": [str(s) for s in reply.get("news_notes", [])][:5],
        "backups": [
            {"name": str(b.get("name", "")), "why": str(b.get("why", ""))}
            for b in reply.get("backups", [])
            if isinstance(b, dict)
        ][:3],
    }


def _place_out(place: dict) -> dict:
    return {
        "name": place["name"],
        "kind": place["kind"],
        "distance_km": place["distance_km"],
        "lat": place["lat"],
        "lon": place["lon"],
        "maps_url": f"https://www.google.com/maps/search/?api=1&query={place['lat']},{place['lon']}",
        "description": place.get("description"),
        "wikipedia_url": place.get("wikipedia_url"),
    }


def _rules(weather: list[dict], places: list[dict], decided_by: str) -> dict:
    best_day = min(weather, key=lambda d: (d["rain_chance"], d["rain_mm"])) if weather else None
    wet = best_day is not None and is_rainy(best_day)
    ordered = sorted(places, key=lambda p: (wet and not is_indoor(p["kind"])))
    if not ordered:
        return {
            "place": None,
            "day": best_day["date"] if best_day else None,
            "when": "",
            "why": "Couldn't find notable places nearby. Try a bigger town nearby or give yourself more time.",
            "plan": [],
            "bring": [],
            "news_notes": [],
            "backups": [],
            "decided_by": decided_by,
        }
    top = ordered[0]
    day_text = f"{best_day['weekday']} looks {best_day['summary']} ({best_day['rain_chance']}% rain)" if best_day else "No forecast available"
    return {
        "place": _place_out(top),
        "day": best_day["date"] if best_day else None,
        "when": "morning" if not wet else "whenever the rain eases",
        "why": f"{day_text}; {top['name']} is one of the best-known places {top['distance_km']} km away.",
        "plan": [],
        "bring": ["umbrella"] if wet else ["water", "sunscreen"],
        "news_notes": [],
        "backups": [{"name": p["name"], "why": f"{p['kind']}, {p['distance_km']} km"} for p in ordered[1:3]],
        "decided_by": decided_by,
    }
