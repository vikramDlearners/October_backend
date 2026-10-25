from fastapi import FastAPI

from app.api.status import router as status_router
from app.api.weekend import router as weekend_router
from app.config import settings

app = FastAPI(title=settings.app_name, version=settings.version)
app.include_router(status_router)
app.include_router(weekend_router)
