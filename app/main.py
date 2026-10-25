from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.status import router as status_router
from app.api.weekend import router as weekend_router
from app.config import settings

app = FastAPI(title=settings.app_name, version=settings.version)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
    max_age=86400,
)
app.include_router(status_router)
app.include_router(weekend_router)
