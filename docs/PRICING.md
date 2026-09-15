# AI Clinic OS — Pricing & Unit Economics

**Version 0.2 — 19 August 2026**
**Market:** Egypt (first market)
**Status:** Working model. Numbers are estimates with stated ranges, not quotes. Verify hosting and payment-gateway pricing before committing.

---

## 1. The Constraint That Sets Everything

Before any pricing discussion, one number matters more than the rest:

> **A clinic sending ~900 WhatsApp messages a month costs roughly $20–30 to serve.**

Breakdown at ~30 reminders/day:

| Component | USD / clinic / month |
|---|---|
| WhatsApp utility messages (~900) | 10–15 |
| AI tokens + Meta Business Agent fee | 3–8 |
| Payment gateway (~2.5%) | ~1 |
| Share of infrastructure | ~6 |
| **Total variable cost** | **$20–30** ≈ 1,000–1,500 EGP |

Two things follow, and both are load-bearing.

**First: message quotas are mandatory, not a nice-to-have.** An unlimited-WhatsApp tier below roughly 1,500 EGP loses money on every active clinic, and loses more the more the clinic uses it. That is the worst possible shape for a business — success accelerates the loss.

**Second: the competitor headline price is not a price.** A published tier at 599 EGP (~$12) sits *below* this cost floor. It is a hook. This matches the observation that quoted prices rise at contract time through add-ons. Competing against a hook price on the hook price is a losing game.

**Also note the date.** From 1 October 2026 Meta begins charging for utility templates and service-window messages that are free today. Any model built on today's free window is already obsolete. The figures above assume the post-October regime.

---

## 2. Positioning: Transparency as the Differentiator

Since the market's listed prices are not real, the opening is to publish real ones.

- Every tier's message allowance stated on the pricing page.
- Overage rate published, not disclosed at invoice time.
- Setup fee published, not "discussed later."
- No feature quietly gated after signature.

This is not just ethics; it is a sales weapon in a market where clinic owners have already been burned. It also fits the product philosophy — a system a receptionist understands in ten minutes should not have a bill she cannot understand.

---

## 3. Pricing Structure — One Plan, Priced by Size

**No tiers. Every clinic gets every feature.** Price is driven by the two things that drive cost: doctors and messages.

| Component | Price |
|---|---|
| Base fee per clinic (includes 1 doctor + 1,000 messages) | **1,500 EGP / month** |
| Each additional doctor (+700 messages) | **900 EGP / month** |
| Messages beyond allowance | **1 EGP each**, published |
| Setup (migration + training), one time | **3,500 EGP** |
| Annual billing | **15% discount** |

### Why this beats tiers

Cost is close to linear in doctors and messages. Tiers force a step function onto a linear cost curve, which guarantees some customers are overcharged and others are served at a loss.

The test is whether margin stays flat across clinic sizes:

| Doctors | Monthly bill | Margin | Margin % | EGP per doctor |
|---|---|---|---|---|
| 1 | 1,500 | $11 | 37% | 1,500 |
| 2 | 2,400 | $19 | 41% | 1,200 |
| 3 | 3,300 | $28 | 43% | 1,100 |
| 5 | 5,100 | $45 | 44% | 1,020 |
| 8 | 7,800 | $70 | 45% | 975 |

Margin holds between 37% and 45% across an 8x range of clinic size. The previous tier model swung from 64% to 36% — a distortion, not a strategy.

Effective price per doctor falls from 1,500 to 975 as the clinic grows. The large clinic feels a volume discount; margin improves anyway because the base fee already covers the fixed per-clinic cost.

### Weak point: the solo doctor

At 37%, the single-doctor clinic is the thinnest case — and the largest market segment. Two levers if it proves too thin in practice: reduce the base allowance to 700 messages, or raise the base fee. Do not fix it by removing features; equal access is the point of this structure.

### Message bundling is the largest cost lever in the product

Unbundled, the Layer 1 feature set generates 4.55 messages per visit:

| | Messages |
|---|---|
| Appointment reminder | 1.00 |
| Booking confirmation | 1.00 |
| Prescription secure link | 1.00 |
| Payment request | 1.00 |
| Queue / your-turn notification | 0.25 — **opt-in, see below** |
| Follow-up recall | 0.30 |

Combining reminder with confirmation, and prescription with payment request, brings this to **2.55 — a 44% cost reduction with no loss of value to the patient.** Bundling is therefore a product requirement, not an optimisation. Every new outbound message type must justify why it cannot ride along with an existing one.

**The your-turn notification is the one line above that cannot bundle, and it is therefore opt-in — ruled 2026-09-03.** It is time-critical and fires mid-visit, so it can never ride along with the reminder or with the prescription-plus-payment message; it is the only row in the table that fails the bundling requirement outright and is kept anyway. If it were always-on its rate would be **1.00, not 0.25**, taking the bundled figure from 2.55 to **3.30 — plus 29% per visit**, and landing it on the single-doctor clinic at 37% margin that this document already names as the thinnest case. The 1,000-message base allowance covers roughly 390 visits at 2.55 and roughly 303 at 3.30.

So the message is **a per-clinic setting, default OFF**, and **the pricing page must state what switching it on costs.** That is what keeps 0.25 honest: it was always a blended average across clinics, and an opt-in feature is precisely the thing a blended average correctly describes. A clinic whose waiting room is small enough that everyone hears their name called gains nothing from it and should not be paying for it by default. See `docs/PHASE-4.md` Q20 for the queued-intent design and the per-message-type retry policy.

### Quota transparency is a build requirement

A clinic at 20 visits per doctor per day generates roughly double the modelled volume. An 8-doctor clinic in that range needs ~10,600 messages against a 5,900 allowance — a bill of 12,508 EGP against an expected 7,800.

**Mitigation, built in Phase 1, not later:** in-app usage meter, a warning at 80% of allowance, and a second at 100%. A customer who watches the number climb is informed. A customer who discovers it on an invoice is the hidden-fee experience this product is positioned against.

### Presentation

Publish a calculator, not a price list: *"How many doctors?"* → the number. This removes the perceived complexity of usage-based pricing at the point where it matters — the moment a clinic owner decides whether to call.

### Seat-sharing

Per-doctor pricing invites clinics to share one doctor login. Make sharing expensive for *them* rather than policing it: bind the prescribing doctor to the prescription, the signature, and the clinical audit trail. A shared login produces wrong records under the wrong doctor's name, which no clinic wants.

## 4. Break-Even

Fixed monthly cost after launch is $230 (hosting, Claude, tooling). At a weighted average margin of $21.95 per clinic across the modelled size mix:

**Break-even ≈ 11 clinics.**

That is a genuinely reachable first milestone and should be the target for the six months after pilot.

The longer arc is less comfortable:

| Clinics | Monthly gross margin |
|---|---|
| 11 | $0 (break-even) |
| 25 | ~$320 |
| 50 | ~$870 |
| 150 | ~$3,060 |
| 300 | ~$6,355 |

At the modelled growth rate — 4 new clinics a month against 3% monthly churn — the projection reaches 44 clinics by month 12 and 89 by month 36, where churn and acquisition roughly cancel. Cumulative three-year net is around $46,000, **excluding the founder's own time.**

That churn-acquisition ceiling is the most important line in the projection. Growing past ~90 clinics requires either more than 4 signings a month or churn below 3% — and improving retention is almost always the cheaper lever.

**This is a volume business.** It needs 150–300 clinics to produce a real income in Egypt, and that is two to three years of sales work, not development work. The product is the easy half.

---

## 5. Why Expansion Is the Model, Not an Option

The same product in Kuwait at 30 KWD/month earns roughly $98 — more than twice the Egyptian Pro tier and about five times the Clinic tier, for identical engineering and near-identical serving cost.

| | Egypt | Kuwait |
|---|---|---|
| Typical monthly price | ~$44 | ~$98 |
| Variable cost | ~$18 | ~$20 |
| Margin per clinic | ~$22 | ~$78 |
| Clinics needed for $3,500/mo | ~168 | ~48 |

**Twenty Kuwaiti clinics ≈ seventy Egyptian ones.**

This is not an argument against starting in Egypt. Egypt is cheaper to pilot in, the product owner is present, and a system proven on 5 Egyptian clinics is proven. But it does reframe the plan: **Egypt validates the product; the Gulf pays for it.** Expansion should be scheduled, not left as a someday.

This is why §18b of ARCHITECTURE.md exists. Currency, timezone, phone parsing, and tax rules are abstracted now precisely because the second market is part of the plan rather than a hypothetical.

---

## 6. Two Risks to Price Into the Contract

### Currency exposure

Costs are in USD (Claude, hosting, WhatsApp, AI). Revenue is in EGP. USD/EGP traded between roughly 46.5 and 54.8 over the last 52 weeks — an 18% band.

A 15% devaluation turns the Clinic tier's $26 margin into roughly $18 without a single thing changing operationally.

**Mitigation:** an annual price-review clause in the subscription agreement from the very first clinic. Included at signature it is boilerplate; introduced in year two it is a negotiation with an incumbent customer who will resist.

### Withholding tax

If the contracting entity is Rahal Group FZE (UAE), Egyptian business customers are generally required to withhold 20% at source on payments to a non-resident, recoverable only through a refund claim requiring embassy-legalised documents.

Applied to a $45 blended subscription, that is $9 off every payment — margin falls from $22.43 to $13.44, a **40% reduction**.

At 50 clinics that is roughly $450 a month, or $5,400 a year. **The arithmetic pays for an Egyptian entity inside the first year**, before considering that most small clinics will not correctly operate the withholding at all — which converts a tax problem into a compliance problem sitting on the customer's side of the relationship.

The `Assumptions` sheet in the financial model has a withholding-rate cell so both structures can be compared directly.

---

## 7. Pilot Pricing

Pilot clinics pay **nothing**, but they sign something.

Free access is not free to deliver — each pilot clinic consumes onboarding, training, and support hours from a very limited weekly budget. What is being purchased with that time is evidence, so the exchange should be explicit:

- A named person at the clinic responsible for using the system daily
- A weekly 20-minute feedback call for the pilot period
- Permission to be named as a reference and to publish anonymised usage data
- Written acknowledgement that pricing begins at the end of the pilot period, at a stated founding-cohort rate

A pilot clinic that will not commit to a weekly call will not give useful feedback either. Better to find that out before investing the onboarding hours.

---

## 8. What Would Change This Model

Revisit pricing if any of these move:

- Meta's October 2026 pricing lands materially above estimate
- USD/EGP breaks outside the 46–55 band
- Pilot clinics use 3× the assumed message volume — quotas were set too low
- A competitor publishes genuinely transparent pricing, removing the differentiator
- The Egyptian entity decision changes the withholding position

Each of these is a single cell in the model. Change it and read the result rather than re-deriving the argument.

---

*Companion file: `clinic-os-financial-model.xlsx` — edit the blue cells on the Assumptions sheet; everything else recalculates.*
