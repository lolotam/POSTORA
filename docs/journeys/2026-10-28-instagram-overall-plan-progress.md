# الأساسات جاهزة محلياً؛ تجربة تحليلات إنستقرام الكاملة ما زالت قيد التنفيذ

**الحالة:** تحت التطوير والمراجعة؛ لا دمج ولا رفع للسيرفر.
**المصدر:** Pull Request (طلب دمج التعديلات) [#294](https://github.com/lolotam/POSTORA/pull/294)، الخطة الأصلية وأدلة القبول المحلية؛ 2026-10-28.

## باختصار

خلصنا المرحلة الأولى من أربع مراحل: حماية بيانات الدخول، ملكية البيانات، حدود المنافسين وأساس المهام والحسابات الإحصائية. نحن الحين في المرحلة الثانية: إكمال تجربة حسابك أنت من ربط إنستقرام إلى ظهور التحليلات.

جزء مهم من الأساس مقبول باختبارات محلية، لكن **المنتج الكامل غير جاهز بعد**. تنفيذ المنافسين والتحقق من الإصدار لم يصلا إلى القبول. ما يصح نحسب عدد الملفات أو الاختبارات كنسبة إنجاز للميزة.

## وش تغيّر بالضبط

### المراحل المعتمدة

| المرحلة | الحالة | المعنى العملي |
|---|---|---|
| 1. الأساسات الأمنية وقاعدة البيانات | مقبولة محلياً | الحماية وحدود الاستخدام وعقود البيانات والطوابير الأساسية جاهزة كاعتماد للمراحل التالية، وليست مفعلة بالإنتاج |
| 2. تجربة حساب المالك كاملة | قيد التنفيذ | ربط الحساب يحتاج إنهاء ومراجعة؛ جمع التحليلات وعرضها ما زالا ناقصين |
| 3. المنافسون | لم يبدأ التنفيذ المتكامل | قاعدة البيانات وحدود المنافسين موجودة؛ الجمع والإدارة والواجهة والاحتفاظ بالسجل لم تكتمل |
| 4. جاهزية الإصدار | معلقة | نحتاج CI على النسخة المقبولة، وتجارب متصفح وMeta فعلية، ثم موافقة إصدار منفصلة |

### المهام الإحدى عشرة في الخطة الأصلية

| المهمة | الحالة الدقيقة |
|---|---|
| 1. القرارات والتحقق من صلاحيات Meta | قرارات النطاق وحدود الاستخدام معتمدة؛ التحقق الفعلي من الحسابات وصلاحيات Meta ما زال بوابة قبل التفعيل |
| 2. إصلاح الاكتشاف وربط الحسابات | جزئي: المعاملات والحماية الأساسية مقبولة؛ ربط HTTP والاختيار قيد تصحيح Grok، وأعمال اكتشاف المنافسين ومصدر البيانات والذاكرة المؤقتة لاحقة |
| 3. قاعدة البيانات والملكية والحدود والمهام الدائمة | الأساسات مقبولة محلياً؛ لا تطبيق إنتاجي ضمن هذا العمل |
| 4. الاتصال بالمنصة والمهام المحدودة والجدولة | أساس الطوابير في قاعدة البيانات جاهز؛ تنفيذ العمال واتصالات المنصة والتشغيل المجدول لم يكتمل |
| 5. اكتشاف المنشورات الاستثنائية وتجميع التقرير | الحسابات الأساسية وتجميع التقرير وعقده v1 مقبولة؛ قارئ قاعدة البيانات والربط الفعلي بالمستهلكين لاحقان |
| 6. جمع تحليلات حساب المالك | لم ينفذ العامل الكامل بعد |
| 7. قائمة المنافسين وجمع بياناتهم | مخطط البيانات والحدود جاهزان؛ التنفيذ التطبيقي والجمع لاحقان للمرحلة الثانية |
| 8. واجهة المنافسين والحذف المرن والاحتفاظ | لم تنفذ التجربة المتكاملة أو عامل التنظيف؛ آليات الحماية الأساسية موجودة |
| 9. واجهة أداء إنستقرام | لم تنفذ الواجهة الجديدة بعد؛ الحفاظ على توافق المسار الحالي مطلوب |
| 10. قراءة التقارير عبر API والتكاملات | عقد التقرير جاهز؛ القارئ ونقطة القراءة وربط get_post_analytics لم تنفذ؛ أدوات المنافسين الاختيارية مؤجلة |
| 11. الاختبارات المتكاملة وتسليم الإصدار | توجد اختبارات قوية للمكونات المقبولة؛ الرحلة الكاملة وCI النهائي والمتصفح وMeta وتسليم الإصدار ما زالت معلقة |

### المقبول محلياً

- تخزين محمي لصلاحيات Facebook المشتركة وربطها بالحسابات الصحيحة، مع منع النتائج القديمة من الكتابة فوق إعادة ربط أحدث.
- مخطط التحليلات والمنافسين وحدود Free 5 / Pro 20 / Business 30 / Admin unlimited، مع احترام الاستثناءات وحفظ التاريخ عند تجاوز الحد.
- أساس المهام الدائمة والاستئناف ومنع عامل منتهي الصلاحية من اعتماد نتيجة قديمة. **هذا لا يعني أن عامل جمع التحليلات قد اكتمل.**
- حساب المنشورات الاستثنائية وعقد التقرير v1 وتجميعه، مع تمييز البيانات غير المتاحة عن الصفر.
- منع المتصفح من قراءة بيانات الدخول المؤقتة، وقراءتها عبر مسارات خدمة محددة الصلاحيات.
- معاملات ربط الحساب وتجديد الصلاحيات في قاعدة البيانات، وحفظ معرفات إنستقرام بحيث لا تتعطل هوية الحساب المستخدمة في الرسائل والتعليقات.

دليل مختصر: `35f86867` للأساسات، `5bccca54` لحماية البيانات المؤقتة، `81ad556c` للقراءات المحمية، `755a330c` لمعاملات الربط، `9f5e78fe` لمعاملات التجديد، `2f5bd17c` لمعرفات إنستقرام. تم الاطلاع على قوائم الملفات الفعلية لهذه التعديلات، وليس الاعتماد على تقارير المنفذين وحدها.

## وش ما تغيّر

- لا توجد حتى الآن رحلة مقبولة كاملة: ربط الحساب ← جمع بيانات Meta ← حفظها ← قراءة API ← عرض الواجهة.
- قاعدة بيانات التجديد جاهزة، لكن دمج التجديد المحمي الفعلي في الخدمة لم يكتمل. مسار الرفض الآمن يبقى إلى أن يقبل هذا الدمج.
- تسجيل الدخول الجديد إلى Grok أتاح إعادة تكليف التصحيح؛ لا يثبت أنه أنهى التصحيح. آخر نتيجة مستقلة للشجرة الجزئية كانت فشل فحص الأنواع بـ13 خطأ. تصحيح CLI الجديد لم يسلم نتيجة مقبولة بعد وقت إعداد التقرير.
- لم ننشر هذه التغييرات أو نفعل جمع البيانات. وضع الصلاحيات الافتراضي ما زال legacy والجمع متوقفاً.

## جرّبها بنفسك

**لا توجد تجربة إنتاجية جديدة تطلب منك اختبارها الحين.** لم نرفع هذا العمل إلى السيرفر؛ فتح الموقع الحالي لا يختبر التعديلات المحلية.

تقدر تتابع [PR #294](https://github.com/lolotam/POSTORA/pull/294)، لكنه ما زال Draft. وقت الفحص، نسخته البعيدة `e867688c` ونتائج CI المعروضة تعود لتشغيلات قديمة في 26 أكتوبر؛ ليست نتيجة للشجرة المحلية الحالية. بعد القبول المحلي سنرفع النسخة المقبولة ونتحقق من نتائجها الفعلية.

## أشياء تحتاج تعرفها

### لماذا أخذ الأساس وقتاً؟

المراجعات كشفت أخطاء حقيقية تمس بيانات الدخول وتزامن إعادة الربط والنتائج القديمة. لذلك توسع العمل في المتطلبات الأمنية اللازمة، وليس في ميزات المنافسين أو الواجهة. التسليم الأول لربط HTTP اجتاز184 اختباراً، لكن فحوصاً إضافية أثبتت عيوباً؛ اجتياز الاختبارات الموجودة وحده لم يكن كافياً.

آخر أساس معرفات مقبول اجتاز124 ترحيلاً و44 مجموعة SQL و67 فحصاً مركزاً و2,204 اختبار Node. هذه أدلة على **النسخة المقبولة المحددة**، وليست نجاحاً تلقائياً لأي تعديلات تلتها أو دليلاً على عملها في Meta الفعلي.

### الترتيب المقترح من هنا

1. إنهاء تصحيح ربط HTTP الحالي ومراجعته باختبارات فعلية للخطافات والخدمات، حتى يستوفي شروط القبول.
2. رفع النسخة المقبولة إلى PR Draft وتشغيل CI، حسب موافقتك الأخيرة. لا نتجاوز فشلاً؛ مشكلة تشغيل GitHub السابقة تبقى غير محسومة حتى نرى تشغيل النسخة الجديدة فعلياً.
3. دمج التجديد المحمي في مهمة منفصلة، ثم تنفيذ عامل جمع بيانات المالك.
4. تنفيذ قارئ قاعدة البيانات ونقطة التقرير وربط API، ثم واجهة التحليلات؛ يبقى الحساب في الخادم حتى لا تختلف أرقام الواجهة عن API.
5. قبول رحلة مالك واحدة كاملة، ثم تنفيذ المنافسين، ثم التحقق الفعلي من الإصدار.

**توصيتي:** حافظ على هذا الترتيب، واستخدم بوابات قبول صغيرة وواضحة بدل إعادة فتح نطاق الخطة كله. أعط كل دفعة مراجعة قائمة عيوب محددة، واطلب رأياً مستقلاً إذا تكررت العيوب الجوهرية؛ لا تستمر بدورات مفتوحة بلا قرار. أبقِ Stories وأدوات المنافسين الاختيارية وScheduled Apify خارج v1، ولا تفعل الجمع أو تبدأ الواجهة الواسعة قبل تثبيت مسار البيانات. لا يمكن إعطاء نسبة إنجاز أو موعد موثوق من حجم الكود وحده.

---

# English

## In short

**We are in milestone2 of4.** Security/database foundations are accepted locally. The complete owner-account analytics journey is not finished; competitor delivery and release verification remain ahead. This is substantial infrastructure progress, not a nearly finished user-facing feature.

## What changed

Accepted local work covers protected credentials and ownership, competitor schema/quotas, durable database jobs, outlier scoring/report-v1 assembly, pending-token access restrictions, atomic OAuth/refresh SQL and Instagram identity compatibility. The actual worker and report reader are separate unfinished production consumers.

| Original task | Current status |
|---|---|
| 1. Decisions/live capability | Scope decisions settled; real Meta capability validation remains outstanding |
| 2. Discovery/OAuth | SQL/security prerequisites accepted; OAuth HTTP correction underway; discovery/source/cache work remains |
| 3. Schema/ownership/quotas/jobs | Foundations accepted locally, not applied to production by this work |
| 4. Provider gateway/workers/scheduling | Database queue primitives ready; provider workers and scheduling integration unfinished |
| 5. Outliers/report | Algorithm, assembler and v1 contract accepted; database reader/production consumers unfinished |
| 6. Owner collection | Complete collector not implemented |
| 7. Competitor application/sync | Schema/quota prerequisites ready; application and collection deferred until owner-flow acceptance |
| 8. Competitor UI/retention | Integrated UI, lifecycle management and cleanup worker unfinished |
| 9. Owner performance UI | New interface not implemented |
| 10. Report API/integrations | Contract ready; reader, endpoint and existing analytics proxy wiring unfinished; optional competitor tools deferred |
| 11. End-to-end/release | Component evidence exists; assembled journey, final-revision hosted checks and live verification pending |

## What did not change

Grok CLI login is verified and the preserved correction was dispatched to `grok-4.7-build-fast`/high. There is no accepted delivery from that continuation at report time. The last independent interrupted-tree typecheck failed with13errors; older initial-delivery passes cannot replace corrected-tree validation. Protected refresh integration remains a separate task. No merge, deployment, production migration or activation occurred.

## Try it yourself

There is no new production journey to test yet. PR294 is still draft at remote head `e867688c`; displayed CI failures are from October26, not the newer local work. After independent acceptance, the user has authorized pushing the accepted branch and running CI. No merge/deployment permission follows from that.

## Things you should know

Recommended sequence: **OAuth correction → independent acceptance → draft PR CI → protected refresh integration → owner collector → report reader/API/proxy → owner UI → complete owner-flow verification → competitors → release readiness.**

Use bounded reviewed slices and evidence at each step. Keep existing Stories/optional competitor MCP/scheduled Apify deferrals. Do not equate test counts, source-line counts, successful enqueue or accepted SQL with a working full feature. Final hosted execution remains unproven; previous GitHub billing/spending-limit failures are infrastructure evidence, not proof of current code defects or current restoration.

---

## المهمة التالية

```text
Continue Postora's current protected OAuth HTTP correction on feat/instagram-insights-competitors. Read ARCHITECTURE.md and the latest plan sections first. Grok 4.7 Build Fast/high is the authorized correction implementer; the current CLI run owns the implementation, so do not launch a duplicate. On delivery, freeze its exact files and independently verify consultation30's hook/handler, read-failure, request-context, provider-status/expiry/timeout, replay, configuration and token-redaction requirements, plus the actual CI/typecheck/full-test/build/no-regression gates. Send bounded findings back to Grok; keep Astra advisory/read-only. Preserve accepted SQL/types, protected refresh refusals and unrelated work. Only after local acceptance commit scoped files and push the accepted branch to existing draft PR294 for real CI; address genuine failures without bypasses. No undraft, merge, production migration, deployment or activation. Complete the owner flow before competitors. Authoritative tracker: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md.
```
