# WMS Studio booking backend

Powers the booking calendar on `studio.html`: live availability from Google Calendar,
PayNow and card payments, confirmation emails and calendar invites.

It's a separate Apps Script project from `apps-script/Code.gs` (the homepage
discovery-call form), so changes here can't break that form.

## One-time setup (about 15 minutes)

1. **Create the project.** Go to [script.google.com](https://script.google.com) → **New project**.
   Name it `WMS Studio Booking`.
2. **Paste the code.** Replace the contents of `Code.gs` with this folder's `Code.gs`.
   Then open **Project Settings (⚙️)** → tick **Show "appsscript.json" manifest file in editor**,
   go back to the editor and replace `appsscript.json` with this folder's version.
3. **Add your PayNow details.** Near the top of `Code.gs`, fill **one** of these in `CFG.PAYNOW`:
   `UEN: '2014xxxxxA'` or `MOBILE: '+6591234567'`. Leave both empty to turn PayNow off.
4. **Run setup.** Pick `setup` in the function dropdown → **Run** → approve the permissions.
   Google warns that the app isn't verified because it's your own script:
   **Advanced** → **Go to WMS Studio Booking**. This creates:
   - a **WMS Studio** Google Calendar
   - a **Studio Bookings** tab in the WMS Lead Tracker sheet
   - a background job every 15 minutes that releases unpaid holds
5. **Card payments (optional).** In Stripe: **Developers → API keys** → copy the **Secret key**.
   Start with the **test** key (`sk_test_…`). In Apps Script: **Project Settings → Script properties
   → Add script property**, name `STRIPE_SECRET_KEY`, paste the key.
   Never put this key in the website.
6. **Deploy.** **Deploy → New deployment → ⚙️ Web app**. *Execute as:* **Me**.
   *Who has access:* **Anyone**. **Deploy**, then copy the URL ending in `/exec`.
7. **Connect the site.** Paste that URL into `STUDIO_API` near the bottom of `studio.html`.

## Test before going live

- **Card:** book a session and pay with Stripe's test card `4242 4242 4242 4242`
  (any future date, any CVC). You should land back on the page with **You're booked**,
  then get the confirmation email and calendar invite.
- **PayNow:** book a session, then **scan the QR with your banking app**. Check that it shows
  Win Media Studios, the right amount and the reference. You don't need to pay. Then change that
  row's **Status** to **PAID** in the sheet and check the client email and invite arrive.
- Delete the test rows and calendar events afterwards.
- When you're happy, swap `sk_test_…` for your live `sk_live_…` key.

## Day to day

| You want to… | Do this |
|---|---|
| Confirm a PayNow payment | When it lands in your bank, change the booking's **Status** to **PAID** in the sheet. The client is emailed their confirmation and calendar invite automatically. |
| Block studio time (a client shoot, maintenance) | Add an event to the **WMS Studio** calendar. Those hours, plus the 1-hour reset either side, disappear from the website. |
| Cancel a booking | Change **Status** to **CANCELLED**. The slot frees up. Refund card payments in Stripe, PayNow by bank transfer. |
| Reschedule | Move the event in the **WMS Studio** calendar; the website follows the calendar. Update the row's Start/End so your records match. |
| Change prices, hours or rules | Edit `CFG` at the top of `Code.gs`, then **Deploy → Manage deployments → ✏️ → New version**. The URL stays the same. Prices in `studio.html` (`RATES` and the rates section) need the same change. |

## What it sends

- **Client:** PayNow instructions when a slot is held, a confirmation and calendar invite when paid,
  and a note if an unpaid hold is released. Tour bookings get an invite straight away.
- **You:** an email for every PayNow hold (so you know to watch for the payment), every card booking,
  and every tour.

Emails go out from your Google account. Personal Gmail allows about 100 recipients a day, which
covers roughly 30 bookings a day.

## Rules it enforces

Bookable 9am–9pm, 7 days, from 24 hours to 60 days ahead. Sessions of 1–4 hours start on the hour,
with a 1-hour reset between bookings. Prices are always calculated on the server. Unpaid PayNow holds
last 12 hours; card checkouts 35 minutes. One person can hold at most 2 unpaid slots at a time.
