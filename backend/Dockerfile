# Pinned to the stable "bookworm" base, not the floating "3.12-slim" tag.
# That tag moved upstream to a "trixie" (Debian 13, still-testing) base at
# some point; trixie's package mirrors are far less globally cached than
# bookworm's, and a routine apt-get on this VM's limited bandwidth went
# from ~5s to over an hour pulling packages from it — looked exactly like a
# hung build. Bookworm is stable and well-mirrored everywhere.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# No apt-get / build-essential: every dependency (curl_cffi, pandas, numpy,
# etc.) ships a prebuilt manylinux wheel for this platform — verified with
# `pip install --only-binary=:all:`. Skipping the apt layer entirely removes
# both the trixie-mirror risk above and several minutes of compile time,
# and ca-certificates already ships in the base python image.
COPY requirements.txt requirements-backend.txt ./
# Wheels-only for the heavy tree (keeps the build compiler-free and fast);
# pywebpush separately because its pure-Python dep http-ece is sdist-only —
# no compiler needed, it just can't pass --only-binary.
RUN grep -v "^pywebpush" requirements-backend.txt > /tmp/req-backend-wheels.txt \
    && pip install --only-binary=:all: -r requirements.txt -r /tmp/req-backend-wheels.txt \
    && pip install "pywebpush>=2.0"

# Source comes last so dep installs stay cached on code changes.
COPY backend ./backend
COPY lib ./lib

EXPOSE 8000

# --limit-concurrency: shed load with an immediate 503 instead of queueing
# forever once the box is saturated — keeps /healthz and login answering
# even if some data endpoint goes pathological. Raised from 48 → 256 because
# each long-lived /stream WebSocket holds a concurrency slot for its whole
# life; idle sockets are I/O-bound and cheap, but at 48 they'd starve REST.
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", \
     "--limit-concurrency", "256"]
