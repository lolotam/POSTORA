# أساس الميزة جاهز جزئياً، والتكامل ما زال قيد التنفيذ

**الحالة:** قيد التنفيذ والمراجعة؛ غير مدموج وغير مرفوع للسيرفر.
**المصدر:** [PR #294](https://github.com/lolotam/POSTORA/pull/294) · سجل التعديلات حتى `e90f47c3` وحالة الملفات المحلية · 2026-10-27.

## باختصار

المنجز هو أساس قاعدة البيانات، حدود تتبع المنافسين، وحساب المنشورات الاستثنائية مع اختبارات فعلية. الميزة الكاملة ليست جاهزة بعد: جمع البيانات والواجهات والتكامل البرمجي لم تكتمل.

## وش تغيّر بالضبط

- حُفظت خطة التنفيذ والقرارات وحدود الخطط: Free 5، Pro 20، Business 30، وAdmin بلا حد.
- أُنجزت حماية حالة صلاحيات Instagram من نتائج الطلبات القديمة، ومخطط اللقطات وقائمة المنافسين وفرض الحدود داخل قاعدة البيانات.
- نجحت اختبارات الصلاحيات والتتبع على PostgreSQL 17 بقاعدة مماثلة لبنية الإنتاج. نجحت تجربتا التزامن لإضافة منافسين مختلفين وإضافة الحساب نفسه، مع تنظيف بيانات التجربة.
- أُنجز حساب المنشورات الاستثنائية، ونجحت اختباراته الـ28. لم يُوصل بعد بتقرير متاح للمستخدم.
- أُصلحت مشكلة تثبيت الحزم وثلاث مشكلات قديمة في تجهيز اختبارات قاعدة البيانات. هذه تعديلات داخلية، لا تغيّر واجهة المنتج.

## وش ما تغيّر

لا توجد شاشة جديدة منشورة، ولا جمع تلقائي جديد، ولا تعديل مطبق على قاعدة الإنتاج. لم يُدمج طلب التعديلات ولم يحدث deploy (رفع التحديث للسيرفر).

## جرّبها بنفسك

لا يوجد مسار جديد في الموقع لتجربته الآن. يمكنك متابعة حالة التنفيذ في PR #294؛ نجاح اختبار محلي لا يعني أن الميزة متاحة على الموقع.

## أشياء تحتاج تعرفها

المهام النشطة: MiniMax Flash ينفذ عقد التقرير وتجميعه؛ Grok يصلح تخزين رموز Facebook User وإغلاق مسار كتابة قديم يتجاوز فحص الإصدار؛ وGrok يصلح بوابة فحص الكود وفق مراجعة المستشار. هذه الملفات غير معتمدة بعد.

اختبارات GitHub لا تبدأ بسبب مشكلة دفع أو حد إنفاق على الحساب. تشغيل اختبارات PostgreSQL محلياً أصبح ممكناً، لكن آخر تشغيل كامل لم ينجح بعد، وتجهيز Vault في المشغّل ما زال قيد الإصلاح. لا تُعتبر هذه العوائق نجاحاً ولا تُتجاوز للدمج.

المتبقي يشمل ربط OAuth والتجديد والاكتشاف، الطوابير والعمال، جمع بيانات المالك والمنافسين، التقارير وAPI، الواجهات، اختبارات الاستخدام، مراجعات الدمج والتحقق الحي. Stories وأدوات المنافسين الاختيارية في MCP وApify المجدول مؤجلة عمداً.

---

# English

## In short

Foundational slices are implemented and tested; the complete feature is not ready. No end-to-end feature delivery is release-complete yet.

## What changed

Committed: plan and approved quotas, lockfile repair, generation-fenced Instagram capabilities, tracking/snapshot schema and database quota enforcement, outlier algorithm with 28 passing tests, and three bounded legacy SQL-test fixes. Capability/tracking suites and two-session quota races independently passed on PostgreSQL 17 with the production-shaped baseline. These are distinct from a full integrated harness pass.

| Plan task | Current state |
|---|---|
| 1. Decisions and live capability verification | Decisions settled; live provider probes pending. |
| 2. Discovery/OAuth and compatibility | Not integrated; waits for credential contract correction. |
| 3. Schema, ownership, quotas and durable primitives | Capability/tracking schema committed; unified credential storage under correction; types/registration integration and job primitives unfinished. |
| 4. Gateway and bounded workers | Not implemented. |
| 5. Outliers and report assembly | Outlier algorithm committed/tested; owner report contract/assembler being implemented by MiniMax Flash. |
| 6. Owner insights collection | Not implemented. |
| 7. Competitor application and sync | Watchlist database foundation only; application/sync not implemented. |
| 8. Competitor UI and retention | Not implemented. |
| 9. Performance UI/navigation | Not implemented. |
| 10. Read API/MCP integration | Not wired. Optional competitor MCP tools deliberately deferred. |
| 11. Gates, journeys and release | Draft PR open; CI correction ongoing; full integrated SQL/browser/review/release gates unfinished. |

## What did not change

No production deployment, database migration, new collection schedule or user-visible screen. Nothing merged. Local commits after `43772de6` have not yet been pushed to the draft PR at this checkpoint.

## Try it yourself

There is no new live interface to click yet. Follow [draft PR #294](https://github.com/lolotam/POSTORA/pull/294) for delivery status; do not test the production site expecting these features to exist.

## Things you should know

Three active assignments: MiniMax Flash owner-report assembly; Grok credential fencing/storage correction plus harness bootstrap; Grok native-ESLint gate repair. Advisor Codex Astra 6 High remains read-only. Initial implementations and review fixes stay in their approved model lanes.

GitHub Actions is billing/spending-limit blocked before any steps execute. Full PostgreSQL harness is not yet passing; individual feature suites/races do not replace it. Live token/provider-day validation and deployment prerequisites remain unverified. Merge stays blocked rather than overriding these gates. Most end-user collection and UI work remains ahead.

---

## المهمة التالية

```text
Continue branch feat/instagram-insights-competitors using the implementation plan and ARCHITECTURE.md. Preserve active agents' files. Initial work stays with minimax-coding-plan/MiniMax-M3.1-Flash; all review fixes with Grok 4.7 Fast; Codex Astra 6 High is read-only advisor. Review and independently validate the active owner report, credential authority/fencing and CI native-analysis deliveries. Finish schema types/harness integration and obtain an actual full PostgreSQL 17 baseline-plus-delta pass. Then implement remaining tasks in dependency order, including durable collection, shared backend reports/API, UI and journeys. Keep collection disabled and PR #294 draft until final checks, reviews, live prerequisites and deployment compatibility pass. Do not change GitHub billing or substitute local checks for hosted success; do not bypass failing gates.
```
