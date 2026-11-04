# AI Clinic OS — Pricing

**Ruled 2026-10-26 and 2026-10-30; supersedes the earlier model in this file** (version 0.2 of
19 August 2026: one plan, a 1,500 EGP base plus 900 EGP per extra doctor). That model's numbers are
gone from this file, not kept beside the new ones: two models in one document is how the wrong one
gets quoted.

**Market:** Egypt (first market). **The single source for the public price** is
`apps/marketing/src/config.ts`. This file rules the model; that file carries the number shown on the
site, and it changes only after this one does.

---

## 1. The model

**Three packages, priced only by doctor count.** Every module is in every package. A clinic's package
is decided by how many doctors it has, and by nothing else.

| Package | Doctors | Monthly price | Storage cap | AI-scribe hours cap |
|---|---|---|---|---|
| 1 | 1–3 | open (§4) | open | open |
| 2 | 4–8 | open | open | open |
| 3 | 9+ | open | open | open |

- **Caps, and overage paid.** Each package carries a storage cap and an AI-scribe hours cap. Usage
  beyond either is billed at a published overage rate, never a surprise at invoice time (§2).
- **Facility type is not a price.** Clinic, specialised centre and polyclinic are a separate property
  of the clinic. It enables screens and never changes the price. **The hospital tier is dropped.**
- **Multi-branch is a paid add-on**, priced separately from the doctor-count package. The operator sets
  `max_branches` per clinic, and the clinic admin creates branches up to it (`BRANCHES-DESIGN.md` §9).
  `tenants.branches_enabled_at` is retained, unused, as the likely record of when a clinic started
  paying for it.
- **Lab and pharmacy are out of scope for now**, to be costed separately later.
- **The subscription is always adjustable by the operator.** The package, caps, add-ons and price for
  a clinic can be changed from the console at any time.

## 2. Positioning: transparency as the differentiator

The market's listed prices are hooks that rise at contract time through add-ons. The opening is to
publish real ones:
- every package's price, caps and overage rates on the pricing page;
- the multi-branch add-on's price published;
- no module gated after signature, since every package has every module.

This is not just ethics. It is a sales weapon in a market where clinic owners have already been
burned, and it fits the product: a system a receptionist understands in ten minutes should not have a
bill nobody at the desk can understand.

**Usage transparency is a build requirement.** An in-app meter for storage and AI-scribe hours, with a
warning at 80% of a cap and a second at 100%. A customer who watches the number climb is informed; a
customer who discovers it on an invoice gets the hidden-fee experience this product is positioned
against.

## 3. The cost floor, and the levers that still apply

**WhatsApp is the largest variable cost.** A clinic sending around 900 messages a month costs roughly
$20–30 to serve once Meta's October 2026 pricing applies, which charges for utility templates and
service-window messages that are free today. Any package priced near that floor loses money on its
most active clinics.

**Message bundling is the largest cost lever in the product.** Unbundled, the Layer 1 features
generate 4.55 messages per visit. Combining reminder with confirmation, and prescription with payment
request, brings this to **2.55**, a 44% reduction with no loss to the patient. Bundling is a product
requirement: every new outbound message type must justify why it cannot ride along with an existing
one. The your-turn notification cannot bundle, so it is **opt-in, default OFF** (ruled 2026-09-03),
and the pricing page must state what switching it on costs. See `PHASE-4.md` Q20.

**Seat-sharing.** Pricing by doctor count invites clinics to share one doctor login. Sharing is made
expensive for the clinic rather than policed: the prescribing doctor is bound to the prescription,
the signature and the clinical audit trail, so a shared login produces wrong records under the wrong
doctor's name.

## 4. Open: numbers not yet ruled

The model above is ruled; these values are not. Each one is a decision, not a calculation, and none is
filled in here until it is made:
- the monthly price of each package;
- each package's storage cap and AI-scribe hours cap, and the overage rate for each;
- **whether WhatsApp messages carry a per-package allowance.** §3's cost floor says unlimited messages
  below the floor lose money, and the 2026-10-30 ruling names only storage and AI-scribe caps;
- the multi-branch add-on's price, and whether it is per branch;
- a setup fee and an annual discount, if any;
- the public "starting from" price. `PRICE_FROM_EGP` in `apps/marketing/src/config.ts` is 1,500, the
  old model's base fee, and is wrong until package 1's price is ruled. That file is on the unmerged
  #115 branch, not on `develop`.

Until the prices are ruled, the operator console's computed plan line (`apps/api/src/modules/platform/plan.ts`)
still computes the superseded model, and is wrong. It is to be replaced when the prices are set; see
`PILOT-READINESS.md`, where "plan is computed, never stored" is amended by the adjustable subscription.

## 5. Why expansion is the model, not an option

The same product in Kuwait earns roughly twice the Egyptian revenue per clinic for identical
engineering and near-identical serving cost. Egypt is cheaper to pilot in, the product owner is
present, and a system proven on Egyptian clinics is proven: **Egypt validates the product; the Gulf
pays for it.** This is why `ARCHITECTURE.md` §18b abstracts currency, time zone, phone parsing and tax
rules now. Revenue figures here are recomputed once §4's prices are ruled.

## 6. Two risks to price into the contract

**Currency exposure.** Costs are in USD (Claude, hosting, WhatsApp, AI); revenue is in EGP, which
traded in an 18% band against the dollar over the last 52 weeks. Mitigation: an annual price-review
clause in the subscription agreement from the very first clinic. At signature it is boilerplate; in
year two it is a negotiation.

**Withholding tax.** If the contracting entity is Rahal Group FZE (UAE), Egyptian business customers
generally withhold 20% at source on payments to a non-resident, recoverable only through a refund claim
with embassy-legalised documents. The arithmetic pays for an Egyptian entity inside the first year.

## 7. Pilot pricing

Pilot clinics pay **nothing**, but they sign something: a named person responsible for daily use, a
weekly 20-minute feedback call, permission to be named as a reference and to publish anonymised usage,
and written acknowledgement that pricing begins at the end of the pilot at a stated founding-cohort
rate.

## 8. What would change this model

Revisit if any of these move: Meta's October 2026 pricing lands materially above estimate; USD/EGP
breaks outside its band; pilot clinics use far more storage, AI-scribe time or messages than the caps
assume; a competitor publishes genuinely transparent pricing; the Egyptian entity decision changes the
withholding position.
