import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { fetchSignupConfig, submitSignup, type SignupConfig, type SignupFailure } from "./signup-api.ts";
import { launchEmbeddedSignup, loadFacebookSdk } from "./meta-signup.ts";

// Self-contained and bilingual like WebchatPage: a clinic here has no session, and the clinic app's
// i18n table is for screens behind a login.
const FAILURES: Record<SignupFailure, string> = {
  INVALID_PHONE: "رقم الموبايل غير صحيح. / One of the phone numbers is not valid.",
  OWNER_PHONE_TAKEN: "رقم الموبايل ده مسجّل بالفعل، سجّل الدخول بدل كده. / That phone number already has an account; sign in instead.",
  NUMBER_ALREADY_CONNECTED: "رقم الواتساب ده مربوط بعيادة تانية. / That WhatsApp number is already connected to a clinic.",
  META_CODE_REJECTED: "انتهت صلاحية الربط مع ميتا، حاول تاني من الأول. / The Meta authorisation expired; please start again.",
  META_NUMBER_MISMATCH: "تعذّر التأكد من رقم الواتساب مع ميتا. / We could not confirm that WhatsApp number with Meta.",
  META_SETUP_FAILED: "ميتا رفضت إعداد الرقم. جرّب تاني أو كلّمنا. / Meta could not finish setting up the number. Try again or contact us.",
  INVALID_FIELD: "راجع البيانات المكتوبة (كلمة السر 12 حرف على الأقل). / Please check the details (password: 12+ characters).",
  RATE_LIMITED: "محاولات كتير، جرّب بعد شوية. / Too many attempts; try again later.",
  UNKNOWN: "حصل خطأ. حاول تاني. / Something went wrong. Please try again.",
};

const EMPTY = {
  clinicName: "", clinicNameEn: "", address: "", clinicPhone: "", ownerFullName: "", ownerPhone: "", password: "",
};

export function SignupPage() {
  const [config, setConfig] = useState<SignupConfig | null | undefined>(undefined);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [done, setDone] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void fetchSignupConfig().then(setConfig, () => setConfig(null));
  }, []);

  const set = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const complete =
    form.clinicName.trim() && form.address.trim() && form.clinicPhone.trim() &&
    form.ownerFullName.trim() && form.ownerPhone.trim() && form.password.length >= 12;

  async function connect(): Promise<void> {
    if (!config || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const fb = await loadFacebookSdk(config.appId, config.graphVersion);
      const outcome = await launchEmbeddedSignup(fb, config.configId);
      if (outcome.kind !== "done") {
        setMessage(outcome.kind === "error" ? FAILURES.UNKNOWN : undefined);
        return;
      }
      const result = await submitSignup({
        ...form,
        clinicNameEn: form.clinicNameEn.trim() || undefined,
        ...outcome.result,
      });
      if (result.ok) setDone(result.displayPhoneNumber);
      else setMessage(FAILURES[result.failure]);
    } catch {
      setMessage(FAILURES.UNKNOWN);
    } finally {
      setBusy(false);
    }
  }

  if (config === undefined) {
    return <div className="flex min-h-dvh items-center justify-center bg-surface-sunken"><Spinner size="lg" /></div>;
  }

  if (done !== undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-sunken p-4">
        <div className="w-full max-w-md space-y-3 rounded-2xl border border-border-strong bg-surface p-6 text-center">
          <h1 className="text-lg font-semibold text-ink">تم إنشاء العيادة / Your clinic is ready</h1>
          <p className="text-sm text-ink" dir="auto">
            {done ? `${done} — ` : ""}البوت شغّال على رقم الواتساب. سجّل الدخول برقم موبايلك وكلمة السر.
          </p>
          <p className="text-sm text-ink" dir="ltr">The bot is live on your WhatsApp number. Sign in with your phone and password.</p>
          <Button onClick={() => window.location.assign("/")}>دخول / Sign in</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-border-strong bg-surface p-6">
        <h1 className="text-lg font-semibold text-ink">سجّل عيادتك / Register your clinic</h1>
        {config === null && <p className="text-sm text-danger">{FAILURES.UNKNOWN}</p>}

        <TextInput label="اسم العيادة / Clinic name" value={form.clinicName} onChange={set("clinicName")} required />
        <TextInput label="Clinic name (English, optional)" value={form.clinicNameEn} onChange={set("clinicNameEn")} dir="ltr" />
        <TextInput label="العنوان / Address" value={form.address} onChange={set("address")} required />
        <TextInput label="تليفون العيادة / Clinic phone" value={form.clinicPhone} onChange={set("clinicPhone")} numeric required />
        <TextInput label="اسم المسؤول / Your name" value={form.ownerFullName} onChange={set("ownerFullName")} required />
        <TextInput label="موبايلك / Your mobile" value={form.ownerPhone} onChange={set("ownerPhone")} numeric required />
        <TextInput label="كلمة السر / Password (12+)" type="password" value={form.password} onChange={set("password")} required />

        {message && <p className="text-sm text-danger" dir="auto">{message}</p>}

        <Button onClick={() => void connect()} loading={busy} disabled={!complete || config === null}>
          اربط واتساب وأنشئ العيادة / Connect WhatsApp & create clinic
        </Button>
      </div>
    </div>
  );
}
