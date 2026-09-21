-- The webhook URL may also be a loopback address, so a sandbox can point at a receiver on the same
-- machine. docs/WHATSAPP-BOT-CONTRACT.md §8.

-- ============================================================================
-- Why loopback is not a hole in the HTTPS rule
--
-- HTTPS is required because a delivery carries a patient's first name and appointment time past
-- every hop between us and the bot. A loopback address has no hops: the packet never leaves the
-- machine, and anything able to read it can already read the process's memory and its database
-- connection.
--
-- The narrower half stays narrow: `BotWebhookDto` still refuses anything but `https://`, so the
-- clinic settings route cannot be pointed at loopback by a person. Only the sandbox provisioner,
-- which runs as a script behind `BOT_SANDBOX=on` and refuses to run with NODE_ENV=production, sets
-- one — and `http://` to a public host is refused by both layers, which is the case that matters.
-- ============================================================================

ALTER TABLE bot_credentials DROP CONSTRAINT bot_credentials_webhook_url_https;

ALTER TABLE bot_credentials
  ADD CONSTRAINT bot_credentials_webhook_url_https
  CHECK (
    webhook_url IS NULL
    OR webhook_url ~ '^https://[^[:space:]]+$'
    OR webhook_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/[^[:space:]]*$'
  );
