import { useState } from "react";
import { Button } from "../../../design-system/Button.tsx";
import { Card, StatusBadge } from "../../../design-system/display.tsx";
import { ConfirmDialog, Drawer, Modal } from "../../../design-system/overlays.tsx";
import { Select, TextInput } from "../../../design-system/fields.tsx";
import { useToast } from "../../../design-system/Toast.tsx";
import { formatMinor } from "../../../i18n/format.ts";
import {
  COMPLAINTS,
  CURRENCY,
  DIAGNOSES,
  DOCTOR_NAME,
  DOCTOR_PHONE,
  DOCTOR_SPECIALTY,
  DOCTOR_TITLE,
  SERVICE_OPTIONS,
} from "../seed-samples.ts";
import { Row } from "../Row.tsx";

export function OverlaySection() {
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();

  return (
    <Card title="النوافذ والتنبيهات" subtitle="افتح كلًا منها وجرّب Esc ومفتاح Tab">
      <div className="flex flex-col gap-5">
        <Row label="النوافذ">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            نافذة منبثقة
          </Button>
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
            لوحة جانبية
          </Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            حذف — مع تأكيد
          </Button>
        </Row>

        <Row label="التنبيهات">
          <Button size="sm" variant="secondary" onClick={() => toast.push("success", "تم حفظ بيانات المريض بنجاح")}>
            نجاح
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toast.push("error", "تعذّر الحفظ — تحقّق من الاتصال")}>
            خطأ
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => toast.push("info", "تم تحديث الجدول — 3 مواعيد جديدة")}
          >
            معلومة
          </Button>
        </Row>
      </div>

      <Modal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title="حجز موعد جديد"
        description="الموعد يُحجز باسم المريض المسجّل بنفس رقم الهاتف."
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => {
                setModalOpen(false);
                toast.push("success", "تم حجز الموعد — الأحد 10:30 ص");
              }}
            >
              تأكيد الحجز
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextInput label="اسم المريض" defaultValue="خديجة صلاح عبد الحميد" />
          <TextInput label="رقم الهاتف" numeric defaultValue="+201060000025" />
          <Select label="الخدمة" options={SERVICE_OPTIONS} defaultValue="follow-up" />
        </div>
      </Modal>

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="ملف الطبيب"
        footer={
          <Button variant="secondary" onClick={() => setDrawerOpen(false)}>
            إغلاق
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-ink">
              {DOCTOR_TITLE} / {DOCTOR_NAME}
            </p>
            <p className="text-sm text-ink-muted">{DOCTOR_SPECIALTY}</p>
            <p className="numeric text-sm text-ink-muted">{DOCTOR_PHONE}</p>
          </div>

          <dl className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-ink-muted">مواعيد اليوم</dt>
              <dd className="numeric font-medium">12</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-ink-muted">إجمالي التحصيل</dt>
              <dd className="numeric font-medium">{formatMinor(184000, CURRENCY)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-ink-muted">الحالة</dt>
              <dd>
                <StatusBadge status="IN_CONSULTATION" />
              </dd>
            </div>
          </dl>

          <div className="border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium text-ink-subtle">آخر الشكاوى المسجّلة</p>
            <ul className="flex flex-col gap-1.5 text-sm text-ink-muted">
              {COMPLAINTS.map((complaint) => (
                <li key={complaint}>• {complaint}</li>
              ))}
            </ul>
          </div>

          <div className="border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium text-ink-subtle">التشخيصات الشائعة</p>
            <ul className="flex flex-col gap-1.5 text-sm text-ink-muted">
              {DIAGNOSES.map((diagnosis) => (
                <li key={diagnosis}>• {diagnosis}</li>
              ))}
            </ul>
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="إلغاء موعد مصطفى محمد عبد العزيز؟"
        message="سيتم إلغاء الموعد المحجوز اليوم الساعة 9:50 ص. لا يمكن التراجع عن هذا الإجراء، وسيُسجَّل في سجل المراجعة."
        confirmLabel="نعم، ألغِ الموعد"
        cancelLabel="تراجع"
        onConfirm={() => toast.push("info", "تم إلغاء الموعد وتسجيله في سجل المراجعة")}
      />
    </Card>
  );
}
