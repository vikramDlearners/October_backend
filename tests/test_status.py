from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_status_returns_ok():
    response = client.get("/status")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"]
    assert body["uptime_seconds"] >= 0
    assert "timestamp" in body
