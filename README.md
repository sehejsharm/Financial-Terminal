# 📈 Stock Market Analyst

A personal, **educational** stock-market dashboard. It is for personal research
and learning only — it does **not** give buy/sell advice.

You have two ways to use it. Pick one.

---

## Option A — Run it as a free website (easiest, recommended)

This puts your dashboard at a web link you can open from any device, anytime.
No coding. About 5 minutes, one time.

1. Go to **https://share.streamlit.io** and click **Sign in with GitHub**
   (use the same GitHub account this code is saved under).
2. Click **Create app** → **Deploy a public app from GitHub**.
3. Fill in:
   - **Repository:** `sehejsharm/financial-terminal`
   - **Branch:** `claude/stock-market-dashboard-2BBMA`
   - **Main file path:** `app.py`
4. Click **Advanced settings → Secrets** and paste this (fill in your keys):
   ```
   ANTHROPIC_API_KEY = "paste-your-anthropic-key-here"
   FRED_API_KEY = "paste-your-fred-key-here"
   ```
   Both are optional — the app still runs without them, you just won't get the
   AI write-ups (Anthropic) or the macro/economy numbers (FRED).
5. Click **Deploy**. After a minute you'll get a link like
   `https://your-app.streamlit.app`. **Bookmark it** — that's your dashboard,
   open it whenever you want.

> Free apps "go to sleep" after a while of no use. If it shows a sleeping
> screen, just click **"Yes, get this app back up!"** and wait ~30 seconds.

---

## Option B — Run it on your own computer

1. **Install Python** (one time): https://www.python.org/downloads/
   - On Windows, tick **"Add Python to PATH"** during install.
2. **Start the app:**
   - **Mac:** double-click **`run.sh`**
     (if it opens as text, right-click → Open With → Terminal, or run
     `bash run.sh`).
   - **Windows:** double-click **`run.bat`**.
3. The first run sets things up automatically, then your browser opens the
   dashboard. To stop it, close the black window.

### Adding your keys (optional, for AI + macro data)
A file named **`.env`** is created automatically the first time. Open it with
any text editor and paste your keys:
```
ANTHROPIC_API_KEY=your-anthropic-key
FRED_API_KEY=your-fred-key
```
Save the file and restart the app. Your keys stay only on your computer — they
are never uploaded or shared.

---

## What's inside

- **Market Pulse** — indices, sectors, top movers, headlines
- **Stock Analyzer** — company snapshot, quality gauges, key stats, AI analysis
- **ETF Analyzer** — risk, holdings, sector mix, cheaper-fund finder
- **Macro** — economic indicators and the yield curve
- **Portfolio** — track your holdings, returns, allocation, and risk
- **News** — market and per-company headlines

---

*This dashboard is for educational and informational purposes only. It is not
financial advice, not a recommendation to buy or sell any security, and is not
personalized to your situation. Consult a licensed advisor before making
investment decisions.*
