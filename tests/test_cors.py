from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_preflight_allows_browser_origin():
    response = client.options(
        "/weekend/chat",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] in ("*", "http://localhost:5173")


def test_simple_request_carries_cors_header():
    response = client.get("/status", headers={"Origin": "http://localhost:5173"})

    assert response.headers["access-control-allow-origin"] in ("*", "http://localhost:5173")
