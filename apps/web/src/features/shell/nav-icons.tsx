// One icon per existing nav item. Item 4 of the 2026-09-15 rebrand.

import {
  Banknote,
  BriefcaseMedical,
  CalendarDays,
  CalendarRange,
  ClipboardList,
  FileClock,
  LayoutGrid,
  Settings,
  Stethoscope,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * **Exactly the items that already exist — nothing added, nothing renamed.**
 *
 * The brief was explicit that the sidebar's sections stay as they are, so this is a lookup keyed by
 * the existing `NAV_ITEMS` keys rather than a second list of sections. `shell-navigation.spec.ts`
 * already fails when a route belongs to no item; `brand.spec.ts` fails when an item has no icon,
 * so the two lists cannot drift apart in either direction.
 *
 * All 20px at stroke 1.75 — lucide's default is 2, which reads heavy beside 14px Arabic text at
 * this size. One stroke width for every icon, because a sidebar where two icons disagree about
 * weight looks like a rendering bug rather than a design.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  "shell.nav.today": LayoutGrid,
  "shell.nav.appointments": CalendarRange,
  "shell.nav.queue": ClipboardList,
  "shell.nav.patients": Users,
  "shell.nav.visits": Stethoscope,
  "shell.nav.payments": Wallet,
  "shell.nav.schedules": CalendarDays,
  "shell.nav.services": BriefcaseMedical,
  "shell.nav.doctors": UsersRound,
  "shell.nav.users": UsersRound,
  "shell.nav.reports": Banknote,
  "shell.nav.audit": FileClock,
  "shell.nav.settings": Settings,
};

export const NAV_ICON_SIZE = 20;
export const NAV_ICON_STROKE = 1.75;

export function NavIcon({ navKey }: { navKey: TranslationKey }) {
  const Icon = NAV_ICONS[navKey];
  if (Icon === undefined) return null;
  // Decorative: the item's own label is right beside it and is the accessible name.
  return <Icon size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} aria-hidden="true" className="shrink-0" />;
}
