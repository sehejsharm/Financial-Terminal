# Motherboard Terminal — Mobile

There are two ways to run this app on a phone. Pick one.

## Option A — Install as a PWA (easiest, no app store, already live)

The deployed site (`frontend/public/manifest.json` + `src/app/layout.tsx`)
already ships a web app manifest, icons, and a service worker. On any phone:

- **Android (Chrome):** open the site → menu (⋮) → **Add to Home screen**.
- **iOS (Safari):** open the site → Share → **Add to Home Screen**.

It launches full-screen, uses the app icon, and (via `public/sw.js`) can
receive push notifications for price alerts. No build step needed — this
works today against whatever URL the frontend is deployed to.

## Option B — Native iOS/Android app via Capacitor

This wraps the same deployed web app in a real native shell, buildable into
an `.ipa`/`.apk` for TestFlight/Play Store. It does **not** re-bundle the
frontend — `capacitor.config.ts` points the native shell at the live
production URL, so the native app always reflects whatever is deployed to
Vercel (same auth, same live quotes, same backend).

### One-time setup

```bash
cd frontend
npm install                # installs @capacitor/core, @capacitor/ios, @capacitor/android
```

The native projects (`frontend/ios/`, `frontend/android/`) are already
scaffolded and committed. `capacitor.config.ts` controls the URL they load —
override it with the `CAPACITOR_SERVER_URL` env var if you want a native
build pointed at a preview/staging deployment instead of production:

```bash
CAPACITOR_SERVER_URL=https://your-preview.vercel.app npx cap sync
```

### Build & run

```bash
npm run cap:sync      # copies config + syncs native plugins after any change
npm run cap:ios        # opens the project in Xcode (macOS + Xcode required)
npm run cap:android    # opens the project in Android Studio
```

From there, build/run/archive as you would for any native project:

- **iOS:** Xcode → select a simulator or device → Run. For TestFlight/App
  Store, set your signing team under *Signing & Capabilities*, then
  **Product → Archive**. Requires an Apple Developer account.
- **Android:** Android Studio → Run on an emulator/device, or
  **Build → Generate Signed Bundle/APK** for a Play Store release.

### Notes

- App id: `com.motherboard.terminal` — change it in `capacitor.config.ts`
  and re-run `npx cap sync` if you need a different bundle identifier.
- Because the shell just loads the live URL, there's no separate mobile
  deploy pipeline: shipping to Vercel updates the web app *and* the
  installed native app on next launch.
- Push notifications for alerts currently go through the web
  service worker (`public/sw.js`), which also works inside the Capacitor
  WebView. Native push (APNs/FCM) would need the `@capacitor/push-notifications`
  plugin — not set up yet.
