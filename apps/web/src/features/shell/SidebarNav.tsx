import { CircleHelp } from "lucide-react";
import { useLocale } from "../../i18n/locale-context.tsx";
import { cx } from "../../lib/cx.ts";
import { BUILD_VERSION } from "../auth/BuildStamp.tsx";
import { NavIcon, NAV_ICON_SIZE, NAV_ICON_STROKE } from "./nav-icons.tsx";
import type { visibleNavItems } from "./navigation.ts";

const isPlainLeftClick = (event: React.MouseEvent): boolean =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);

export function SidebarNav({
  items,
  currentKey,
  onNavigate,
  className,
}: {
  items: ReturnType<typeof visibleNavItems>;
  currentKey: string | null;
  onNavigate: (path: string) => void;
  className?: string;
}) {
  const { t } = useLocale();

  return (
    <nav aria-label={t("shell.nav.sectionLabel")} className={className}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.key}>
            {item.path === undefined ? (
              <span
                aria-disabled="true"
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-subtle cursor-default select-none"
              >
                <NavIcon navKey={item.key} />
                <span className="flex-1">{t(item.key)}</span>
                <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-ink-muted">
                  {t("shell.nav.comingSoon")}
                </span>
              </span>
            ) : (
              <a
                href={item.path}
                aria-current={currentKey === item.key ? "page" : undefined}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  onNavigate(item.path as string);
                }}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                  currentKey === item.key
                    ? "bg-primary font-medium text-white"
                    : "text-ink-muted hover:bg-primary-soft hover:text-primary",
                )}
              >
                <NavIcon navKey={item.key} />
                <span className="flex-1">{t(item.key)}</span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SidebarFoot({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const { t } = useLocale();

  return (
    <div className="border-t border-border p-3">
      <a
        href="/help"
        className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-primary-soft hover:text-primary"
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          onNavigate("/help");
        }}
      >
        <CircleHelp
          size={NAV_ICON_SIZE}
          strokeWidth={NAV_ICON_STROKE}
          aria-hidden="true"
          className="shrink-0"
        />
        <span className="flex-1">{t("shell.nav.help")}</span>
      </a>
      <p className="numeric px-3 pt-2 text-[11px] text-ink-subtle">
        {BUILD_VERSION}
      </p>
    </div>
  );
}
