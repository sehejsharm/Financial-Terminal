@echo off
REM Double-click this file (Windows) to start Stock Market Analyst.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed.
  echo Get it from https://www.python.org/downloads/ and tick "Add Python to PATH".
  echo Then run this file again.
  pause
  exit /b
)

if not exist .venv (
  echo First-time setup: creating environment ^(one time only^)...
  python -m venv .venv
)

echo Installing/updating components (can take a minute the first time)...
.venv\Scripts\python -m pip install --upgrade --no-cache-dir pip setuptools wheel
.venv\Scripts\python -m pip install --prefer-binary --no-cache-dir -r requirements.txt

if not exist .env if exist .env.example copy .env.example .env >nul

echo Starting Stock Market Analyst... your browser will open shortly.
.venv\Scripts\python -m streamlit run app.py
pause
