#!/usr/bin/env bash
# Double-click this file (Mac/Linux) to start Stock Market Analyst.
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed."
  echo "Install it from https://www.python.org/downloads/ then run this again."
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d .venv ]; then
  echo "First-time setup: creating environment (one time only)..."
  python3 -m venv .venv
fi

echo "Installing/updating components (can take a minute the first time)..."
.venv/bin/python -m pip install --quiet --upgrade pip setuptools wheel
.venv/bin/python -m pip install --quiet --prefer-binary -r requirements.txt

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created a .env file - open it later to paste your API keys (optional)."
fi

echo "Starting Stock Market Analyst... your browser will open shortly."
.venv/bin/python -m streamlit run app.py
