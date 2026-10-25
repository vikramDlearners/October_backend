# October backend

This repo holds two independent services. They share a server but no code:

| Service | Stack | Port | What it does |
|---|---|---|---|
| **FastAPI app** (repo root) | Python 3, FastAPI | 8000 | A status endpoint and a "what should I do this weekend?" recommender |
| **[Sloth Trip Watcher](sloth-trip-watcher/README.md)** (`sloth-trip-watcher/`) | Node.js 22, zero dependencies | 3000 | A trip planner you set up once. It keeps watching the forecast and tells you when to go (Gemma, Telegram, email) |

A Postman collection covering every endpoint of both services is in [`postman/October_backend.postman_collection.json`](postman/October_backend.postman_collection.json).

## Contents

- [Repository layout](#repository-layout)
- [FastAPI app](#fastapi-app)
  - [Setup and run](#setup-and-run)
  - [Configuration](#configuration)
  - [API reference](#fastapi-api-reference)
  - [How a recommendation is made](#how-a-recommendation-is-made)
  - [Tests and lint](#tests-and-lint)
- [Sloth Trip Watcher](#sloth-trip-watcher)
  - [Setup and run](#setup-and-run-1)
  - [Configuration](#configuration-1)
  - [API reference](#sloth-trip-watcher-api-reference)
  - [Using it from a frontend](#using-it-from-a-frontend)
  - [The email service](#the-email-service)
  - [Deploy](#deploy)
- [Postman](#postman)
- [Troubleshooting](#troubleshooting)

## Repository layout

```
.
├── app/                     FastAPI app
│   ├── main.py              Creates the app and mounts the routers
│   ├── config.py            Loads .env into a frozen Settings singleton
│   ├── api/
│   │   ├── status.py        GET /status
│   │   └── weekend.py       POST /weekend/chat, POST /weekend/recommend
│   └── weekend/
│       ├── planner.py       Duration parsing, sessions, plan_weekend()
│       ├── sources.py       Geocoding, weather, places, news (all keyless)
│       └── recommend.py     Gemini → Ollama → rules, plus validation
├── tests/                   pytest suite (network fully mocked)
├── requirements.txt         Runtime dependencies
├── requirements-dev.txt     + pytest, pyflakes
├── .env.example             FastAPI settings template
├── render.yaml              Render Blueprint for Sloth Trip Watcher
├── postman/                 Postman collection for both services
└── sloth-trip-watcher/      Node.js service (own README)
    ├── src/
    │   ├── server.js        HTTP server, routing, CORS, static files
    │   ├── config.js        Environment settings and /api/health
    │   ├── check.js         One check: forecast → places → decide → alert
    │   ├── decide.js        Gemma decision with a rules fallback
    │   ├── sources.js       Geocoding, Open-Meteo, SerpApi
    │   ├── send.js          Emails a GO plan through ITINERARY_API_URL
    │   ├── store.js         watches.json, written atomically
    │   └── check-all.js     `npm run check`: check every watch once
    ├── public/              Bundled web UI
    ├── deploy/              systemd unit
    └── .env.example
```

---

## FastAPI app

### Setup and run

You need Python 3.10 or newer.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # optional; add GEMINI_API_KEY for fast answers
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000           # add --reload while developing
```

- Interactive docs (Swagger UI): http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc
- OpenAPI schema: http://127.0.0.1:8000/openapi.json

On this server the app runs as a plain `uvicorn` process from `/var/project/.venv`. It has no systemd unit, so restart it by hand after you pull changes.

### Configuration

All settings come from `.env`, which `app/config.py` loads once at import. Every setting is optional.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(empty)* | Google AI Studio key. With it, a recommendation takes seconds |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model used for recommendations |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama, used when Gemini is missing or fails |
| `OLLAMA_MODEL` | `gemma4:e4b` | Ollama model |
| `OLLAMA_TIMEOUT_SECONDS` | `300` | Ollama runs at about 4 tokens/s on this CPU-only server, so it gets a long timeout |
| `USER_AGENT` | `weekend-planner/0.1 (https://github.com/...)` | Wikimedia returns 403 unless the user agent includes a contact URL |
| `APP_NAME` | `project` | Shown by `/status` and the docs |
| `APP_VERSION` | `0.1.0` | Shown by `/status` |
| `APP_ENV` | `development` | Shown by `/status` |

### FastAPI API reference

#### `GET /status`

Liveness and build information.

```json
{
  "status": "ok",
  "app": "project",
  "version": "0.1.0",
  "environment": "development",
  "uptime_seconds": 1234.567,
  "timestamp": "2026-10-25T10:00:00Z"
}
```

#### `POST /weekend/chat`

A short guided conversation, built as a state machine with three stages: `location` → `duration` → `done`.

Request:

```json
{ "session_id": "string or null", "message": "string or null (max 300 chars)" }
```

Response:

```json
{ "session_id": "…", "stage": "location | duration | done", "reply": "text to show", "plan": null }
```

How a conversation goes:

1. Send `{}`. A new session starts and `reply` asks where you are.
2. Send `{ session_id, message: "Chennai" }`. The location is geocoded and `stage` becomes `duration`. You can also send a `lat,lon` such as `13.08,80.27`.
3. Send `{ session_id, message: "full day" }`. The weekend is planned, `stage` becomes `done`, and `plan` holds the full recommendation (the same shape as `/weekend/recommend` without `summary`).
4. Once you're in `done`, sending a new location starts another round in the same session.

The chat handles problems like this:
- An unknown place returns a friendly `reply` and keeps the stage, so the user can try again.
- A duration it can't parse asks the question again.
- An empty `message` repeats the current question.

Sessions are kept in memory for 1 hour, with at most 1,000 at a time. They're lost when the server restarts. An unknown or expired `session_id` starts a new session.

```bash
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{"session_id":"<id>","message":"Chennai"}'
curl -s -X POST localhost:8000/weekend/chat -H 'content-type: application/json' -d '{"session_id":"<id>","message":"full day"}'
```

#### `POST /weekend/recommend`

The same recommendation in a single call.

Request:

```json
{ "location": "Chennai", "duration": "full day" }
```

`location` must be 2–200 characters and `duration` 1–100 characters.

Response (trimmed):

```json
{
  "location": { "name": "Chennai", "region": "Tamil Nadu, India", "lat": 13.08, "lon": 80.27 },
  "duration": "a full day",
  "hours": 9,
  "radius_km": 60,
  "weather": [
    { "date": "2026-10-31", "weekday": "Saturday", "summary": "partly cloudy", "max_c": 31.2, "min_c": 24.8,
      "rain_chance": 35, "rain_mm": 1.2, "sunrise": "06:01", "sunset": "17:52" }
  ],
  "places": [ { "name": "…", "kind": "temple", "distance_km": 42.3, "lat": 0, "lon": 0, "description": "…", "wikipedia_url": "…" } ],
  "news": [ { "title": "…", "source": "…", "published": "…", "link": "…" } ],
  "recommendation": {
    "place": { "name": "…", "kind": "…", "distance_km": 42.3, "lat": 0, "lon": 0, "maps_url": "https://www.google.com/maps/search/?api=1&query=…", "description": "…", "wikipedia_url": "…" },
    "day": "2026-10-31",
    "when": "07:00-11:00",
    "why": "…",
    "plan": ["07:00 leave home", "…"],
    "bring": ["water", "…"],
    "news_notes": ["…"],
    "backups": [ { "name": "…", "why": "…" } ],
    "decided_by": "gemini-3.8-flash"
  },
  "summary": "Go to … (42.3 km away) on 2026-10-31, 07:00-11:00.\n…"
}
```

If no notable places are found nearby, `recommendation.place` is `null` and `why` explains what happened.

Errors:

| Status | When |
|---|---|
| 400 | The duration can't be understood, or the location can't be found |
| 422 | The body fails validation (missing field, wrong length) |
| 502 | An upstream data source (geocoding, weather) failed |

#### Durations the app understands

`parse_duration` turns free text into hours, and the hours set how far away to look:

| You say | Hours | Search radius |
|---|---|---|
| `3 hours`, `two hrs`, `4h` | as given (up to 72) | 15 km if ≤ 4 h, 60 km if ≤ 10 h, else 150 km |
| `half day`, `half a day` | 4 | 15 km |
| `full day`, `whole day`, `day trip`, `1 day` | 9 | 60 km |
| `whole weekend`, `both days`, `overnight`, `weekend`, `2 days` | 36 | 150 km |

### How a recommendation is made

1. **Location.** Open-Meteo geocoding, or a raw `lat,lon`.
2. **Radius.** Set from the duration, as in the table above.
3. **Weather.** The Open-Meteo forecast for the coming Saturday and Sunday. If today is Sunday, only today is used.
4. **Places.** Notable places from Wikidata SPARQL (temples, beaches, museums, forts, lakes, waterfalls, parks and more), ranked by how many Wikipedias cover them and enriched with Wikipedia summaries. Wikidata rate-limits hard, so results are cached for 24 h and Wikipedia geosearch (10 km) is the fallback. OpenStreetMap's Overpass API blocks this server's cloud IP, so it isn't used.
5. **News.** Google News RSS for the town from the last 7 days: festivals, closures, traffic, rain alerts.
6. **Decision.** Steps 3–5 run in parallel (`asyncio.gather`). The decision then tries three options in order:
   1. **Gemini**, if `GEMINI_API_KEY` is set. It answers in seconds.
   2. **Local Ollama.** It takes about 3–4 minutes on this CPU-only server.
   3. **Simple rules:** pick the driest day, and prefer indoor places if that day is rainy.

   Gemini and Ollama share one JSON schema, so their output can be checked the same way. Any answer that names a place outside the candidate list is rejected, and the next option is tried. `decided_by` records which option answered.

Every data source is free and needs no API key.

### Tests and lint

```bash
.venv/bin/pytest                                         # whole suite
.venv/bin/pytest tests/test_weekend.py::test_chat_flow   # one test
.venv/bin/python -m pyflakes app tests                   # lint
```

The tests mock `geocode` and `plan_weekend` at `app.api.weekend.*`, so they never touch the network.

---

## Sloth Trip Watcher

**Tell it once. Do nothing. It tells you when to go.** Give it a destination, a date window and a budget once. It keeps checking the weather and the places worth seeing, and Gemma decides either **GO**, with exactly one timed, budgeted day plan, or **NOT YET**, with what would have to change. On a GO it sends a Telegram message, and the plan can also be emailed. The [service README](sloth-trip-watcher/README.md) explains how a check works.

### Setup and run

You need Node.js 22.9 or newer. There's no `npm install` and no build step.

```bash
cd sloth-trip-watcher
cp .env.example .env   # fill in the keys you have; every integration is optional
npm start              # http://localhost:3000 (API + bundled web UI)
npm run dev            # restarts on file changes
npm run check          # check every watch once and exit
```

Watches are stored in one JSON file, `${DATA_DIR}/watches.json`. Every write goes to a temporary file that is then renamed into place, so a crash can't corrupt it. Every watch is checked every `CHECK_EVERY_HOURS` inside the web process, and **Check now** runs a check on demand.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(empty)* | Google AI Studio key used to call Gemma. Without it, a rules fallback decides |
| `GEMMA_MODEL` | `gemma-4-31b-it` | Or `gemma-4-26b-a4b-it` |
| `SERPAPI_KEY` | *(empty)* | Google Maps places via SerpApi. Without it, Gemma plans from its own knowledge |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | The **full** token from BotFather, `<digits>:<~35 chars>` |
| `TELEGRAM_CHAT_ID` | *(empty)* | Numeric chat ID (negative for groups). Telegram needs both values |
| `ITINERARY_API_URL` | *(empty)* | Email service the Send endpoint POSTs to. Without it, Send returns 503 |
| `CORS_ORIGIN` | `*` | Origin allowed to call the API from a browser, such as `http://localhost:5173` |
| `CHECK_EVERY_HOURS` | `12` | How often every watch is re-checked |
| `PORT` | `3000` | Listens on `0.0.0.0:PORT` |
| `DATA_DIR` | `./data` | Where `watches.json` lives |

At startup the server logs a warning for each setting that's missing or malformed. It never logs the values. `GET /api/health` shows which integrations are live.

### Sloth Trip Watcher API reference

All requests and responses are JSON. Any failure returns a non-2xx status with `{ "error": "message" }`, and the message is safe to show to the user as it is.

| # | Method and path | Body | Success |
|---|---|---|---|
| 1 | `GET /api/health` | none | `200 { gemma, serpapi, telegram, itineraryApi, checkEveryHours }` |
| 2 | `GET /api/watches` | none | `200` array of watches, newest first |
| 3 | `POST /api/watches` | `{ destination, origin, from, to, budgetInr, weekendsOnly, noRain, vibe }` | `201` the new watch |
| 4 | `POST /api/watches/:id/check` | none | `200` the updated watch, with `lastCheck` |
| 5 | `DELETE /api/watches/:id` | none | `200 { ok: true }` |
| 6 | `POST /api/watches/:id/send` | `{ email }` | `200 { ok, to, status }` |

`:id` is the watch's UUID.

#### 1. `GET /api/health`

```json
{ "gemma": "gemma-4-31b-it", "serpapi": true, "telegram": true, "itineraryApi": true, "checkEveryHours": 12 }
```

`gemma` is the model name, or `false` when no key is set. The other integration fields are booleans.

#### 3. `POST /api/watches`

```json
{
  "destination": "Mahabalipuram",
  "origin": "Chennai",
  "from": "2026-10-25",
  "to": "2026-11-08",
  "budgetInr": 3000,
  "weekendsOnly": true,
  "noRain": false,
  "vibe": "beaches, temples"
}
```

The request is validated like this, and any failure returns 400 with a message:
- `destination` and `origin` are required.
- `from` and `to` must be real `YYYY-MM-DD` dates, with `from` on or before `to`.
- `budgetInr` must be a positive number (rupees per person, all-in).

Optional fields:
- `weekendsOnly` defaults to `false`.
- `noRain` defaults to `true`.
- `vibe` is free text, up to 200 characters, that steers which places are picked.

The destination is geocoded when the watch is created. A place that can't be found returns 400. A failed map lookup returns 502.

#### The watch object (returned by 2, 3 and 4)

```json
{
  "id": "uuid",
  "createdAt": "ISO time",
  "place": { "name": "Mahabalipuram", "region": "Tamil Nadu, India", "lat": 12.62, "lon": 80.19 },
  "origin": "Chennai", "from": "2026-10-25", "to": "2026-11-08",
  "budgetInr": 3000, "weekendsOnly": true, "noRain": false, "vibe": "beaches, temples",
  "lastCheck": {
    "at": "ISO time", "verdict": "GO | NOT_YET", "reason": "…", "decidedBy": "gemma-4-31b-it", "horizon": "2026-11-09",
    "days": [{ "date": "2026-10-31", "weekday": "Sat", "weatherCode": 3, "tempMaxC": 31, "rainChancePct": 40 }],
    "alertError": "only present if the Telegram alert failed",
    "plan": {
      "date": "2026-10-31", "summary": "…", "gettingThere": "…",
      "howToGo": [{ "mode": "Bus", "route": "…", "durationMin": 120, "costInr": 150, "tip": "…" }],
      "stops": [{ "time": "10:00", "name": "…", "note": "…", "costInr": 40 }],
      "packing": [{ "item": "Water bottle", "why": "…" }],
      "totalInr": 970
    }
  },
  "notifiedFor": "2026-10-31"
}
```

- `lastCheck` is `null` until the first check has run.
- `plan` is `null` when `verdict` is `NOT_YET`.
- `horizon` is the last date the forecast covers. Open-Meteo forecasts 16 days ahead, so dates beyond that wait for later checks.
- `notifiedFor` is the plan date Telegram was last told about. It prevents repeat alerts for the same date.

#### 4. `POST /api/watches/:id/check`

Runs forecast → places → decision now. With Gemma this takes about 15 s. If a scheduled check of the same watch is already running, the request waits for it instead of starting a second one, so the same alert can't be sent twice. Returns 404 for an unknown watch, or 502 with `Check failed: …`.

#### 5. `DELETE /api/watches/:id`

Returns `{ "ok": true }`, or 404 `{ "error": "No such watch." }`.

#### 6. `POST /api/watches/:id/send`

Emails the watch's current GO plan through the email service set in `ITINERARY_API_URL`.

```json
{ "email": "you@example.com" }
```

Success response: `{ "ok": true, "to": "you@example.com", "status": 202 }`. Here `status` is the HTTP status the email service returned.

The server checks these in order and returns the first one that fails:

| Status | Meaning |
|---|---|
| 400 | The email address is invalid |
| 404 | No such watch |
| 409 | There's no GO plan yet. Run **Check now** first |
| 503 | `ITINERARY_API_URL` isn't set on the server |
| 502 | The email service failed or returned a non-2xx status |

#### Example session

```bash
B=http://localhost:3000
curl -s $B/api/health
ID=$(curl -s -X POST $B/api/watches -H 'content-type: application/json' \
  -d '{"destination":"Mahabalipuram","origin":"Chennai","from":"2026-10-25","to":"2026-11-08","budgetInr":3000,"weekendsOnly":true,"noRain":false,"vibe":"beaches"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST $B/api/watches/$ID/check
curl -s -X POST $B/api/watches/$ID/send -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -s -X DELETE $B/api/watches/$ID
```

### Using it from a frontend

The bundled UI in `sloth-trip-watcher/public/` is served from the same server and port, so it needs no extra setup.

A frontend hosted somewhere else can call the API too, for example one running on `http://localhost:5173` on your machine:

- **Base URL.** Point the frontend at the server, for example `http://20.55.33.206:3000`. Port 3000 must be open in the cloud firewall.
- **CORS.** Every `/api/` response, including errors, carries these headers:
  - `Access-Control-Allow-Origin: <CORS_ORIGIN>`
  - `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
  - `Access-Control-Allow-Headers: content-type`

  `OPTIONS` preflights get 204. The default, `*`, allows any origin, including localhost on any port. To lock it down, set `CORS_ORIGIN` to one exact origin.
- **http vs https.** The server speaks plain http. A page served over https can't call it, because browsers block mixed content. Run the page on `http://localhost`, or put the API behind HTTPS (for example, nginx with a certificate).
- **Directions.** The Google Maps directions link is built in the browser from `origin`, `place.lat` and `place.lon`, so it needs no API call.

### The email service

The frontend never calls the email service directly. When someone uses Send, the backend POSTs this to `ITINERARY_API_URL`:

```json
{
  "to": "you@example.com",
  "subject": "🦥 GO to Mahabalipuram on 2026-10-31",
  "text": "The same plain-text message Telegram gets",
  "itinerary": { "place": {}, "origin": "Chennai", "budgetInr": 3000, "reason": "…", "decidedBy": "…", "plan": {} }
}
```

Any 2xx response counts as sent. The request times out after 15 s. You have to provide this service yourself, for example a small endpoint that relays the message to SMTP, Resend or SendGrid.

### Deploy

#### This server (systemd)

The service runs as the systemd unit `sloth-trip-watcher`. The app is in `/opt/sloth-trip-watcher`, its secrets in `/opt/sloth-trip-watcher/.env`, and its data in `/var/lib/sloth-trip-watcher`. To deploy changes:

```bash
cd sloth-trip-watcher
sudo rsync -a --delete --exclude .env --exclude data ./ /opt/sloth-trip-watcher/
sudo systemctl restart sloth-trip-watcher
journalctl -u sloth-trip-watcher -f
curl -s localhost:3000/api/health
```

To change a setting, edit `/opt/sloth-trip-watcher/.env` (owned by `sloth`, mode 600) and restart the unit. The [service README](sloth-trip-watcher/README.md#deploy-on-ubuntu) covers a first-time Ubuntu install.

#### Render

[`render.yaml`](render.yaml) defines one Node web service with `rootDir: sloth-trip-watcher` and a 1 GB disk at `/var/data`. Create a Blueprint from the repo, then fill in the secrets: `GEMINI_API_KEY`, `SERPAPI_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `ITINERARY_API_URL`.

---

## Postman

Import `postman/October_backend.postman_collection.json`. It has these collection variables:

| Variable | Default | Purpose |
|---|---|---|
| `baseUrl` | `http://20.55.33.206:8000` | FastAPI app |
| `slothBaseUrl` | `http://20.55.33.206:3000` | Sloth Trip Watcher |
| `session_id` | set automatically | Saved by the first chat request |
| `watch_id` | set automatically | Saved by "Create watch" |

The collection has three folders:
- **Weekend recommender:** the chat flow in order, and the one-shot recommendation.
- **Status.**
- **Sloth Trip Watcher:** health, list, create, check, send and delete.

Each request comes with example responses.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/weekend/*` answers take minutes | No `GEMINI_API_KEY`, so the app is waiting on CPU-only Ollama. `decided_by` shows which option answered |
| Few or no places found | Wikidata rate-limited the server (the fallback is a 10 km Wikipedia search), or the town is small. Try a bigger town nearby or a longer duration |
| `403` from Wikimedia in the logs | `USER_AGENT` has no contact URL |
| Health shows `gemma: false` | `GEMINI_API_KEY` is empty in the deployed `.env`. Decisions use the rules fallback |
| Card says "Telegram alert not sent" | Bad token or chat ID. The 404 error means the token is truncated. The next check retries the alert |
| Send returns 503 | `ITINERARY_API_URL` isn't set on the server |
| Browser shows a CORS error | The page's origin doesn't match `CORS_ORIGIN`, or an https page is calling the http API |
| The API times out from outside | Port 3000 (or 8000) isn't open in the cloud firewall |
