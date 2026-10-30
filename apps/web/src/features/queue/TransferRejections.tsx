import type { Dispatch, SetStateAction } from "react";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { interpolate } from "../../i18n/interpolate.tsx";
import type { Transfer } from "../transfers/transfers-api.ts";

export function TransferRejections({
  rejections,
  setRejections,
}: {
  rejections: Transfer[];
  setRejections: Dispatch<SetStateAction<Transfer[]>>;
}) {
  const { t } = useLocale();
  return (
    <>
      {rejections.map((rejected) => (
        <div
          key={rejected.id}
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <span className="flex-1">
            {/*
              Three substituted values, two of them Arabic names, inside a sentence that is English
              when the interface is. Built with interpolate() so each one is isolated -- with
              .replace() the names appeared to swap places and the banner accused the wrong doctor.
            */}
            {interpolate(t("transfer.rejectedBanner"), {
              patient: rejected.patientName,
              doctor: rejected.toDoctorName,
              reason: rejected.decisionNote ?? "—",
            })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRejections((current) => current.filter((item) => item.id !== rejected.id))}
          >
            {t("transfer.rejectedBanner.dismiss")}
          </Button>
        </div>
      ))}
    </>
  );
}
