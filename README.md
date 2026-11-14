# Kestrel Player — IPTV playlist player for Android TV and phones

Kestrel plays **your own** IPTV playlist: an Xtream Codes login or an M3U link from your provider. It is a player only and doesn't provide, host or sell any channels or content.

## Features

**Live TV**
- Categories, channel list with logos, and a **now/next guide** with a progress bar (Xtream)
- Native full-screen player (Media3/ExoPlayer) for MPEG-TS, HLS and DASH streams
- **Channel zapping**: press ▲/▼ or CH+/CH− on the remote while watching
- Favourites and recently watched channels
- Live format switch (MPEG-TS or HLS) for channels that won't play

**Movies & series**
- Poster grids by category, details with plot, cast and rating
- **Resume** where you stopped, plus a "Continue watching" row
- Seasons and episodes, with the next episode playing automatically

**Everything else**
- Several playlists, switched in Settings; Xtream account expiry and connections shown
- Search across channels, movies and series
- **Parental lock**: a 4-digit PIN locks chosen categories
- 8 accent colours
- Built for the **TV remote** (D-pad navigation, shows in the Android TV / Google TV launcher) and for touch screens
- **Self-updating**: checks this repo's latest GitHub release and installs new versions after checking their SHA-256

## Install

1. Download `KestrelPlayer.apk` from the [latest release](https://github.com/johnny4091-allstar/Welcome66856/releases/latest).
   - **Android TV / Fire TV:** install the Downloader app, then enter
     `https://github.com/johnny4091-allstar/Welcome66856/releases/latest/download/KestrelPlayer.apk`
2. Allow **Install unknown apps** when asked.
3. Open Kestrel Player → **Add a playlist** → enter your Xtream server, username and password (or an M3U link).

## Updates

Every push to the `ccr-84635385-2frt1x` branch makes GitHub Actions build the APK and publish a release `v1.0.<run>` with two files:

- `KestrelPlayer.apk`
- `version.json`, the manifest the app reads: `{ versionCode, versionName, url, sha256, notes }`

On launch (at most every 6 hours, or from Settings → Updates → Check now) the app fetches `releases/latest/download/version.json`. If `versionCode` is higher than the installed one, it offers **Update now**. It downloads the APK, refuses it unless the SHA-256 matches, and opens Android's installer. The first time, Android asks you to allow Kestrel to install apps.

The repository must be public for the app to download releases.

## Build it yourself

Requires Node 22, JDK 21 and the Android SDK (platform 36).

```bash
npm install
npm run build:release        # -> android/app/build/outputs/apk/release/app-release.apk
```

The app is signed with `android/app/kestrel-sideload.keystore` (password `kestrel`), which is committed so every build installs as an update over the last. **Before publishing to Google Play, create your own private key and keep it out of git.**

`www/` also runs in a desktop browser for UI work (`npx http-server www`), but most IPTV servers block browser requests (CORS), so real playback needs the Android app.

## Project layout

- `www/` — the app UI (HTML/CSS/JS, no build step)
- `android/` — the native Android project (Capacitor)
  - `PlayerActivity.java` — full-screen ExoPlayer with channel zapping
  - `PlayerPlugin.java` — opens the player from the UI and returns the resume position
  - `UpdaterPlugin.java` — downloads, verifies and installs updates
- `.github/workflows/android.yml` — builds the APK and publishes releases
