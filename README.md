# TripLedger — Mileage Tracker & IRS Logbook

An Android app that tracks your driving with GPS, lets you categorize trips, and generates IRS-style mileage logs for tax deductions or employer reimbursement. No server or account is needed: all data stays on your device.

## Features

**Track**
- One-tap **START / STOP** GPS trip recording
- **Auto-track** (works in the background): starts a trip when you drive faster than a set speed (default 15 mph) and ends it after you've been stopped for a few minutes
- Odometer readings per trip and per vehicle
- Multiple vehicles, plus workplace or client fields on each trip
- **Holiday mode** pauses auto-tracking

**Categorize**
- Business / Personal / Medical / Charity, with one-tap buttons for unclassified trips
- **Working hours**: trips that start inside your hours become Business, the rest Personal
- Business purpose, notes and tags on each trip
- Bulk-edit categories, search and filter by period, vehicle or category
- Split a trip in two at a stop

**Report**
- **PDF** log with date, times, start/end location, purpose, odometer, miles, rate and amount, plus signature lines
- **Excel (CSV)** export; both open the Android share sheet (email, Drive, WhatsApp…)
- Business-use **percentage split** for the actual-expenses method
- Separate reports per vehicle or workplace
- Editable rates (defaults: 2026 IRS rates of 72.5¢ business, 20.5¢ medical, 14¢ charity; check these on irs.gov)
- Weekly or monthly reporting reminders (Android notifications)
- Saved places: trips starting or ending near one are labeled with its name
- JSON backup and restore

## Install on your phone

1. Download [`release/TripLedger-1.0.apk`](release/TripLedger-1.0.apk) to your Android phone (Android 7.0+).
2. Open it and allow **Install unknown apps** for your browser or file manager when asked.
3. Open TripLedger. When asked, allow **Location** and **Notifications**.
4. For auto-tracking, go to Android Settings → Apps → TripLedger → Battery → **Unrestricted**, so Android doesn't stop tracking to save battery.

While a trip is recording or auto-track is on, a "TripLedger" notification stays visible. That foreground service keeps GPS running with the screen off or another app open. If you swipe TripLedger away from recent apps, tracking stops until you open it again.

## Build the APK yourself

Requires Node 22, JDK 21 and the Android SDK (platform 36).

```bash
npm install
npm run build:release        # -> android/app/build/outputs/apk/release/app-release.apk
```

GitHub Actions (`.github/workflows/android.yml`) also builds the APK on every push. Download it from the run's **Artifacts**.

The app is signed with `android/app/tripledger-sideload.keystore` (password `tripledger`), which is committed so every build installs as an update over the last. **Before publishing to Google Play, create your own private key and keep it out of git.** To release an update, bump `versionCode` in `android/app/build.gradle`.

## Project layout

- `www/` — the app UI (HTML/CSS/JS), also runs as a website
- `android/` — the native Android project (Capacitor)
- Native plugins: background geolocation (foreground service), filesystem + share (PDF/CSV export), local notifications (report reminders)

## Not included yet

- Address lookup: locations show as coordinates unless you save the place or type a name, so no location data leaves the phone.
- Teams/manager approval, iBeacon detection and cloud sync need a backend server.
- iPhone: `npx cap add ios` creates the project, but building it requires a Mac with Xcode.

This app is a record-keeping tool, not tax advice.
