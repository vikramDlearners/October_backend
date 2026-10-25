# 🦥 Sloth Trip Watcher

**Tell it once. Do nothing. It tells you when to go.**

A "set it once" trip planner for lazy travellers in India. Give it a destination, a date window and a budget one time. It keeps watching the weather and the places worth seeing, and Gemma decides **GO** (with exactly one timed, budgeted day plan) or **NOT YET** (with what would have to change). When the answer turns to GO, it sends a Telegram message.

Built for the Hacktoberfest Open-Source AI Challenge, Week 3 "Slow and Steady" (tracks: Best Use of Gemma, Render).

- Node.js 22.9+, zero npm dependencies, no build step
- Data is one JSON file, `${DATA_DIR}/watches.json`, written atomically
- Every integration is optional; `GET /api/health` shows which are live

## Run locally

```bash
cp .env.example .env   # fill in the keys you have
npm start              # http://localhost:3000
npm run dev            # restarts on file changes
npm run check          # check every watch once and exit
```

## How a check works

1. **Forecast:** Open-Meteo, 16 days, keyless. Only days inside your window (Sat/Sun with "weekends only") count. A day is rainy at ≥ 40% rain chance or ≥ 2 mm.
2. **Places:** the top 8 Google Maps results via SerpApi (`"<vibe> places in <town>"` or `"things to do in <town>"`). If the lookup fails, Gemma uses its own knowledge.
3. **Decide:** Gemma (`gemma-4-31b-it` via the Gemini API, thinking set to `minimal`, about 14 s) returns one verdict and at most one plan. With no key, an API error, a timeout or unparseable output, a rules fallback picks the first dry day. Each card shows who decided.
4. **Alert:** on a GO for a date not yet alerted, Telegram gets the plan. If sending fails, the card shows "Telegram alert not sent", the plan is still saved, and the next check retries.

Checks run every `CHECK_EVERY_HOURS` (default 12) inside the web process, and on demand with **Check now**.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ gemma, serpapi, telegram, checkEveryHours }` |
| GET | `/api/watches` | all watches, newest first |
| POST | `/api/watches` | `{ destination, origin, from, to, budgetInr, weekendsOnly, noRain, vibe }` returns 201 |
| DELETE | `/api/watches/:id` | 204 |
| POST | `/api/watches/:id/check` | runs a check now and returns the updated watch |

## Deploy on Ubuntu

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# App, data dir and a non-root user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin sloth
sudo rsync -a --delete --exclude .env --exclude data ./ /opt/sloth-trip-watcher/
sudo install -d -o sloth -g sloth -m 750 /var/lib/sloth-trip-watcher
sudo cp .env /opt/sloth-trip-watcher/.env
sudo chown sloth:sloth /opt/sloth-trip-watcher/.env && sudo chmod 600 /opt/sloth-trip-watcher/.env

# Service (sets DATA_DIR=/var/lib/sloth-trip-watcher)
sudo cp deploy/sloth-trip-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sloth-trip-watcher
journalctl -u sloth-trip-watcher -f
```

Open port 3000 (`sudo ufw allow 3000/tcp` if ufw is active, plus your cloud firewall), or put nginx in front.

## Deploy on Render

`render.yaml` (at the repo root, with `rootDir: sloth-trip-watcher`) defines one web service: Node, starter plan, no build, `npm start`, health check on `/api/health`, and a 1 GB disk at `/var/data` for `watches.json`. Create a Blueprint from the repo and fill in the four secrets. The scheduler lives in the web service because a separate cron job couldn't read its disk.

## Later: Hermes chat front end

Hermes (Nous Research) can sit on the same server as a Telegram chat front end, using a **second** bot token. It calls this API: "watch Ooty for November weekends, ₹4000" becomes `POST /api/watches`, and "how's my trip?" becomes `POST /api/watches/:id/check`. Hermes's own agent loop runs on `gemini-2.5-flash` through the OpenAI-compatible endpoint, while Gemma stays the model that makes the trip decision.
