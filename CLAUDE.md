# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The repo holds two independent services: the FastAPI app at the root (Python, port 8000) and `sloth-trip-watcher/` (Node.js with zero dependencies, port 3000, its own README).

## FastAPI app commands

- Setup: `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
- Run: `.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000` (add `--reload` while developing)
- Tests: `.venv/bin/pytest`. Single test: `.venv/bin/pytest tests/test_weekend.py::test_chat_flow`
- Lint: `.venv/bin/python -m pyflakes app tests`

## FastAPI architecture

- `app/main.py` mounts the routers from `app/api/`. Each router module exposes `router`.
- `app/config.py` loads `.env` (python-dotenv) into a frozen `Settings` once at import. Use the `settings` singleton; don't read `os.environ` anywhere else.
- Weekend recommender, in pipeline order:
  - `app/api/weekend.py`: the HTTP layer. `/weekend/chat` is a state machine (`location` -> `duration` -> `done`) over the in-memory `SessionStore`.
  - `app/weekend/planner.py`: `parse_duration` turns free text into hours, which sets the search radius. `plan_weekend` gathers weather, places and news in parallel with `asyncio.gather`, then calls `recommend`.
  - `app/weekend/sources.py`: keyless sources. Places come from Wikidata SPARQL. Wikidata rate-limits hard, so there's a 24 h cache and a Wikipedia geosearch fallback. Overpass/OSM is deliberately not used because it blocks this server's cloud IP. Wikimedia returns 403 unless the user agent carries a contact URL (`settings.user_agent`).
  - `app/weekend/recommend.py`: one JSON `SCHEMA`, shared by Gemini (`responseSchema`) and Ollama (`format`). It tries Gemini, then Ollama, then `_rules`. `_validate` rejects any place that isn't in the candidate list. `decided_by` records which model answered.
- Tests mock `geocode` and `plan_weekend` at `app.api.weekend.*`, so they never touch the network.

## Sloth Trip Watcher

`cd sloth-trip-watcher && npm start` (or `npm run dev` / `npm run check`). It needs no `npm install`. It's deployed on this server as the systemd unit `sloth-trip-watcher` from `/opt/sloth-trip-watcher`, with data in `/var/lib/sloth-trip-watcher`. To deploy changes, rsync to `/opt` (excluding `.env` and `data`) and restart the unit.
