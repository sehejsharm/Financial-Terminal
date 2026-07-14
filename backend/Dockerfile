FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Build deps (curl_cffi needs gcc; remove after pip install to keep image small).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-backend.txt ./
RUN pip install -r requirements.txt -r requirements-backend.txt \
    && apt-get purge -y build-essential && apt-get autoremove -y

# Source comes last so dep installs stay cached on code changes.
COPY backend ./backend
COPY lib ./lib

EXPOSE 8000

# --limit-concurrency: shed load with an immediate 503 instead of queueing
# forever once the box is saturated — keeps /healthz and login answering
# even if some data endpoint goes pathological.
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", \
     "--limit-concurrency", "48"]
