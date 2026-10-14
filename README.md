# Win Media Studios — Website

Marketing site for Win Media Studios, a Singapore-based content production and
personal branding studio.

## Structure
- `index.html` — the main site (single page, Tailwind via CDN, custom brand styling)
- `studio.html` — the WMS Studio page: sets, rates, terms and the studio booking calendar
- `assets/` — logos, hero image, favicon; `assets/studio/` holds stills from the studio reel
- `apps-script/` — Google Apps Script that powers the homepage discovery-call form
  (writes each booking to a Google Sheet and creates a Google Calendar event)
- `apps-script/studio/` — a separate Apps Script project for studio bookings
  (availability, PayNow and card payments, confirmations). Setup steps are in its README.
- `serve.py` — tiny local static server for development (`python3 serve.py` → http://localhost:3000)

## Booking flows
- **Discovery calls (homepage):** the "Book a call" form posts to a Google Apps Script web app
  (URL set in `index.html` as `SHEETS_ENDPOINT`), which appends a row to the "WMS Lead Tracker"
  sheet and adds a 30-minute event to the calendar.
- **Studio sessions and tours (`studio.html`):** the booking calendar reads live availability from
  the "WMS Studio" Google Calendar through the web app set as `STUDIO_API` in `studio.html`.
  While `STUDIO_API` is empty, or if that server can't be reached, booking falls back to a
  pre-filled WhatsApp message.

## Deployment
Hosted with GitHub Pages — the live site is served from the repo root.
