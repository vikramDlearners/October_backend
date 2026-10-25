import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.weekend.planner import OPENING_QUESTION, parse_duration
from app.weekend.sources import Location, upcoming_weekend

client = TestClient(app)


@pytest.mark.parametrize(
    "text, hours",
    [
        ("3 hours", 3),
        ("2h", 2),
        ("two hours", 2),
        ("half day", 4),
        ("half a day", 4),
        ("full day", 9),
        ("1 day", 9),
        ("whole weekend", 36),
        ("2 days", 36),
        ("weekend", 36),
    ],
)
def test_parse_duration(text, hours):
    assert parse_duration(text)[1] == hours


def test_parse_duration_rejects_nonsense():
    assert parse_duration("whenever") is None


def test_upcoming_weekend():
    # 2026-10-28 is a Wednesday.
    days = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]
    assert upcoming_weekend(days) == ["2026-10-31", "2026-11-01"]
    # On a Sunday the weekend is just today.
    assert upcoming_weekend(["2026-10-25", "2026-10-26"]) == ["2026-10-25"]


def test_chat_flow(monkeypatch):
    async def fake_geocode(_client, query):
        return Location(name="Chennai", region="Tamil Nadu, India", country_code="IN", lat=13.08, lon=80.27)

    async def fake_plan(_client, loc, duration, hours):
        return {
            "duration": duration,
            "hours": hours,
            "recommendation": {
                "place": {"name": "Shore Temple", "distance_km": 50.0},
                "day": "2026-10-31",
                "when": "07:00-11:00",
                "why": "Clear morning.",
                "plan": ["07:00 leave"],
                "bring": ["water"],
                "news_notes": [],
                "backups": [],
                "decided_by": "test",
            },
        }

    monkeypatch.setattr("app.api.weekend.geocode", fake_geocode)
    monkeypatch.setattr("app.api.weekend.plan_weekend", fake_plan)

    first = client.post("/weekend/chat", json={}).json()
    assert first["reply"] == OPENING_QUESTION and first["stage"] == "location"
    sid = first["session_id"]

    second = client.post("/weekend/chat", json={"session_id": sid, "message": "Chennai"}).json()
    assert second["stage"] == "duration" and "Chennai" in second["reply"]

    retry = client.post("/weekend/chat", json={"session_id": sid, "message": "dunno"}).json()
    assert retry["stage"] == "duration" and "didn't get that" in retry["reply"]

    final = client.post("/weekend/chat", json={"session_id": sid, "message": "full day"}).json()
    assert final["stage"] == "done"
    assert final["plan"]["hours"] == 9
    assert "Shore Temple" in final["reply"]
