-- Human support on WhatsApp: a patient who asks for a person is sent to ONE receptionist's number
-- (a wa.me link) instead of the bot going silent on the chat.
--
-- Which receptionist is chosen in the Users tab. A bare uuid, no foreign key: the value is checked
-- on every read (an ACTIVE RECEPTIONIST of this clinic) and anything else counts as "not chosen".
-- NULL means nobody was chosen, in which case a clinic with exactly one active receptionist uses
-- that person.
--
-- `conversations.bot_paused_until` stays: a staff reply from the WhatsApp Business app (coexistence)
-- still silences the bot on that one chat, now for 2 hours instead of 4.

ALTER TABLE tenants
  ADD COLUMN human_support_membership_id uuid;
