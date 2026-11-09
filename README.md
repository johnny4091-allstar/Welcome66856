# TripLedger — Mileage Tracker & IRS Logbook

An installable web app (PWA) that tracks your driving with GPS, lets you categorize trips, and generates IRS-style mileage logs for tax deductions or employer reimbursement. No server or account is needed: all data stays on your device.

## Features

**Track**
- One-tap **START / STOP** GPS trip recording
- **Auto-track**: starts a trip when you drive faster than a set speed (default 15 mph) and ends it after you've been stopped for a few minutes
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
- Printable / **Save-as-PDF** log with date, times, start/end location, purpose, odometer, miles, rate and amount, plus signature lines
- **Excel (CSV)** export and native **Share** sheet on phones
- Business-use **percentage split** for the actual-expenses method
- Separate reports per vehicle or workplace
- Editable rates (defaults: 2026 IRS rates of 72.5¢ business, 20.5¢ medical, 14¢ charity; check these on irs.gov)
- Weekly or monthly reporting reminders
- Saved places: trips starting or ending near one are labeled with its name
- JSON backup and restore

## Run it

These are static files with no build step. Serve the folder over HTTPS (needed for GPS on phones), for example with GitHub Pages or Netlify, or run this locally:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

On your phone, open the site and choose **Add to Home Screen** to install it.

## Limitations of a web app

- **Background tracking:** browsers stop GPS when the app isn't on screen. TripLedger keeps the screen awake while tracking, so keep it open in a car mount. True background auto-detection, like the commercial apps have, needs a native iOS/Android app (for example a React Native or Capacitor wrapper with background-location permissions).
- Locations show as coordinates unless you save the place or edit the name. No third-party geocoding is used, so your location data stays private.
- Teams/manager approval, iBeacon detection and cloud sync need a backend and native app. They are natural next steps.

This app is a record-keeping tool, not tax advice.
