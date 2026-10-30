# تقرير الرحلات: واجهة المنافسين وحفظ السجلات — Task 8

**الحالة:** الكود مكتوب ومراجَع على الفرع `feat/competitor-ui`، لكن **مفيش حاجة اتنشر ولا اتطبق على الإنتاج**. أي كلام عن "نُشر" أو "اتفعّل" في التقرير ده غلط.

**التاريخ:** 2026-10-30 · **الفرع:** `feat/competitor-ui` عند `257948a6` · **قاعدة الفرع:** `191152935ecf8cc160721e2cdf9fcdc28a602d5f`

**المصدر:** [الخطة](../plans/2026-10-30-competitor-ui-and-retention.md) · [المواصفة](../specs/2026-10-30-competitor-ui-and-retention.md) · [دليل التشغيل](../runbooks/competitor-tracking-retention.md)

---

## باختصار

واجهة المنافسين اتبنت واتربطت فعلياً في الصفحة: تبويب جديد اسمه "المنافسين اللي بتتابعهم" على `/analytics/instagram?tab=competitors`، وقائمة فيها الأرقام الحقيقية، وتفاصيل لكل منافس، وإزالة وتفعيل تاني، وكله بالعربي والإنجليزي.

الحاجات اللي **اتأكدت** دلوقتي:

- **9 رحلات متصفح محاكى** في `e2e/analytics.spec.ts` — كلهم عدّوا.
- **190 اختبار وحدة** في `src/features/competitor-tracking` و`src/hooks/__tests__/useBrandScrapeProvenance.test.tsx` — كلهم عدّوا.
- معاملات edge function موجودة في المستودع (Deno): 9 ملفات اختبار.

الحاجات اللي **لسه ماتأكدتش**، وليه:

- **مفيش SQL اتطبق على الإنتاج.** الـ M1 لـ M4 مكتوبين في المستودع بس. مفيشCron ولا دالة منشورة.
- **U4 (مصدر القياس من أوله لآخره) متوقف** على المهمة 2 في الخطة الأم: `brand-scrape` لسه مش بيبلّغ عن مصدر واضح، فالواجهة بتقول "المصدر مش معروف" وده الكلام الصادق مش التغطية الناقصة.
- **الاختبارات الحية على Meta والـ CI على السيرفر** والتكامل الكامل لـ J1–J10 مملوكين **للمهمة 11** في الخطة الأم، مش للمهمة 8.

---

## جدول الرحلات

| الرحلة | معرف القبول | الحالة | الدليل |
|---|---|---|---|
| J3 → J5: متابعة منافس من نتيجة بحث | T8-02، U5 | **متحقق (متصفح محاكى)** | `e2e/analytics.spec.ts` › "tracking a competitor adds it once and enqueues the collection once": طلب حفظ واحد بالظبط + طلب جمع واحد بالظبط + مفيش تكرار |
| J5: أول لقطة ونقطة بداية | T8-02، T8-04 | **متحقق جزئياً** | التنسيق والـ reasons متحققين باختبارات الوحدة؛ الأرقام الحقيقية (نقطة البداية الحقيقية) محتاجة خادم يقرأ SQL |
| J6: الحد الأقصى والـ pricing | T8-02، U5 | **متحقق (متصفح محاكى)** | "a quota refusal does not add the competitor": الرفض بيقول "Your limit is 1 active competitors." ومفيش صف اتضاف. **في الإنتاج الرفض بيحصل في قاعدة البيانات**، والمحاكي بيحاكي شكله بس |
| J7: لوحة التفاصيل (7/30 يوم + الشذوذ) | T8-04، T8-06، U6 | **متحقق جزئياً** | العرض والتبديل متحققين؛ **حساب الشذوذ والنمو بيحصل في الخادم** (`_shared/outlierScore.ts`) والواجهة بتنسخ النتيجة بس |
| T8-L1: إزالة منافس | T8-08، T8-11 | **متحقق (متصفح محاكى)** | "a removal keeps the history and moves the entry to Removed": السجل فضل موجود، وعليه علامة استحقاق التنضيف، والتفاصيل لسه مقروءة |
| T8-L2: تفعيل تاني | T8-08 | **متحقق (متصفح محاكى)** | "a reactivation keeps the same identity and clears the removed marker": نفس الـ id، نفس الصف، والـ marker اتشال |
| التوجيهات | T8-11 | **متحقق (متصفح محاكى)** | "the route paths of the feature keep working": الافتراضي Performance، `?tab=analyze`، `?tab=competitors`، وتحويل `/brand-intelligence` |
| العربي واتجاه RTL | T8-11 | **متحقق (متصفح محاكى)** | "the tracked list renders in Arabic with a right-to-left document": `dir="rtl"` على الـ html + الكoping العربي |
| لوحة المفاتيح | T8-11 | **متحقق مع ملاحظة** | "the remove dialog is operable with the keyboard alone and restores the focus" — شوف الملاحظة تحت |
| U4: مصدر القياس من أوله لآخره | T8-01، U4، J2/J3 | **متوقف** | **مفيش اختبار واحد بيقول إنه تمام.** السبب: المهمة 2 في الخطة الأم (مصدر `brand-scrape`) لسه مش مطبّق. الواجهة بتعرض "المصدر مش معروف" وده الصادق |
| E2: الرحلة المجمّعة | T8-12 | **مش مكتملة** | محتاجة Auth/PostgREST/SQL حقيقي محلي؛ تغطية المتصفح المحاكى مش بتغطيها |
| الاستبقاء 90 يوم والسباق | T8-08، T8-09، T8-10 | **كود بس** | M3/M4 مكتوبين ومختبرين بالـ SQL، بس **مفيش SQL مطبّق**، ومفيش دالة منشورة، ومفيش سباق حقيقي اتنفّذ على جلسات |

---

## إيه اللي اتأكد بالظبط، وإيه اللي لأ

### متأكد — متصفح محاكى (مش خادم حقيقي)

| الحاجة | إزاي اتأكدت | إيه اللي ده **مش** بيثبته |
|---|---|---|
| الصفحة البتوصّل للمنافسين فعلاً | الرحلة بتفتح `/analytics/instagram?tab=competitors` وبتلاقي القائمة | مفيش بيتكلم مع Postgres |
| الأرقام المكتوبة صح | القيمة المزروعة 12,480 متابع و+480 (4.0%) و+1,280 (11.4%) و3.0/week، والاختبار بيقارن النص بالحرف | الأرقام دي **قيم مزروعة (fixture)**، مش ناتج حساب حقيقي |
| الإضافة مرة واحدة | عدّاد طلبات الحفظ = 1 وطلبات الجمع = 1 | إن القاعدة كانت هترفض التكرار فعلاً |
| رفض الحد ما بيضيفش | الرد على الرفض بالشكل الحقيقي + ما فيش صف جديد | إن `read_own_competitor_quota` بيرفض بنفس الشكل على القاعدة الحقيقية |
| إعادة الجمع: متqueued بعدين completed | `mode:"force"` مرة واحدة بس، ثم قراءة الحالة بت-transition من queued لـ completed | إن الجامع الحقيقي بيشتغل بنفس التوقيت |
| الإRemoval-за history | الصف راح لقائمة "تمت إزالتهم" وفيه نفس الأرقام ونفس تاريخ الاستحقاق | إن الصف مش بيتحذف فعلياً على القاعدة (الـ mock بيحاكي RPC بيفلِس `is_active` بس) |
| التفعيل التاني | نفس الـ watchlist id، والـ marker اتشال | سباق الـ lock الحقيقي |
| RTL | `dir="rtl"` + النص العربي | إن كل شاشات بتاعة RTL (375px و200% زووم) متغطية |
| المسارات | المسارات الأربعة | — |

**الحدود المهمة:** المسح أخد كل إجاباته من `e2e/fixtures/competitorTracking.ts`. مفيش اتصال بـ Postgres ولا Supabase Auth ولا Meta ولا Apify. الحساب owner **اصطناعي** (`11111111-1111-4111-8111-111111111111`).

### لسه محتاج خادم حقيقي

| الحاجة | مين ملكها | إيه اللي ناقص |
|---|---|---|
| إن `read_own_competitor_tracking_report` تفصل بين المالكين | SQL suite + V3 على PostgreSQL disposable | تشغيل الـ harness على القاعدة disposable وتسجيل الأرقام |
| إن حد التنظيف مايمسحش حاجة غلط | سباق جلسات حقيقيين | `supabase/tests/competitor_retention_race_fixture.sql` محتاج جلسات `psql` اتنين بالظبط |
| إن الـ quota والـ RLS شغالين | القاعدة الحقيقية | مفيش SQL اتطبق |
| إن الجامع بيوصل لبيانات Meta | probes حية | **المهمة 11** |
| CI على السيرفر | **المهمة 11** | — |
| E2 المجمّع (Auth + PostgREST + SQL) | **المهمة 11** | — |

---

## ملاحظة على استرجاع التركيز (a11y)

الاختبار "the remove dialog is operable with the keyboard alone and restores the focus" عدّى، بس فيه تفصيلة لازم تتقال بصراحة:

- لما الـ dialog يفتح، التركيز بيكون على **Cancel** (الخطوة الآمنة) — وده المطلوب.
- لما **Cancel** أو **Escape** يقفل الـ dialog، التركيز **مش** بيرجع لزر "Remove". Radix بيرجّع التركيز للعنصر اللي فتح الـ dialog، والـ dialog ده متفتح بـ state من React **من غير Trigger**، فمفيش عنصر يرجع له.
- لما **التأكيد** ينجح، التركيز بيروح على **عنوان القائمة** ("Tracked competitors") — وده بالظبط اللي المواصفة بتقوله في §3: "Success returns focus to next row or list heading".

يعني: شرط "استرجاع التركيز" متحقق في مسار النجاح، ومفيش استرجاع في مسار الإلغاء. لو المواصفة عايزة رجوع التركيز لزر "Remove" بعد الإلغاء، ده **تعديل في `RemoveCompetitorDialog` أو `CompetitorTrackingWorkspace`** محتاج قرار من المراجع. ما اتغيرش في Task 8 part 9.

---

## حاجات لازم تتعمل قبل الإصدار

1. **تطبيق الـ M1 لـ M4 يدوي** على الإنتاج كـ `supabase_admin`، **قبل** الـ merge، وبعد rehearsal على قاعدة disposable. التفاصيل في [دليل التشغيل](../runbooks/competitor-tracking-retention.md).
2. **التحقق من الكتالوج والصلاحيات**: `read_own_competitor_tracking_report` لـ `authenticated` بس، `run_competitor_retention_batch` و`persist_competitor_collection_result_v2` لـ `service_role` بس، والمفتاح `competitor_retention_enabled` = `false`.
3. **نشر الدالتين** (`competitor-tracking-report` بـ `verify_jwt = true`، `competitor-retention` بـ `verify_jwt = false` + `verifyCronOrAdmin`) مع إثبات SHA256 وفحص الإقلاع.
4. **dry run** للتنظيف وقراءة الأرقام قبل أي حاجة.
5. **التفعيل قرار منفصل**: المفتاح الأول، وبعدين الـ cron. Task 8 part 9 **ما فعّلش** أي حاجة فيهم.

---

## إيه اللي مش متأكد منه في هذا التقرير

- **مفيش deploy.** الـ edge functions مكتوبة في المستودع ومش منشورة على `api.postora.cloud`.
- **مفيش migration مطبّقة.** الـ catalog والصلاحيات والـ cron **مش موجودين** في الإنتاج دلوقتي.
- **مفيش ادعاء عن دقة الأرقام.** الأرقام في التقرير ده من fixture، مش من حساب حقيقي.
- **U4 مش مكتمل.** يظهر "المصدر مش معروف" وده الصادق، مش غطاء.
- **الـ coverage الأسبوعي الكامل (T8-05)** لسه محتاج إثبات الـ ordering من المزوّد؛ الميزة بتقول "incomplete coverage" أو "unknown" لحد ما يبقى في دليل.

---

## ملاحظة على أساس الفرع

الفرع مبني على `191152935ecf8cc160721e2cdf9fcdc28a602d5f`، وده **أقدم** من `origin/main` الحالي. فرق الـ merge فيه `supabase/tests/deferred_publishes.sql` (من PR #300) لسه مش موجود على الفرع. ده مش حذف من Task 8، لكنه لازم يتحل في الـ merge (rebase أو merge من `main`) قبل أي تشغيل للـ harness، عشان "كل الـ suites الموجودة" تفضل موجودة.

---

# English

## Status

The competitor tracking UI is implemented and wired into the reachable page, but **nothing is deployed and nothing has been applied to production**. The branch is `feat/competitor-ui` at `257948a6`, based on `191152935ecf8cc160721e2cdf9fcdc28a602d5f`.

## What is proven

- **9 mocked-browser journeys** in `e2e/analytics.spec.ts` — all pass (`9 passed`, 41 s, chromium).
- **190 unit tests** in `src/features/competitor-tracking` and `src/hooks/__tests__/useBrandScrapeProvenance.test.tsx` — all pass (`13 test files, 190 tests`).
- The Deno suites for `competitor-tracking-report` (6 files) and `competitor-retention` (4 files) exist in the repository.

## What is NOT proven

- **No production SQL.** M1–M4 are written; none of them is applied. The cron job `competitor-retention` does not exist in production yet, because M4 has not been applied.
- **No deployment.** Neither Edge Function is on `api.postora.cloud`.
- **U4 is BLOCKED** on parent Task 2 (the brand-scrape provenance contract). The UI says "Source unknown", which is the truthful state, not a green tick.
- **The live Meta probes, the hosted CI and the assembled J1–J10 integration belong to parent Task 11.**

## Mocked browser vs. real backend

The browser journeys intercept `competitor-tracking-report`, the three owner RPCs and `competitor-snapshot-sync`, and run as a synthetic owner. They prove the wiring, the states, the exact copy, the lifecycle arguments and the keyboard path. **They prove nothing about the server**: the SQL owner scoping, the quota enforcement, the retention batch and the real numbers all still need the disposable-database rehearsal and the live runs that parent Task 11 owns.

## Before any release

Apply M1→M4 manually as `supabase_admin` (after a disposable rehearsal), verify the catalog and the ACLs, deploy the two functions with the SHA256 and boot proof, run a dry run, read the numbers, and only then ask for the activation approval — switch first, cron second. The details are in [`docs/runbooks/competitor-tracking-retention.md`](../runbooks/competitor-tracking-retention.md).
