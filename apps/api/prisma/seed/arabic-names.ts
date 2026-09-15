/**
 * Egyptian Arabic name pools for seeded patients.
 *
 * Why real names matter here: the entire UI is Arabic and RTL-first, and Latin placeholder names
 * ("Test Patient 47") silently hide the problems this data exists to expose -- line-height and
 * baseline issues with Arabic glyphs, text that overflows a fixed-width cell once it is twice as
 * long, sorting that looks arbitrary, and mixed-direction rendering when a name sits next to a
 * Latin-digit phone number. A seeded database full of Latin names would let a broken RTL layout
 * pass review.
 *
 * Composition follows the ordinary Egyptian convention: given name, father's given name, then
 * family name -- "محمد أحمد الشناوي". Two-part names are common in practice too, so a minority of
 * seeded patients get one.
 */

/**
 * One name, in both scripts.
 *
 * `en` is **how the name is ordinarily written in Latin script in Egypt** -- the passport and
 * school-certificate spelling -- not a systematic transliteration of `ar`. The two disagree
 * constantly and the difference is the point: محمد is written Mohamed here, not the more literal
 * Muhammad, because Mohamed is what a receptionist types and what appears on the patient's own
 * documents. جرجس is Guirguis, following the French-influenced convention Egyptian records use,
 * not the Girgis a letter-by-letter mapping would give.
 *
 * That distinction matters for D19. `full_name_en` holds what a human entered. `name_search_latin`
 * will hold a mechanical transliteration of the Arabic name, and those two will *not* agree for
 * most names -- which is exactly why D19 has the search column absorb both.
 */
export interface EgyptianName {
  ar: string;
  /** The spelling an Egyptian would actually write, not a transliteration. */
  en: string;
}

export const MALE_GIVEN_NAMES: readonly EgyptianName[] = [
  { ar: "محمد", en: "Mohamed" },
  { ar: "أحمد", en: "Ahmed" },
  { ar: "محمود", en: "Mahmoud" },
  { ar: "مصطفى", en: "Mostafa" },
  { ar: "خالد", en: "Khaled" },
  { ar: "عمرو", en: "Amr" },
  { ar: "هشام", en: "Hisham" },
  { ar: "طارق", en: "Tarek" },
  { ar: "شريف", en: "Sherif" },
  { ar: "ياسر", en: "Yasser" },
  { ar: "وليد", en: "Walid" },
  { ar: "سامح", en: "Sameh" },
  { ar: "هاني", en: "Hany" },
  { ar: "إيهاب", en: "Ihab" },
  { ar: "تامر", en: "Tamer" },
  { ar: "كريم", en: "Karim" },
  { ar: "عصام", en: "Essam" },
  { ar: "رامي", en: "Ramy" },
  { ar: "أيمن", en: "Ayman" },
  { ar: "حسام", en: "Hossam" },
  { ar: "مينا", en: "Mina" },
  { ar: "بيشوي", en: "Bishoy" },
  { ar: "جرجس", en: "Guirguis" },
  { ar: "عماد", en: "Emad" },
  { ar: "صلاح", en: "Salah" },
  { ar: "فتحي", en: "Fathy" },
  { ar: "رفعت", en: "Refaat" },
  { ar: "نبيل", en: "Nabil" },
  { ar: "سيد", en: "Sayed" },
  { ar: "جمال", en: "Gamal" },
];

export const FEMALE_GIVEN_NAMES: readonly EgyptianName[] = [
  { ar: "فاطمة", en: "Fatma" },
  { ar: "عائشة", en: "Aisha" },
  { ar: "مريم", en: "Mariam" },
  { ar: "نورا", en: "Nora" },
  { ar: "هبة", en: "Heba" },
  { ar: "دينا", en: "Dina" },
  { ar: "رانيا", en: "Rania" },
  { ar: "منى", en: "Mona" },
  { ar: "سلمى", en: "Salma" },
  { ar: "ياسمين", en: "Yasmin" },
  { ar: "هدى", en: "Hoda" },
  { ar: "أميرة", en: "Amira" },
  { ar: "شيماء", en: "Shaimaa" },
  { ar: "نهى", en: "Noha" },
  { ar: "إيمان", en: "Eman" },
  { ar: "سارة", en: "Sara" },
  { ar: "مي", en: "May" },
  { ar: "ولاء", en: "Walaa" },
  { ar: "غادة", en: "Ghada" },
  { ar: "إنجي", en: "Engy" },
  { ar: "مادلين", en: "Madeleine" },
  { ar: "مارينا", en: "Marina" },
  { ar: "نيفين", en: "Nevine" },
  { ar: "سماح", en: "Samah" },
  { ar: "عبير", en: "Abeer" },
  { ar: "أسماء", en: "Asmaa" },
  { ar: "زينب", en: "Zeinab" },
  { ar: "خديجة", en: "Khadija" },
  { ar: "رحمة", en: "Rahma" },
  { ar: "آية", en: "Aya" },
];

export const FAMILY_NAMES: readonly EgyptianName[] = [
  { ar: "عبد الرحمن", en: "Abdelrahman" },
  { ar: "السيد", en: "El Sayed" },
  { ar: "حسن", en: "Hassan" },
  { ar: "إبراهيم", en: "Ibrahim" },
  { ar: "عبد العزيز", en: "Abdelaziz" },
  { ar: "الشناوي", en: "El Shennawy" },
  { ar: "فهمي", en: "Fahmy" },
  { ar: "زكي", en: "Zaki" },
  { ar: "رشدي", en: "Roshdy" },
  { ar: "الديب", en: "El Deeb" },
  { ar: "عبد الله", en: "Abdallah" },
  { ar: "سليمان", en: "Soliman" },
  { ar: "مرسي", en: "Morsy" },
  { ar: "الغباشي", en: "El Ghobashy" },
  { ar: "شعبان", en: "Shaaban" },
  { ar: "القاضي", en: "El Kady" },
  { ar: "بدوي", en: "Badawy" },
  { ar: "الحديدي", en: "El Hadidy" },
  { ar: "عوض", en: "Awad" },
  { ar: "صبري", en: "Sabry" },
  { ar: "الشربيني", en: "El Sherbiny" },
  { ar: "المصري", en: "El Masry" },
  { ar: "عبد الحميد", en: "Abdelhamid" },
  { ar: "خليل", en: "Khalil" },
  { ar: "منصور", en: "Mansour" },
  { ar: "الجندي", en: "El Gindy" },
  { ar: "طنطاوي", en: "Tantawy" },
  { ar: "الأنصاري", en: "El Ansary" },
  { ar: "حمدي", en: "Hamdy" },
  { ar: "شاهين", en: "Shaheen" },
];

/**
 * Free-text clinical and booking phrases, so that Arabic text appears in every field a clinic
 * actually reads on screen -- not only in names. Deliberately short and mundane; these are the
 * kind of notes reception and doctors really type.
 */
export const COMPLAINTS = [
  "صداع مستمر منذ أسبوع",
  "ألم في المعدة بعد الأكل",
  "كحة وارتفاع في الحرارة",
  "ألم أسفل الظهر",
  "دوخة وإرهاق عام",
  "التهاب في الحلق",
  "متابعة ضغط الدم",
  "طفح جلدي في الذراع",
  "ألم في الركبة عند المشي",
  "متابعة نتائج التحاليل",
] as const;

export const DIAGNOSES = [
  "التهاب الجيوب الأنفية",
  "نزلة معوية حادة",
  "التهاب الشعب الهوائية",
  "شد عضلي أسفل الظهر",
  "أنيميا نقص الحديد",
  "التهاب لوزتين",
  "ارتفاع ضغط الدم — تحت السيطرة",
  "حساسية جلدية",
  "خشونة في الركبة — درجة أولى",
  "فيتامين د منخفض",
] as const;

export const TREATMENT_PLANS = [
  "مضاد حيوي لمدة خمسة أيام مع خافض حرارة عند اللزوم",
  "راحة وسوائل دافئة، ومتابعة بعد أسبوع",
  "علاج طبيعي ثلاث جلسات أسبوعيًا",
  "مكمل حديد يوميًا مع إعادة التحاليل بعد شهر",
  "استمرار العلاج الحالي بنفس الجرعة",
  "دهان موضعي مرتين يوميًا وتجنب المواد المهيجة",
  "تقليل الملح والمتابعة الشهرية",
] as const;

export const DOCTOR_NOTES = [
  "المريض متجاوب مع العلاج، الحالة مستقرة.",
  "يُنصح بإعادة التحاليل قبل الزيارة القادمة.",
  "لا توجد أعراض جانبية من الدواء السابق.",
  "تحسن ملحوظ منذ الزيارة الماضية.",
  "يحتاج متابعة دقيقة للضغط أسبوعيًا.",
] as const;

export const BOOKING_NOTES = [
  "حجز عن طريق الواتساب",
  "المريض طلب ميعاد صباحي",
  "تحويل من عيادة أخرى",
  "أول زيارة",
  "متابعة",
] as const;

export const CANCELLATION_REASONS = [
  "ظرف طارئ للمريض",
  "تم تأجيل الميعاد بناءً على طلب المريض",
  "الطبيب في مؤتمر",
  "المريض تحسن ولم يعد يحتاج الكشف",
] as const;

export const ADDRESSES = [
  "المعادي، القاهرة",
  "مدينة نصر، القاهرة",
  "المهندسين، الجيزة",
  "سموحة، الإسكندرية",
  "طنطا، الغربية",
  "الزقازيق، الشرقية",
  "أسيوط",
  "شبرا الخيمة، القليوبية",
  "6 أكتوبر، الجيزة",
  "بورسعيد",
] as const;
