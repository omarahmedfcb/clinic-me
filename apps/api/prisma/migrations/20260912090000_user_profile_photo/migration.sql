-- «المستخدمون» review, 2026-09-12: a profile photo for every user, staff and doctors alike.
--
-- On `users`, not on `memberships`: a human has one face across the clinics they work at, the way
-- they have one name and one number. `doctor-shared` in the seed is exactly that person.
--
-- A key, not bytes. The image goes through the `StorageProvider` seam (ARCHITECTURE.md §19) like the
-- logo and the signatures, and the column holds the opaque key it was stored under. NULL means no
-- photo, which the screens draw as initials rather than as a broken image.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "users" ADD COLUMN "photo_storage_key" TEXT;

SELECT set_config('app.current_actor_id', '', false);
