# Onboarding kit

Pilot-readiness 5a–5d: what the vendor's onboarding person does before a clinic's first day, and the
two scripts that put a receptionist and a doctor to work.

**Who this is for.** Setup is done by *us*, on the clinic's behalf, not by a doctor sitting at the
screen (`CLAUDE.md`). The copy in the product assumes that and so does this kit: nothing below asks
the clinic to configure anything before their first patient.

Four parts:

| | |
|---|---|
| §1 | **5a** — the clinic setup checklist, in the order the screens take it |
| §2 | **5b** — the ten-minute receptionist script |
| §3 | **5c** — the ten-minute doctor script |
| §4 | **5d** — the rule that we create the first administrator |

> **The bar these are written against**: ten minutes to competence, measured on somebody who has
> never seen the product. **That measurement has not been taken yet** — see §5. The scripts are built
> to be timed, with numbered steps and a stated target per section, so the first run produces a
> number rather than an impression.

---

## 1. Clinic setup checklist (5a)

The order matters: each step below is blocked by the one above it. Working out of order is the most
common way a setup session stalls, because the screen that needs the missing thing does not say what
is missing — it simply has an empty list.

### Before the session

- [ ] **Create the clinic in the platform console** — name, country, currency, timezone — and the
      first ADMIN with a one-time password (§4). Nothing else can happen before this exists.
- [ ] Confirm the clinic's **timezone** with them out loud. Every appointment time in the product is
      rendered in it, and it is not editable on the clinic's own screens.
- [ ] Ask for the clinic's **letterhead facts**: Arabic and English name, address, phones, tax and
      commercial register numbers. Printed documents are English (Q45) and print bare without them.

### In the session, in this order

1. **Settings → the clinic's identity** (`/settings`). Name, address, phones, and the letterhead
   fields. Upload the logo here.
   *Blocks*: every printed prescription, sick note and receipt.
2. **Doctors** (`/doctors`). One row per doctor: name, title, specialty, licence number.
   *Blocks*: everything below. A clinic with no doctor row cannot be booked into at all.
   - **Decision that stops progress**: does this doctor sign their own prescriptions? Their
     signature and stamp are uploaded here, and a prescription prints without them if they are not.
3. **Services** (`/services`). Name, duration, price.
   - **Decision that stops progress**: *a service with no price cannot be booked.* Ask for the price
     list before the session; "we will decide later" means that service does not exist yet.
   - A follow-up is usually a separate service with its own duration and price, not a discount on
     the first one.
4. **Schedules** (`/schedules`). Weekly templates per doctor, then exceptions for leave.
   - **Decision that stops progress**: *a doctor with no schedule has no bookable slots*, and the
     booking screen will show an empty day with no explanation. Set at least one week.
   - Ask about the clinic's real working week — Friday is the common day off, not Sunday.
5. **Staff** (`/users`). One account per person, with a role: RECEPTIONIST, DOCTOR, ADMIN. Each gets
   a temporary password they must change at first sign-in.
   - **One person holds one role per clinic.** An owner who also works the desk is a decision to
     take out loud, not a second membership to create quietly.
6. **Insurance companies** (`/settings`), if the clinic takes insurance. Reception picks from this
   list; an empty list means every patient is recorded as self-pay.
7. **Seed the first day, together.** Book two or three of tomorrow's real appointments with the
   receptionist driving. This is the step that turns a configured clinic into a working one.

### Hand over

- [ ] The receptionist has signed in, changed their password, and booked an appointment **themselves**.
- [ ] The doctor has signed in, opened a visit, and printed one prescription **themselves**.
- [ ] They know how to reach us, and who "us" is.

---

## 2. Receptionist script (5b) — target 10 minutes

Run it on the review build or the clinic's own, with the receptionist holding the mouse. Read the
step, let them do it, correct nothing that does not matter.

**Minutes 0–2 — the day.**
1. Sign in. Change the password when asked.
2. «اليوم» is the day view: today's appointments, in order.
3. Point out the queue badge and that the screen refreshes itself every fifteen seconds. There is no
   refresh button to hunt for.

**Minutes 2–5 — a patient arrives.**
4. Find them: search by phone number first — it is exact — then by name.
5. **One number, several patients** is normal here. The search shows the household; pick the person.
6. Not found? «مريض جديد» — name, phone, date of birth, gender, nationality. The file shows «ملف
   ناقص» until those are filled, which is a badge, not a blocker.
7. Mark them arrived. They appear in «قائمة الانتظار».

**Minutes 5–8 — booking the next one.**
8. Book from the patient's file or from the day view: doctor, service, day, slot.
9. If the slot list is empty, the doctor has no schedule that day — that is a schedule question, not
   a booking problem.
10. A slot taken between offer and confirm answers «الموعد لم يعد متاحًا». Re-list and offer another;
    nothing is double-booked.

**Minutes 8–10 — money.**
11. After the visit, «المدفوعات» shows what is owed. Record cash, card or transfer.
12. A receipt prints in English, with the clinic's letterhead.
13. **Where reception stops**: diagnosis, examination, notes and prescriptions are the doctor's.
    They are not hidden from the desk by a filter — they are not on the desk's screens at all.

**Check they can do it unaided**: find a patient by phone, register a new one, mark arrived, book a
follow-up, record a payment. If any step needed prompting, that is the step to repeat.

---

## 3. Doctor script (5c) — target 10 minutes

**Minutes 0–2 — the queue.**
1. Sign in. Change the password when asked.
2. «قائمة الانتظار» is who is waiting, oldest first, with how long they have waited.
3. «ابدأ الكشف» starts the consultation. The patient moves out of the waiting list for everybody.

**Minutes 2–6 — the visit.**
4. The visit opens with the patient's history beside it: previous visits, allergies, chronic
   conditions.
5. Complaint, examination, diagnosis, plan. It saves as you type; there is no save button to lose.
6. **Allergies are worth thirty seconds of the session.** Recorded once, they warn on every future
   prescription.

**Minutes 6–9 — the prescription.**
7. Medication is free text with autocomplete from this clinic's own history — it is not a drug
   database, and it does not check doses.
8. Print. The sheet is English, with the clinic's letterhead and the doctor's signature and stamp if
   those were uploaded.
9. A sick note is the same shape, and prints the same way.

**Minutes 9–10 — finishing.**
10. «إنهاء الكشف» completes the visit and sends the patient to reception for payment.
11. A completed visit is **amended, never edited**: the original stays and the amendment is recorded
    beside it with a reason. That is deliberate, and it is what makes the record defensible.

**Check they can do it unaided**: start a consultation, write and print a prescription, complete the
visit. If they hesitate anywhere, that is the step to repeat.

---

## 4. The first administrator is created by us (5d)

**There is no self-serve signup, and there should not be one before PDPL is settled.**

A clinic exists because an operator created it in the platform console: name, country, currency and
timezone, one ADMIN membership, and a temporary password shown **once** and never readable again.
The new administrator cannot sign in without changing it (`must_change_password`).

Three reasons this is a rule rather than a convenience:

1. **Data residency and consent are commitments we make, not a checkbox a stranger ticks.** Patient
   data and backups never leave Egypt; agreeing to that on a signup form is not agreement.
2. **The first ADMIN is the clinic's root of trust.** Every other account in that clinic is created
   by them, so handing that identity to whoever filled in a form is the one mistake with no
   recovery path.
3. **A clinic that is set up wrongly does not fail loudly** — it shows empty lists. Doing setup
   ourselves is what keeps §1's ordering from being discovered by a receptionist at 9am.

The console is therefore the product's only creation path, and it is behind an operator account with
a second factor. `docs/PILOT-READINESS.md` §0b carries the same rule from the engineering side.

---

## 5. What has not been measured

**Nobody has yet run §2 or §3 against a stopwatch with a person who has not seen the product.** The
ten-minute target is `ARCHITECTURE.md`'s bar and `PRICING.md` treats staff turnover erasing training
as a listed risk — so the number matters, and an untimed script is an estimate wearing a number.

The first pilot onboarding is the measurement. Record, for each script: how long it took, which step
needed prompting, and which step they got wrong without noticing. The third is the important one — a
step somebody completes incorrectly and confidently is a screen problem, not a training problem.
