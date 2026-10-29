# الأساس جاهز؛ رحلة تحليلات إنستقرام ما اكتملت بعد

**الحالة:** نحن في المرحلة ٢ من ٤. آخر تعديل مقبول ومحفوظ محليًا، ولم يُرفع أو يُنشر.
**المصدر:** [PR #294](https://github.com/lolotam/POSTORA/pull/294) ما زال مسودة · تعديل التجديد `dd7257d2` في ٩ ملفات · ٢٨ أكتوبر ٢٠٢٦.

## باختصار

اكتملت مراجعة الأساس الأمني وقاعدة البيانات، وربط الحسابات، وتجديد صلاحية حساب إنستقرام المرتبط مباشرة. لكن رحلة عرض التحليلات للمستخدم لم تكتمل؛ الشغل المنجز حتى الآن خلف الكواليس، وليس ميزة منشورة.

## وش تغيّر بالضبط

| المرحلة | وضعها الآن |
|---|---|
| ١. الأساس الأمني وقاعدة البيانات | مقبول؛ لا يعني تطبيق الترحيلات على الإنتاج |
| ٢. رحلة صاحب الحساب كاملة | قيد العمل: الربط مقبول ومرفوع للفرع، والتجديد المباشر مقبول محليًا |
| ٣. المنافسون | مؤجلون حتى اكتمال رحلة صاحب الحساب |
| ٤. التحقق قبل الإصدار | لاحقًا؛ ليس إذنًا تلقائيًا بالنشر |

كان مسار التجديد المحمي يرفض العمل. الحين يدعم الحساب المرتبط مباشرة، مع التحقق من صلاحية الطلب والحساب ونتيجة المزود، ورفض النتائج القديمة أو غير الموثوقة. الحسابات المرتبطة بصفحات فيسبوك والتفويض المشترك ما زالت مرفوضة إلى أن يُحسم مسار تجديدها بأمان.

اجتاز التعديل ٣٣١ اختبار Deno، و١٨ فحصًا مستقلًا، و٩ فحوص مع قاعدة بيانات معزولة فعلية، و٢٬٢١١ اختبار Node. فحص الأنواع والبناء وفحوص عدم إضافة مخالفات lint/i18n نجحت؛ توجد ١٥ حالة اختبار متخطاة مسبقًا، ولم تصبح مخالفات المستودع القديمة صفرًا.

## وش ما تغيّر

لم نكمل جامع بيانات صاحب الحساب، أو قراءة التقرير وواجهته البرمجية، أو شاشة `/analytics/instagram`، أو التحقق من الرحلة كاملة. خوارزمية النتائج غير المعتادة وتجميع التقرير لهما أساس مقبول، لكن هذا لا يعني اكتمال شاشة التحليلات. لم ننشر أو ندمج أو نفعّل جمع البيانات.

## جرّبها بنفسك

لا يوجد تغيير جديد منشور تضغط عليه في الموقع. الاختبارات الحالية محلية ومعزولة؛ لم نثبت بعد الرحلة مع حساب Meta فعلي ومتصفح على الإنتاج.

## أشياء تحتاج تعرفها

- آخر تعديل تجديد `dd7257d2` محلي فقط؛ رأس الفرع البعيد ما زال `aa985e0a`، وطلب الدمج مسودة، وفق التحقق المباشر وقت هذا التقرير.
- آخر محاولة GitHub Actions لم تبدأ أي خطوات بسبب مشكلة الفوترة أو حد الإنفاق. هذا عائق تشغيل، وليس اختبارات ناجحة أو فشلًا مثبتًا في الكود. لم نغيّر الفوترة أو نعد المحاولة هنا.
- التجديد المباشر يشترط مرور ٢٤ ساعة على آخر تغيير موثوق في صلاحية بيانات الاعتماد؛ ليس هذا إثباتًا لعمر إصدار التوكن. تنظيف الالتقاطات مطلوب قبل التشغيل الدوري.
- الخطوة التالية: تحديد عقد تجديد حسابات الصفحات والتفويض المشترك، ثم جامع بيانات صاحب الحساب، والتقرير وواجهته البرمجية والشاشة، ثم اختبار الرحلة كاملة. لا تبدأ المنافسين قبل قبول هذه الرحلة.
- انتهى عمل المنفذين والمراجعة والمراقبين السابقين؛ لا توجد نتيجة تنفيذ معلّقة وفق سجل القبول. أدوات الذاكرة والحراس المسماة وgraphify كانت غير متاحة؛ المراجعات اليدوية بدائل مُعلنة وليست ادعاءً بتشغيل تلك الأدوات.

---

# English

## In short

**Milestone 2 of 4: the complete owner flow is still unfinished.** Security/database foundations are accepted. OAuth is accepted and pushed to the draft branch; direct Instagram refresh is accepted locally as `dd7257d2`, not pushed or deployed.

## What changed

The protected refresh path now supports direct Instagram accounts instead of refusing every protected refresh. Independent corrections covered authorization, provider-error classification, receipt identity/state, token/expiry validation and bounded alerts. Validation passed: 331 protected Deno tests, 18 independent controls, nine real-SQL runtime controls, 2,211 Node tests, typecheck, build and lint/i18n no-regression checks. Fifteen existing Node tests remain skipped; historical lint/i18n debt remains.

## What did not change

Page-linked/shared-grant refresh remains unsupported. The owner collector, report database reader/API/proxy, analytics UI and complete-flow verification are unfinished. Competitor delivery and release verification remain subsequent milestones. No production migration, merge, deployment or collection activation occurred.

## Try it yourself

There is no newly deployed UI change to click. Current evidence is local/isolated with synthetic provider responses, not a live Meta/browser acceptance journey.

## Things you should know

PR294 is still open/draft at remote `aa985e0a`, freshly verified for this report. The last hosted CI attempt was account-blocked before any steps ran; availability has not been re-proven here. Direct-refresh admission remains conservatively tied to a trusted authority timestamp at least 24 hours old, and capture cleanup is required before recurring activation. Both delivery watchers completed; no delivery is awaiting collection in the accepted work record.

Next: establish safe Page/shared refresh transport and captured reconciliation, then finish owner collection → database/report API → UI → end-to-end verification. Only then proceed to competitors.

---

## المهمة التالية

```text
Continue Instagram milestone 2 in E:/Dev/Projects/postora_new. Read ARCHITECTURE.md and docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md §14 and its latest acceptance entries. OAuth 547b7c93 is accepted/pushed; direct refresh dd7257d2 is accepted locally. Inspect supabase/functions/refresh-tokens/ and the accepted 20261027120000_meta_account_refresh_lifecycle.sql contract. First establish the separately bounded Page/shared provider procedure and captured operational-token reconciliation contract; do not claim grant-only rotation completes account refresh or silently expand accepted SQL. Preserve the MiniMax initial/Grok correction/read-only Astra lanes and independent actual-handler, real-SQL, portability, full regression and exact-byte gates. Finish the owner collector/report API/UI and whole-flow acceptance before competitors. Keep PR294 draft, legacy mode and collection OFF. No new-work push, production migration, deployment, merge or activation without approval; report hosted CI's last account blocker honestly.
```

**Authoritative tracker:** `docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md`. Earlier journey reports reflect earlier checkpoints; this report includes the accepted direct-refresh slice.
