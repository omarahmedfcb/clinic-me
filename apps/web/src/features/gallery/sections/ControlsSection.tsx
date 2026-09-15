import { Button } from "../../../design-system/Button.tsx";
import { Card } from "../../../design-system/display.tsx";
import { Spinner } from "../../../design-system/Spinner.tsx";
import { SearchField, Select, Textarea, TextInput } from "../../../design-system/fields.tsx";
import { SERVICE_OPTIONS, TREATMENT_PLAN } from "../seed-samples.ts";
import { Row } from "../Row.tsx";

const PLUS_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export function ButtonsSection() {
  return (
    <Card title="الأزرار" subtitle="أربعة أنماط، ثلاثة أحجام، وكل الحالات">
      <div className="flex flex-col gap-5">
        <Row label="الأنماط">
          <Button variant="primary">حجز موعد</Button>
          <Button variant="secondary">تعديل</Button>
          <Button variant="ghost">عرض التفاصيل</Button>
          <Button variant="danger">إلغاء الموعد</Button>
        </Row>

        <Row label="الأحجام">
          <Button size="sm">صغير</Button>
          <Button size="md">متوسط</Button>
          <Button size="lg">كبير</Button>
        </Row>

        <Row label="مع أيقونة">
          <Button icon={PLUS_ICON}>مريض جديد</Button>
          <Button variant="secondary" icon={PLUS_ICON}>
            إضافة خدمة
          </Button>
        </Row>

        <Row label="جارٍ التحميل">
          <Button loading>حفظ الكشف</Button>
          <Button variant="secondary" loading>
            جارٍ البحث
          </Button>
          <Button variant="danger" loading>
            إلغاء
          </Button>
        </Row>

        <Row label="معطّل">
          <Button disabled>حجز موعد</Button>
          <Button variant="secondary" disabled>
            تعديل
          </Button>
          <Button variant="ghost" disabled>
            عرض التفاصيل
          </Button>
          <Button variant="danger" disabled>
            إلغاء الموعد
          </Button>
        </Row>

        <Row label="بعرض كامل">
          <div className="w-full max-w-sm">
            <Button fullWidth>تأكيد الحجز</Button>
          </div>
        </Row>
      </div>
    </Card>
  );
}

export function FieldsSection() {
  return (
    <Card title="حقول الإدخال" subtitle="التسمية والتلميح والخطأ، مع أرقام لاتينية داخل نص عربي">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextInput label="اسم المريض" placeholder="الاسم الثلاثي" defaultValue="مصطفى محمد عبد العزيز" required />
        <TextInput
          label="رقم الهاتف"
          numeric
          defaultValue="+201060000093"
          hint="يُحفظ بصيغة E.164 — الرقم يظل من اليسار لليمين داخل نص عربي"
        />
        <TextInput
          label="الرقم القومي"
          numeric
          defaultValue="2980112"
          error="الرقم القومي يجب أن يتكون من 14 رقمًا"
        />
        <TextInput label="البريد الإلكتروني" placeholder="اختياري" disabled defaultValue="غير متاح" />
        <Select label="الخدمة" options={SERVICE_OPTIONS} placeholder="اختر الخدمة" required />
        <Select label="الطبيب" options={[{ value: "1", label: "د. هشام محمود الديب" }]} disabled />
        <div className="sm:col-span-2">
          <Textarea label="خطة العلاج" defaultValue={TREATMENT_PLAN} hint="يظهر للطبيب فقط" rows={3} />
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-ink">حقل البحث</p>
          <SearchField defaultValue="مصطفى" />
        </div>
      </div>
    </Card>
  );
}

export function SpinnerSection() {
  return (
    <Card title="مؤشر التحميل">
      <Row label="الأحجام">
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
        <Spinner size="md" tone="muted" />
      </Row>
    </Card>
  );
}
