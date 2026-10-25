"""Keyless data sources: Open-Meteo (geocoding + weather), Wikidata + Wikipedia (places) and Google News RSS (news)."""

import asyncio
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date

import httpx

log = logging.getLogger(__name__)



class LocationNotFound(Exception):
    pass


@dataclass
class Location:
    name: str
    region: str
    country_code: str
    lat: float
    lon: float

    @property
    def label(self) -> str:
        return ", ".join(p for p in (self.name, self.region) if p)


_LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


async def geocode(client: httpx.AsyncClient, query: str) -> Location:
    if match := _LATLON.match(query):
        lat, lon = float(match[1]), float(match[2])
        return Location(name=f"{lat:.4f}, {lon:.4f}", region="", country_code="IN", lat=lat, lon=lon)
    resp = await client.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": query.split(",")[0].strip(), "count": 10, "language": "en"},
    )
    resp.raise_for_status()
    results = resp.json().get("results") or []
    # Populated places first, so "Pondicherry" doesn't land on the airport.
    best = next((r for r in results if str(r.get("feature_code", "")).startswith("PPL")), results[0] if results else None)
    if not best:
        raise LocationNotFound(query)
    return Location(
        name=best["name"],
        region=", ".join(p for p in (best.get("admin1"), best.get("country")) if p),
        country_code=best.get("country_code", "IN"),
        lat=best["latitude"],
        lon=best["longitude"],
    )


def upcoming_weekend(days: list[str]) -> list[str]:
    """The first run of Saturday/Sunday dates in `days` (today counts if it's already the weekend)."""
    weekend = []
    for d in days:
        if date.fromisoformat(d).weekday() >= 5:
            weekend.append(d)
        elif weekend:
            break
    return weekend


def is_rainy(day: dict) -> bool:
    return day["rain_chance"] >= 40 or day["rain_mm"] >= 2


async def weekend_weather(client: httpx.AsyncClient, loc: Location) -> list[dict]:
    resp = await client.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": loc.lat,
            "longitude": loc.lon,
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset",
            "timezone": "auto",
            "forecast_days": 8,
        },
    )
    resp.raise_for_status()
    daily = resp.json()["daily"]
    wanted = set(upcoming_weekend(daily["time"]))
    return [
        {
            "date": d,
            "weekday": date.fromisoformat(d).strftime("%A"),
            "summary": describe_weather(daily["weather_code"][i]),
            "max_c": daily["temperature_2m_max"][i],
            "min_c": daily["temperature_2m_min"][i],
            "rain_chance": daily["precipitation_probability_max"][i] or 0,
            "rain_mm": daily["precipitation_sum"][i] or 0,
            "sunrise": daily["sunrise"][i][-5:],
            "sunset": daily["sunset"][i][-5:],
        }
        for i, d in enumerate(daily["time"])
        if d in wanted
    ]


def describe_weather(code: int) -> str:
    if code == 0:
        return "clear"
    if code <= 2:
        return "partly cloudy"
    if code == 3:
        return "overcast"
    if code <= 48:
        return "fog"
    if code <= 57:
        return "drizzle"
    if code <= 67:
        return "rain"
    if code <= 77:
        return "snow"
    if code <= 82:
        return "rain showers"
    if code <= 86:
        return "snow showers"
    return "thunderstorm"


def search_radius_km(hours: float) -> int:
    if hours <= 4:
        return 15
    if hours <= 10:
        return 60
    return 150


# Wikidata classes worth a weekend visit: temples, beaches, museums, parks, forts, lakes, waterfalls, national parks,
# zoos, amusement parks, archaeological sites, monuments, tourist attractions, hills, mosques, churches, viewpoints...
PLACE_TYPES = (
    "Q44539 Q40080 Q33506 Q22698 Q57821 Q23397 Q34038 Q46169 Q43501 Q194195 Q839954 Q4989906 Q570116 "
    "Q1107656 Q16970 Q32815 Q54050 Q8502 Q179700 Q207694 Q2087181 Q473972 Q24398318 Q842402 Q1144012 Q11303"
).split()
INDOOR_WORDS = ("museum", "temple", "mosque", "church", "cathedral", "gallery", "aquarium", "palace")


def is_indoor(kind: str) -> bool:
    return any(word in kind.lower() for word in INDOOR_WORDS)


def _sparql(loc: Location, radius_km: int) -> str:
    types = " ".join(f"wd:{t}" for t in PLACE_TYPES)
    return f"""SELECT ?item ?itemLabel ?typeLabel ?coord ?dist ?links ?article WHERE {{
  SERVICE wikibase:around {{
    ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:center "Point({loc.lon} {loc.lat})"^^geo:wktLiteral;
                    wikibase:radius "{radius_km}"; wikibase:distance ?dist.
  }}
  VALUES ?type {{ {types} }}
  ?item wdt:P31 ?type; wikibase:sitelinks ?links.
  OPTIONAL {{ ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} ORDER BY DESC(?links) LIMIT 120"""


VISIT_WORDS = (
    "temple", "beach", "museum", "park", "fort", "lake", "waterfall", "falls", "hill", "zoo", "sanctuary",
    "monument", "cave", "church", "mosque", "palace", "garden", "reserve", "dam", "lighthouse", "heritage",
    "attraction", "gallery", "aquarium", "ruins", "archaeological", "island", "viewpoint", "shrine",
)
_places_cache: dict[tuple, tuple[float, list[dict]]] = {}
PLACES_CACHE_SECONDS = 24 * 3600


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


async def nearby_places(client: httpx.AsyncClient, loc: Location, radius_km: int, limit: int = 15) -> list[dict]:
    """Places worth visiting around the location, most notable first.

    OpenStreetMap's Overpass API blocks this server's cloud IP, so Wikidata is the main source. It rate-limits hard,
    so results are cached for a day and Wikipedia's geosearch (10 km at most) fills in when it refuses.
    """
    key = (round(loc.lat, 2), round(loc.lon, 2), radius_km)
    cached = _places_cache.get(key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    places = await _wikidata_places(client, loc, radius_km, limit) or await _wikipedia_places(client, loc, limit)
    if places:
        await _add_wikipedia_summaries(client, places[:8])
        _places_cache[key] = (time.monotonic() + PLACES_CACHE_SECONDS, places)
    return places


async def _wikidata_places(client: httpx.AsyncClient, loc: Location, radius_km: int, limit: int) -> list[dict]:
    try:
        resp = await client.get(
            "https://query.wikidata.org/sparql",
            params={"query": _sparql(loc, radius_km)},
            headers={"accept": "application/sparql-results+json"},
            timeout=60,
        )
        resp.raise_for_status()
        rows = resp.json()["results"]["bindings"]
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log.warning("Wikidata places lookup failed: %s", str(exc).split(" for url")[0])
        return []

    places: dict[str, dict] = {}
    for row in rows:
        name = row["itemLabel"]["value"]
        # Unlabelled items come back as their Q-id; duplicates appear once per matching class.
        if re.fullmatch(r"Q\d+", name) or row["item"]["value"] in places:
            continue
        lon, lat = map(float, re.findall(r"-?\d+(?:\.\d+)?", row["coord"]["value"])[:2])
        places[row["item"]["value"]] = {
            "name": name,
            "kind": row.get("typeLabel", {}).get("value", "place"),
            "distance_km": round(float(row["dist"]["value"]), 1),
            "lat": lat,
            "lon": lon,
            "wikipedia_url": row.get("article", {}).get("value"),
            "description": None,
            "notability": int(row["links"]["value"]),
        }

    # Most notable first, but no more than 4 of any one kind so the shortlist isn't all temples.
    chosen, per_kind = [], {}
    for place in places.values():
        if per_kind.get(place["kind"], 0) >= 4:
            continue
        per_kind[place["kind"]] = per_kind.get(place["kind"], 0) + 1
        chosen.append(place)
        if len(chosen) == limit:
            break
    return chosen


async def _wikipedia_places(client: httpx.AsyncClient, loc: Location, limit: int) -> list[dict]:
    try:
        resp = await client.get(
            "https://en.wikipedia.org/w/api.php",
            params={
                "action": "query",
                "format": "json",
                "generator": "geosearch",
                "ggscoord": f"{loc.lat}|{loc.lon}",
                "ggsradius": 10000,
                "ggslimit": 200,
                "prop": "coordinates|description",
            },
        )
        resp.raise_for_status()
        pages = resp.json().get("query", {}).get("pages", {}).values()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("Wikipedia geosearch failed: %s", str(exc).split(" for url")[0])
        return []

    places = []
    for page in pages:
        description = page.get("description") or ""
        coords = (page.get("coordinates") or [{}])[0]
        if "lat" not in coords or not any(word in description.lower() for word in VISIT_WORDS):
            continue
        places.append(
            {
                "name": page["title"],
                "kind": description,
                "distance_km": round(_distance_km(loc.lat, loc.lon, coords["lat"], coords["lon"]), 1),
                "lat": coords["lat"],
                "lon": coords["lon"],
                "wikipedia_url": f"https://en.wikipedia.org/wiki/{page['title'].replace(' ', '_')}",
                "description": None,
                "notability": None,
            }
        )
    return sorted(places, key=lambda p: p["distance_km"])[:limit]


async def _add_wikipedia_summaries(client: httpx.AsyncClient, places: list[dict]) -> None:
    async def fetch(place: dict) -> None:
        url = place.get("wikipedia_url")
        if not url:
            return
        title = url.rsplit("/wiki/", 1)[-1]
        try:
            resp = await client.get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}")
            if resp.status_code == 200:
                place["description"] = (resp.json().get("extract") or "")[:300] or None
        except httpx.HTTPError as exc:
            log.info("Wikipedia summary for %s failed: %s", title, exc)

    await asyncio.gather(*(fetch(p) for p in places))


async def local_news(client: httpx.AsyncClient, loc: Location, limit: int = 8) -> list[dict]:
    cc = (loc.country_code or "IN").upper()
    queries = [f'"{loc.name}" when:7d', f'"{loc.name}" (festival OR event OR weekend OR traffic) when:7d']
    items: list[dict] = []
    seen = set()
    for q in queries:
        try:
            resp = await client.get(
                "https://news.google.com/rss/search",
                params={"q": q, "hl": f"en-{cc}", "gl": cc, "ceid": f"{cc}:en"},
            )
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
        except (httpx.HTTPError, ET.ParseError) as exc:
            log.warning("News lookup failed: %s", exc)
            continue
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            if not title or title in seen:
                continue
            seen.add(title)
            items.append(
                {
                    "title": title,
                    "source": item.findtext("source"),
                    "published": item.findtext("pubDate"),
                    "link": item.findtext("link"),
                }
            )
    return items[:limit]
