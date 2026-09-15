import { Card } from "../../design-system/display.tsx";
import { ButtonsSection, FieldsSection, SpinnerSection } from "./sections/ControlsSection.tsx";
import { BadgesSection, EmptyStateSection, EmptyTableSection, TableSection } from "./sections/DataSection.tsx";
import { OverlaySection } from "./sections/OverlaySection.tsx";
import { CLINIC_ADDRESS, CLINIC_NAME, RECEPTIONIST_NAME } from "./seed-samples.ts";

/**
 * The component gallery.
 *
 * PHASE-1.md: "not optional and not decoration. It is reviewed once so styling problems are found
 * in one sitting rather than rediscovered on twelve screens." Every primitive the design system
 * owns appears here, in Arabic, right-to-left, using strings taken from the seeded database.
 */
export function GalleryPage() {
  return (
    <div className="min-h-screen bg-surface-sunken">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-6 py-6">
          <p className="text-xs font-medium text-primary">معرض المكونات — Clinic OS</p>
          <h1 className="text-xl font-bold text-ink">{CLINIC_NAME}</h1>
          <p className="text-sm text-ink-muted">{CLINIC_ADDRESS}</p>
          <p className="mt-1 text-xs text-ink-subtle">
            الاستقبال: {RECEPTIONIST_NAME} · جميع النصوص من بيانات التهيئة الحقيقية، لا نص بديل
          </p>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
        <Card title="ملاحظة للمراجعة">
          <ul className="flex list-inside list-disc flex-col gap-1.5 text-sm leading-relaxed text-ink-muted">
            <li>
              الاتجاه من اليمين لليسار هو الوضع الافتراضي، مضبوط على <code className="numeric">&lt;html dir=&quot;rtl&quot;&gt;</code>{" "}
              قبل أول رسم — وليس مفتاحًا يمكن تبديله.
            </li>
            <li>
              كل التنسيقات تستخدم الخصائص المنطقية (<code className="numeric">ps-</code> /{" "}
              <code className="numeric">pe-</code> / <code className="numeric">inset-inline</code>) لا يمين/يسار
              ثابتين.
            </li>
            <li>
              الأرقام لاتينية ومعزولة باتجاه <code className="numeric">ltr</code> داخل النص العربي — لاحظ عمود
              &quot;المريض&quot; في الجدول.
            </li>
          </ul>
        </Card>

        <ButtonsSection />
        <FieldsSection />
        <BadgesSection />
        <TableSection />
        <OverlaySection />
        <EmptyStateSection />
        <EmptyTableSection />
        <SpinnerSection />

        <p className="pb-4 text-center text-xs text-ink-subtle">
          المرحلة الأولى — نقطة المراجعة الرابعة، الجزء الأول
        </p>
      </main>
    </div>
  );
}
