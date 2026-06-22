# Win Media Studios — Website

Marketing site for Win Media Studios, a Singapore-based content production and
personal branding studio.

## Structure
- `index.html` — the entire site (single page, Tailwind via CDN, custom brand styling)
- `assets/` — logos, hero image, favicon
- `apps-script/` — Google Apps Script that powers the booking form
  (writes each booking to a Google Sheet and creates a Google Calendar event)
- `serve.py` — tiny local static server for development (`python3 serve.py` → http://localhost:3000)

## Booking flow
The "Book a call" form posts to a Google Apps Script web app (URL set in
`index.html` as `SHEETS_ENDPOINT`), which appends a row to the
"WMS Lead Tracker" sheet and adds a 30-minute event to the calendar.

## Deployment
Hosted with GitHub Pages — the live site is served from `index.html` at the repo root.
