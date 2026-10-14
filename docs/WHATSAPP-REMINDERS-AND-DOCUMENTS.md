# WhatsApp reminders, "go to the room", and the visit documents link

Three messages the platform sends on its own initiative. Every one is **off per clinic** until the
owner or an admin switches it on in Settings → *Automatic WhatsApp messages*
(`GET/PUT /clinic-settings/messaging`, `clinicSettings.manage`).

| Message | When | Template (Arabic) | Switch |
|---|---|---|---|
| Reminder with **Confirm / Cancel** buttons | `reminder_lead_hours` (default 5) before the appointment | `appointment_reminder_confirm`, or `appointment_reminder` when it will not cancel | `appointment_reminders_enabled` |
| Cancellation notice | the patient did not confirm within `reminder_confirm_window_hours` (default 2) | `appointment_auto_cancelled` | with reminders |
| "Go to room N" | the doctor starts the consultation | free text inside the 24 h window, `patient_call_in` otherwise | `call_in_message_enabled` |
| Link to the visit documents | the visit is completed | `visit_documents` (URL button) | `visit_documents_link_enabled` |

Meta bills every one of these to **the clinic's own WhatsApp Business Account** (a Tech Provider has no
credit line), so nothing here keeps a quota or meters usage.

## The reminder rules

`src/modules/whatsapp/reminder-plan.ts` is the whole policy, as one pure function with its reasoning above it.

- **Quiet hours.** Never sent between 21:00 and 08:00 clinic time; it waits for 08:00.
- **The cancel deadline** is `min(sent + confirm window, start − 30 min)`. If that leaves the patient less than
  an hour to answer, the reminder is still sent but **nothing is cancelled**.
- **No reminder** is sent when it would arrive less than an hour before the appointment.
- **Booked at short notice** (less than lead + window ahead): reminded, never auto-cancelled.
- **Already CONFIRMED by reception** (and walk-ins): reminded, never auto-cancelled.
- A tap on **Cancel** frees the slot at once. A tap on **Confirm** moves `BOOKED → CONFIRMED`.
- A reschedule closes the old reminder and a new one is made for the new time.
- A patient with **no WhatsApp consent** on file is skipped (`skipped_reason = NO_CONSENT`). Consent is currently
  recorded only by the bot; a patient created at the desk who never wrote to the bot will not be messaged.

## How it runs: one worker, no Redis

`scripts/outbound-messages.ts` runs one pass: queue due reminders → cancel the unanswered → send everything owed.
It is safe to overlap or run twice; the database (unique keys, guarded `UPDATE`s) owns exactly-once.
The appointment itself is the only record of "a reminder is due", so a moved or cancelled appointment simply stops
matching, and there is no queue to keep in step. Two messages (`CALL_IN`, `VISIT_DOCUMENTS`) are written by a
trigger on `appointment_events`, so no code path that completes a visit can forget to enqueue the documents.

Retry is per message: reminders retry until their own expiry; the cancellation notice and documents retry for
hours; "go to the room" retries once after a minute. A message given up on raises a **notification** to the desk
(`WHATSAPP_MESSAGE_FAILED`) and an audit row.

## Server setup (Ubuntu 22.04, pm2, nginx, no Docker)

### 1. Deploy order matters: web first

The PDF is made by Chromium opening the web app's `/d/<token>?print=…` page. Deploy the web app (Vercel) **before**
the API starts creating PDFs.

### 2. Migrate, then restart the API

```bash
cd /path/to/clinic-me/apps/api
npm ci
npx prisma migrate deploy      # two new migrations
pm2 restart <your-api-process>
```

### 3. Chromium for PDFs

The host has 1.7 GB of RAM. The renderer allows **one render at a time**, launches the browser per render and
closes it straight after, and caches PDFs for 20 minutes, so memory returns to the machine between downloads.
You already have 2 GB of swap, which is the safety net.

```bash
sudo apt-get update
sudo apt-get install -y fonts-noto-core fonts-noto-ui-core fonts-noto-color-emoji   # Arabic text
sudo mkdir -p /opt/pw-browsers
cd /path/to/clinic-me/apps/api
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright-core install --with-deps chromium
sudo chmod -R a+rX /opt/pw-browsers
```

Then give the API process the path, and the address of the web app:

```bash
# in your pm2 ecosystem file (or the environment pm2 starts the API with)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
PUBLIC_APP_URL=https://app.nomed-os.com
```

Run the API as a normal user (not root): Chromium's sandbox works that way without extra flags.
`pm2 restart <api> --update-env` after changing the environment.

### 4. The worker, under pm2

```bash
cd /path/to/clinic-me/apps/api
OUTBOUND_INTERVAL_MS=30000 pm2 start npm --name clinic-os-outbound -- run outbound:messages
pm2 save
pm2 logs clinic-os-outbound      # one line per pass: queued / sent / retrying / failed / skipped:<reason>
```

It needs the same environment as the API (database URL, `WHATSAPP_*`, `JWT_SECRET`, …). Without
`OUTBOUND_INTERVAL_MS` it runs one pass and exits, which is what you want from cron.

### 5. nginx

Nothing for Chromium (it only makes outbound HTTPS calls). For the public link, rate-limit the path so the PDF route
cannot be looped. Inside the `http {}` block and your `api.nomed-os.com` server:

```nginx
limit_req_zone $binary_remote_addr zone=docs:10m rate=30r/m;

location /public/visit-documents/ {
    limit_req zone=docs burst=20 nodelay;
    proxy_pass http://127.0.0.1:3000;          # whatever your other locations proxy to
    proxy_read_timeout 60s;                    # a first PDF takes a few seconds
}
```

The API also rate-limits per IP (60 page loads and 10 PDFs a minute) and refuses a PDF with a 503 if more than three
are already waiting.

### 6. Templates, once per clinic

Templates belong to the clinic's WhatsApp Business Account. After a clinic's number is connected:

```bash
cd /path/to/clinic-me/apps/api
PUBLIC_APP_URL=https://app.nomed-os.com npm run whatsapp:templates -- <tenantId>
npm run whatsapp:templates -- <tenantId> --status     # PENDING → APPROVED, usually minutes, up to a day
```

A message is only delivered once its template is `APPROVED`. Before that the send fails with Meta's
"template does not exist" error, is not retried, and the desk gets a notification. A clinic running on the `.env`
test number has no stored WABA id; submit the five templates in WhatsApp Manager instead (texts in
`src/modules/whatsapp/whatsapp-templates.ts`). Meta will not let an approved template be edited: changing the wording
means a new `name`.

## The documents link

`https://app.nomed-os.com/d/<token>` — no login, the address is the credential.

- 256-bit random token, **only its SHA-256 is stored**, valid 30 days, revocable
  (`visit_document_links.revoked_at`). A retried send gets a fresh token and revokes the previous one.
- Every refusal (malformed, unknown, expired, revoked, not yet completed) is the same 404.
- The payload is a **new narrow DTO**: what the printed sheets already print, and nothing else — no private notes,
  history, revision counters, or price-adjustment reasons. It reads finished visits only.
- The **invoice is rendered live**: it shows what has been paid *now*, not what was owed when the doctor finished.
- Responses are `no-store`, `noindex`, `no-referrer`.
- PDFs are produced by the same React sheets the doctor prints, so the patient's PDF is the doctor's paper.
