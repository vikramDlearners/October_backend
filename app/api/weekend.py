import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.weekend.planner import (
    DURATION_QUESTION,
    OPENING_QUESTION,
    http_client,
    parse_duration,
    plan_weekend,
    sessions,
    summarize,
)
from app.weekend.sources import LocationNotFound, geocode

router = APIRouter(prefix="/weekend", tags=["weekend"])


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str | None = Field(default=None, max_length=300)


class ChatResponse(BaseModel):
    session_id: str
    stage: str
    reply: str
    plan: dict | None = None


class RecommendRequest(BaseModel):
    location: str = Field(min_length=2, max_length=200)
    duration: str = Field(min_length=1, max_length=100)


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest) -> ChatResponse:
    """A short conversation: the opening question, then location, then duration, then one recommendation."""
    session = sessions.get(body.session_id)
    if session is None:
        session = sessions.create()
        return ChatResponse(session_id=session.id, stage=session.stage, reply=OPENING_QUESTION)

    message = (body.message or "").strip()
    if not message:
        question = DURATION_QUESTION if session.stage == "duration" else OPENING_QUESTION
        return ChatResponse(session_id=session.id, stage=session.stage, reply=question)

    async with http_client() as client:
        if session.stage in ("location", "done"):
            try:
                session.location = await geocode(client, message)
            except LocationNotFound:
                return ChatResponse(session_id=session.id, stage=session.stage, reply=f"I couldn't find {message!r} on the map. Try a nearby city name.")
            except httpx.HTTPError as exc:
                raise HTTPException(502, f"Map lookup failed: {exc}") from exc
            session.stage, session.plan = "duration", None
            return ChatResponse(session_id=session.id, stage=session.stage, reply=f"Got it: {session.location.label}. {DURATION_QUESTION}")

        parsed = parse_duration(message)
        if parsed is None:
            return ChatResponse(session_id=session.id, stage=session.stage, reply=f"Sorry, I didn't get that. {DURATION_QUESTION}")
        try:
            session.plan = await plan_weekend(client, session.location, *parsed)
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Couldn't fetch weekend data: {exc}") from exc

    session.stage = "done"
    reply = summarize(session.plan) + "\n\nWant another idea? Send a different location."
    return ChatResponse(session_id=session.id, stage=session.stage, reply=reply, plan=session.plan)


@router.post("/recommend")
async def recommend_once(body: RecommendRequest) -> dict:
    """The same recommendation in one call, for clients that already know the location and duration."""
    parsed = parse_duration(body.duration)
    if parsed is None:
        raise HTTPException(400, "Couldn't understand the duration. Try '3 hours', 'half day', 'full day' or 'whole weekend'.")
    async with http_client() as client:
        try:
            loc = await geocode(client, body.location)
            plan = await plan_weekend(client, loc, *parsed)
        except LocationNotFound as exc:
            raise HTTPException(400, f"Couldn't find {body.location!r} on the map.") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Couldn't fetch weekend data: {exc}") from exc
    return {**plan, "summary": summarize(plan)}
