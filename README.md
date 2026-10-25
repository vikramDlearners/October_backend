# October backend

Two services:

- **FastAPI app** (this directory, port 8000): a status endpoint and a weekend recommender.
- **[Sloth Trip Watcher](sloth-trip-watcher/README.md)** (Node.js, port 3000): set-and-forget trip watching with Gemma and Telegram alerts.

## FastAPI app

### Setup and run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env    # add GEMINI_API_KEY for fast recommendations
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
.venv/bin/pytest
```

Interactive docs: http://127.0.0.1:8000/docs

### Endpoints

- `GET /status`: status, version, environment, uptime
- `POST /weekend/chat`: a short conversation. Send `{}` to start. The API asks "What should I do this weekend?", then your location, then how much time you have, and finally answers with one recommendation. Pass the returned `session_id` with each `message`.
- `POST /weekend/recommend`: the same in one call, with `{"location": "Chennai", "duration": "full day"}`

```bash
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{"session_id":"<id>","message":"Chennai"}'
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{"session_id":"<id>","message":"full day"}'
```

### How a recommendation is made

1. **Location:** Open-Meteo geocoding (or `lat,lon`).
2. **Time available:** "3 hours" means looking within 15 km, "half/full day" within 60 km, and "whole weekend" within 150 km.
3. **Weather:** Open-Meteo forecast for the coming Saturday and Sunday (just today if it's already Sunday).
4. **Places:** notable places from Wikidata, ranked by how many Wikipedias cover them, with Wikipedia summaries. If Wikidata rate-limits, Wikipedia geosearch (10 km) fills in. Results are cached for 24 h. OpenStreetMap's Overpass API blocks cloud IPs, so it isn't used.
5. **News:** Google News RSS for the town from the last 7 days (festivals, closures, rain alerts).
6. **Decision:** Gemini (`GEMINI_MODEL`) if a key is set, else local Ollama (`gemma4:e4b`, about 3–4 minutes on this CPU-only server), else simple weather-aware rules. The response's `decided_by` says which one answered.

Every data source is free and keyless. Chat sessions are kept in memory and reset on restart.
