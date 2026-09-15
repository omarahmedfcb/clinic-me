import { Button } from "../../../design-system/Button.tsx";
import { Card, type Column, DataTable, EmptyState, StatusBadge } from "../../../design-system/display.tsx";
import { ALL_APPOINTMENT_STATUSES } from "../../../domain/appointment-status.ts";
import { formatMinor } from "../../../i18n/format.ts";
import { CURRENCY, type PatientRow, SEEDED_PATIENTS } from "../seed-samples.ts";
import { Row } from "../Row.tsx";

export function BadgesSection() {
  return (
    <Card title="شارات الحالة" subtitle="حالات المواعيد الثمانية كما هي في قاعدة البيانات">
      <Row label="كل الحالات">
        {ALL_APPOINTMENT_STATUSES.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </Row>
    </Card>
  );
}

/**
 * The columns that matter for RTL review:
 *
 * - "المريض" mixes an Arabic name with a Latin phone number in the same cell. This is the single
 *   most common place bidirectional text breaks in practice, so it is deliberately the first
 *   column, at the reader's starting edge.
 * - "المبلغ" is a numeric column aligned to the far edge, which in Arabic is the LEFT.
 * - The two longest names the seed produced are in the data, to stress the column width.
 */
const COLUMNS: ReadonlyArray<Column<PatientRow>> = [
  {
    key: "patient",
    header: "المريض",
    width: "34%",
    render: (row) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-ink">{row.fullName}</span>
        <span className="numeric text-xs text-ink-muted">{row.phoneE164}</span>
      </div>
    ),
  },
  {
    key: "time",
    header: "الموعد",
    render: (row) => <span className="numeric text-ink-muted">{row.time}</span>,
  },
  { key: "service", header: "الخدمة", render: (row) => <span className="text-ink-muted">{row.serviceAr}</span> },
  { key: "address", header: "العنوان", render: (row) => <span className="text-ink-muted">{row.address}</span> },
  { key: "status", header: "الحالة", render: (row) => <StatusBadge status={row.status} /> },
  {
    key: "amount",
    header: "المبلغ",
    align: "end",
    render: (row) => <span className="numeric font-medium">{formatMinor(row.priceMinor, CURRENCY)}</span>,
  },
];

export function TableSection() {
  return (
    <Card
      title="جدول البيانات"
      subtitle="مرضى حقيقيون من بيانات التهيئة — بأطول الأسماء التي وُلّدت"
      padded={false}
      actions={
        <Button size="sm" variant="secondary">
          تصدير
        </Button>
      }
    >
      <DataTable
        columns={COLUMNS}
        rows={SEEDED_PATIENTS}
        rowKey={(row) => row.id}
        caption="قائمة مواعيد اليوم"
      />
    </Card>
  );
}

export function EmptyStateSection() {
  return (
    <Card title="الحالة الفارغة" padded={false}>
      <EmptyState
        title="لا توجد مواعيد اليوم"
        message="لم يتم حجز أي موعد لهذا اليوم بعد. يمكنك حجز موعد جديد أو الاطلاع على جدول الغد."
        action={<Button size="sm">حجز موعد جديد</Button>}
      />
    </Card>
  );
}

/** The same table component with no rows, to prove the empty case is wired, not just designed. */
export function EmptyTableSection() {
  return (
    <Card title="جدول فارغ" subtitle="نفس المكوّن بدون صفوف" padded={false}>
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        empty={
          <EmptyState
            title="لا نتائج للبحث"
            message="لم يُعثر على مريض بهذا الاسم أو رقم الهاتف. جرّب البحث برقم الهاتف كاملًا."
          />
        }
      />
    </Card>
  );
}
