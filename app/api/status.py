import time
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

router = APIRouter(tags=["status"])

_started_at = time.monotonic()


class StatusResponse(BaseModel):
    status: str
    app: str
    version: str
    environment: str
    uptime_seconds: float
    timestamp: datetime


@router.get("/status", response_model=StatusResponse)
def get_status() -> StatusResponse:
    return StatusResponse(
        status="ok",
        app=settings.app_name,
        version=settings.version,
        environment=settings.environment,
        uptime_seconds=round(time.monotonic() - _started_at, 3),
        timestamp=datetime.now(timezone.utc),
    )
