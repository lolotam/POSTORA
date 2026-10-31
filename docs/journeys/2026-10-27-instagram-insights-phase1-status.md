# أين وصلنا في ميزة إحصائيات إنستقرام وتتبع المنافسين؟ (انتهاء المرحلة الأولى)

> **ملاحظة حالة، 2026-11-01:** هذا تقرير تاريخي بتاريخ 27 أكتوبر. وصف #294 بأنه مسودة وعدم وجود واجهة أو نشر لا يمثل الحالة الحالية. راجع [المراجعة المحدثة لتحليلات Instagram وFacebook وThreads](2026-11-01-meta-analytics-status.md) للمنجز والمتبقي وأدلة الإنتاج، دون اعتبارها موافقة على التفعيل.

**الحالة:** مكتمل ومفحوص محلياً · غير مرفوع للسيرفر (Not Deployed) · الـ PR ما زال مسودة (Draft)
**المصدر:** فرع `feat/instagram-insights-competitors` · طلب الدمج [PR #294](https://github.com/lolotam/POSTORA/pull/294) · التعديلان `35f86867` و `fd073772` · ٢٧ أكتوبر ٢٠٢٦

---

## باختصار

خلّصنا **المرحلة الأولى من أصل ٤ مراحل** لتطوير ميزة إحصائيات إنستقرام وتتبع المنافسين.
المرحلة المكتملة تمثل "الأساس الخرساني والأمني تحت الأرض": جداول قاعدة البيانات المحمية، نظام إدارة طوابير المهام في الخلفية، معادلة اكتشاف المنشورات الاستثنائية، وفرض حدود الباقات تلقائياً.
حتى الآن **لا يوجد أي شيء ظاهر في واجهة الموقع للمستخدمين**، وكل ما أُنجز مفحوص ومحفوظ على جهاز التطوير فقط ولم يُرفع للسيرفر المباشر بعد.

---

## وش تغيّر بالضبط

المرحلة الأولى كانت مخصصة لضمان أمان النظام ومنع المشاكل قبل بناء الشاشات، وتم إنجاز وتأكيد الآتي:

1. **قواعد بيانات محمية بالكامل (Database & Security Foundations):**
   • تم تجهيز جداول مخصصة لحفظ لقطات الأداء اليومية للحسابات والمنشورات.
   • عزل بيانات المستخدمين بشكل صارم: لا يمكن لأي حساب الوصول لبيانات حساب آخر.
   • حماية رموز الدخول (Tokens): تخزين صلاحيات فيسبوك وإنستقرام في جداول مشفرة على السيرفر فقط، ومنع وصولها نهائياً لمتصفح المستخدم أو ظهورها في سجلات النظام.

2. **نظام طوابير دقيق وقوي (Durable Queues & Workers):**
   • لن تتوقف عمليات السحب إذا حدث انقطاع مفاجئ بالشبكة؛ النظام يسجل حالة كل مهمة وله آلية استعادة تلقائية (Lease & Checkpoint).
   • توزيع ذكي للمهام على دفعات (٢٥ حساب للمالك، و٥٠ للمنافسين) لتفادي حظر فيسبوك وتجاوز حدود الطلبات اليومية (Rate Limits).

3. **فرض حدود باقات المنافسين داخل قاعدة البيانات (Approved Quotas):**
   • تم تثبيت الحدود المعتمدة:
     - باقة **Free**: حتى ٥ منافسين
     - باقة **Pro**: حتى ٢٠ منافس
     - باقة **Business**: حتى ٣٠ منافس
     - باقة **Admin**: بدون أي حد
   • القفل البرمجي موجود في صلب قاعدة البيانات؛ حتى لو حاول أحد التلاعب عبر الـ API فلن يستطيع إضافة منافس فوق باقته.

4. **معادلة المنشورات الاستثنائية (Outlier Detection Algorithm):**
   • معادلة رياضية ذكية تفحص منشوراتك، وتقارن المنشور الجديد بمتوسط آخر ١٢ منشور ناضج، لتعرف فوراً ما إذا كان المنشور قد حقق تفاعلاً خارقاً للعادة (أعلى من المعدل بـ ٣ أضعاف أو ١.٥ ضعف) أو أقل من المعتاد.

5. **فحص واختبارات قياسية شاملة:**
   • تم اختبار تطبيق ١٢٠ تعديل لقاعدة البيانات، ونجحت ٤٠ حزمة اختبارات لقاعدة البيانات و٢,٢٠٤ اختبار كود Node و٢٣٧ اختبار Deno بدون أي فشل.
   • تم فحص سيناريوهات التزامن الصعبة (مثل محاولة شخصين إضافة نفس المنافس في نفس اللحظة) وثبتت حمايتها ١٠٠٪.

---

## وش ما تغيّر

• **واجهة الموقع لم تتغير إطلاقاً:** لم نضف أي صفحة أو زر جديد في الموقع حتى الآن؛ شاشات الإحصائيات وصفحات المنافسين ستُبنى في المرحلتين ٢ و ٣.
• **السيرفر المباشر لم يتأثر:** التعديلات موجودة في فرع محلي ولم تُدمج مع الكود الأساسي (`main`) ولم تُرفع على سيرفر الإنتاج (Production).
• **سحب البيانات الحية لم يبدأ:** لم نربط بعد الحسابات الحقيقية بـ Meta Graph API لجلب البيانات تلقائياً.

---

## جدول المراحل الأربعة

| المرحلة | الوصف | الحالة | ما تعنيه لك |
|---|---|---|---|
| **١. الأساسات الأمنية وقواعد البيانات** | الجداول، حماية الرموز، طوابير المهام، معادلة الإحصائيات، الحصص | ✅ **مكتملة ومفحوصة محلياً** | البنية التحتية جاهزة ومحمية بالكامل |
| **٢. مسار إحصائيات حساباتك كمالك** | ربط الـ OAuth، سحب المنشورات، واجهات ولوحات تحكم حسابك | ⏳ **نبدأ فيها الآن** | سترى إحصائيات حسابك وتفاعلاته في الموقع |
| **٣. تتبع المنافسين** | قائمة مراقبة المنافسين، سحب المنشورات، شاشة المقارنة | ⏸️ **تبدأ بعد اعتماد المرحلة ٢** | ستتمكن من مراقبة أي حساب منافس ضمن باقتك |
| **٤. الفحص الحي والإطلاق** | اختبارات حسابات فيسبوك المعتمدة، الفحص النهائي، ورفع التحديث | ⏸️ **المرحلة الأخيرة** | إطلاق الميزة لجميع المستخدمين على الموقع |

---

## جرّبها بنفسك

> [!NOTE]
> **لا يوجد ما تضغط عليه في الموقع حالياً.**
> كل ما أُنجز هو بنية تحتية في الخلفية (Backend & Database). إذا دخلت على موقع Postora الآن لن تشاهد أي اختلاف، وهذا طبيعي ومتوقع تماماً في هذه المرحلة.

**متى ستتمكن من التجربة الفعلية؟**
بمجرد اكتمال **المرحلة الثانية**، سنقوم بتوفير مسار تجربة واضح يمكنك من خلاله الدخول على `/analytics/instagram`، واختيار حساب إنستقرام المربوط، ورؤية لوحة الإحصائيات وسحب البيانات وتفاعل المنشورات بنفسك.

---

## أشياء تحتاج تعرفها

1. **الـ PR ما زال مسودة (Draft PR #294):** هذا مقصود تماماً حتى تنتهي كل المراحل وتُفحص معاً كوحدة واحدة قبل الدمج في النسخة الحية.
2. **سلامة الحسابات والأداء:** تصميم الخلفية اعتمد على احترام أقصى درجات حدود فيسبوك لمنع حظر الـ API أو التأثير على سرعة تصفح المستخدمين.
3. **لا تكاليف ولا مفاجآت في الباقات:** تم اعتماد سياسة الإيقاف التلقائي للخدمات الخارجية المدفوعة (Apify) في المهام المجدولة، والاعتماد فقط على القنوات الرسمية ما لم يوافق العميل على غير ذلك.

---

# English

> **Status correction, 2026-11-01:** this is a historical snapshot from October 27. The statements below that #294 remains a draft, no UI exists and nothing has been deployed are superseded. See the [current Instagram, Facebook and Threads status review](2026-11-01-meta-analytics-status.md) for merged work, production evidence and remaining tasks. This correction does not authorize collection or close an activation gate.

## In short

We have completed **Phase 1 of 4** for the Instagram Insights and Competitor Tracking initiative.
Phase 1 established the secure database schema, tenant-safe credential isolation, resilient background job queues, quota enforcement by plan, and the outlier performance algorithm.
**No user-facing changes are visible on the live site yet.** All work is committed locally on branch `feat/instagram-insights-competitors` (Draft PR #294) and has not been pushed, merged, or deployed to production.

---

## What changed

Phase 1 focused on laying the secure and scalable foundation:

1. **Tenant-Safe Schema & Protected Credentials:**
   - Isolated snapshot and metrics tables with Row-Level Security (RLS) and composite foreign keys preventing cross-tenant access.
   - Facebook/Instagram user credentials stored in server-only, encrypted structures, never exposed to the client or frontend payloads.

2. **Durable Queues & Worker Primitives:**
   - Atomic job leases, checkpoints, and recovery mechanisms preventing lost work during unexpected restarts.
   - Bounded batch claims (25 accounts for owners, 50 for competitors) to respect Meta rate limits and prevent process timeouts.

3. **Database-Enforced Competitor Quotas:**
   - Free: up to 5 competitors.
   - Pro: up to 20 competitors.
   - Business: up to 30 competitors.
   - Admin: unlimited.
   - Enforced directly at the database transaction layer to prevent quota bypasses.

4. **Canonical Outlier Detection:**
   - Mathematical model comparing new posts against the rolling median of the last 12 mature posts (48h+) of the same format, flagging extraordinary performance (>=3x, >=1.5x, <=0.5x).

5. **Extensive Verification Suite:**
   - 120 database migrations verified on PostgreSQL 17.
   - 40 SQL test suites, 2,204 Node unit/integration tests, and 237 Deno tests passing with zero new lint or i18n regressions.
   - Concurrency and race-condition checks validated for simultaneous competitor additions and token refreshes.

---

## What did not change

- **No UI changes:** No new buttons, pages, or settings are visible in the product yet (these are built in Phases 2 and 3).
- **No live deployment:** The production servers and databases remain untouched.
- **No live background syncing:** Automated scraping and Graph API polling will be turned on only after Phase 4 sign-off.

---

## Four-Phase Roadmap

| Phase | Scope | Status | Notes |
|---|---|---|---|
| **1. Security & Foundations** | DB schema, protected credentials, job queues, outlier logic, quota engine | ✅ **Verified & Committed Locally** | Rock-solid backend foundation in place |
| **2. Owner Insights Flow** | Protected OAuth, owner ingestion worker, report API, and `/analytics/instagram` UI | ⏳ **Starting Now** | Brings end-to-end analytics for connected accounts |
| **3. Competitor Tracking** | Watchlists, public discovery sync, competitor UI, and quota limits | ⏸️ **Pending Phase 2 Acceptance** | Competitor comparison and trend tracking |
| **4. Live Testing & Release** | Meta live accounts verification, hosted CI, PR merge, and server deployment | ⏸️ **Final Phase** | Official rollout to production users |

---

## Try it yourself

> [!NOTE]
> **There is nothing to click in the browser right now.**
> All changes so far are internal database schemas and background services. Once Phase 2 is complete, you will be able to navigate to `/analytics/instagram` and test your live account insights.

---

## Things you should know

- **Draft PR Status:** PR #294 remains a draft to prevent premature merges while subsequent phases are assembled.
- **Zero Production Risk:** Because no code has been pushed or deployed, current production stability is 100% unimpacted.
- **API Safety:** Background sync workers are bounded to strict wall-clock and batch budgets to stay within Meta's API consumption thresholds.

---

## المهمة التالية / Next-Task Prompt

لو رغبت في إعطاء الأمر لعميل الذكاء الاصطناعي (Codex أو Grok أو غيره) للبدء فوراً في **المرحلة الثانية (Phase 2)**، يمكنك نسخ هذا البرومبت كما هو:

```text
Continue branch feat/instagram-insights-competitors for Postora. Phase 1 is verified and committed locally at commits 35f86867 and fd073772.

Read AGENTS.md, CLAUDE.md, ARCHITECTURE.md, and docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md.

Proceed with Phase 2 (Owner Insights Flow) in accordance with Task 2, Task 4 (owner slice), Task 6, and Task 9:
1. Complete protected OAuth and refresh integration for Instagram owner accounts.
2. Implement the bounded owner collection worker using claim limit 25.
3. Wire the authenticated database report reader / endpoint.
4. Build the Instagram performance UI on /analytics/instagram with user-isolated cache and null-aware metrics.
5. Maintain all security boundaries: no tokens in client payloads, strict tenant isolation, and zero regressions on existing suites.

Keep PR #294 draft, run repository test and typecheck gates, and do not push or deploy without approval.
```
