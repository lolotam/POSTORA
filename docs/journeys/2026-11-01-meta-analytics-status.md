# تحليلات Instagram وFacebook وThreads: المنجز والمتبقي

**الحالة:** مراجعة للكود والوثائق والإنتاج للقراءة فقط؛ ليست موافقة على التفعيل.
**المصدر:** `main` عند `dd7f02c303c5210147ab49184ce82c17be7a4ae9`، وطلب الدمج المفتوح [#326](https://github.com/lolotam/POSTORA/pull/326) عند `2771c8b177054d31e04ea6f8a171bb8cf9f70649`.
**وقت فحص الإنتاج:** 2026-10-31، الساعة 21:49 UTC، الموافق 2026-11-01، الساعة 00:49 بتوقيت الكويت. حالة GitHub روجعت في الجلسة نفسها.

هذا سجل حالة حديث، وليس بديلًا عن مواصفات القبول أو سجل موافقات الإطلاق. الأوصاف القديمة التي تقول إن #294 ما زال Draft أو إن الواجهة غير موجودة تخص وقت كتابتها. هذه المراجعة لا تغلق أي بوابة قبول تلقائيًا.

## باختصار

المنصات الثلاث لديها شاشات ومسارات برمجية، لكنها لا تقدم المنتج نفسه. Instagram لديه مسار لتجميع تاريخ الأداء وتقرير موحد، لكنه متوقف في الإنتاج. Facebook لديه تحليل صفحات ومنشورات عبر البحث. Threads لديه Insights مباشر للحسابات المرتبطة، بالإضافة إلى البحث والاكتشاف.

سبب رسالة Sync في Instagram هو `503 collection_disabled`. إصلاح شرح الرسالة في #326 اجتاز فحوصه، لكنه ما زال مفتوحًا ولا يفعّل جمع البيانات. توجد أيضًا نواقص مستقلة في pagination ومسار التقرير الداخلي، موثقة أدناه.

## وش تغيّر بالضبط

### حالة كل منصة

| المنصة | المنجز بالكود | ما ثبت في الإنتاج | المتبقي أو حدود النطاق |
|---|---|---|---|
| Instagram — الأداء | شاشة حساب/فترة، تقرير موحد، جداول يومية، workers، حماية ملكية، outlier وضوابط طرح تدريجي. | جذرا التقرير والمزامنة مطابقان لـ `main`. الجمع متوقف، وجداول الإحصائيات الثلاثة فارغة. | إصلاح فجوات التقرير، استكمال أدلة الإطلاق، ثم جمع تجريبي معتمد لحساب واحد. وجود الشاشة ليس دليلًا على جمع ناجح. |
| Instagram — التحليل والمنافسون | البحث، watchlist، عامل جمع المنافسين، تقرير وواجهة، وسياسة retention؛ #306 و#317 مدموجان. | جذرا تقرير المنافسين وعامل الجمع مطابقان لـ `main`. جداول cron للجمع والاحتفاظ غير مفعلة. | إصلاح فجوات الاكتشاف والتحقق من رحلة المنافسين. مسار Apify المدفوع المؤجل لا يدخل ضمن تفويض هذه المراجعة. |
| Facebook | `/analytics/facebook` يستدعي `useBrandScrape` ثم `brand-scrape` لتحليل صفحة ومنشورات، مع فرز وفلاتر وسجل/cache. | جذر `brand-scrape` مطابق لـ `main`. متغيرا `FACEBOOK_APP_ID` و`FACEBOOK_APP_SECRET` موجودان؛ لم تعرض قيمتهما. | لم تُجرَ تجربة Graph حية هنا. الشاشة ليست تقرير أداء تاريخي للحسابات المملوكة مماثلًا لـ Instagram. هذا فرق نطاق، لا ادعاء بوجود مهمة Facebook تاريخية معتمدة وغير منجزة. |
| Threads | البحث والاكتشاف والكلمات المفتاحية وInsights. الأخير يقرأ إجماليات الفترة الحالية والسابقة وtime series ومقاييس المنشورات عبر `threads-insights`. | جذور `threads-insights` و`threads-discovery` و`threads-keyword-search` مطابقة لـ `main`. | يلزم فحص حي بصلاحيات الحساب لكل مسار. المسار منفصل عن مفتاح جمع Instagram، وليس pipeline لقطات تاريخية مماثلًا له. |

مصادر التنفيذ: [FacebookAnalytics](../../src/pages/analytics/FacebookAnalytics.tsx)، [ThreadsAnalytics](../../src/pages/analytics/ThreadsAnalytics.tsx)، [ThreadsInsightsPanel](../../src/components/brand-intelligence/ThreadsInsightsPanel.tsx)، [threads-insights](../../supabase/functions/threads-insights/index.ts)، [brand-scrape](../../supabase/functions/brand-scrape/index.ts)، و[ميزة Instagram](../../src/features/instagram-insights/).

### مراجعة المهام الأصلية 1–11

الأرقام تخص [خطة Instagram والمنافسين الأصلية](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md#6-numbered-implementation-tasks). «موجود بالكود» لا تعني اكتمال كل شروط قبول المهمة.

| المهمة | المنجز | المتبقي قبل القبول الكامل |
|---|---|---|
| 1 — القرارات والقدرات الحية | سجلات قرارات وفحوص تاريخية في الخطة؛ أُضيف فحص إنتاجي حديث للقراءة فقط. | توحيد الأدلة على candidate ثابت وإكمال حالات Meta الحية لكل نوع ربط. |
| 2 — Discovery/OAuth والتوافق | حماية بيانات الاعتماد ومسارات reconnect موجودة، منها #298. | قارئ الاكتشاف ما زال يستعمل `account_metadata.granted_scopes`؛ `BrandPost.likesCount` ما زال `number`. متطلبات provenance وnullable mapping وcache/history تحتاج إثباتًا متكاملًا. |
| 3 — schema والملكية والحصص والطوابير | بنية الميزة مدموجة في #294؛ ضوابط R1/R2/C1 في #317. الـ runbook يسجل تطبيقها في الإنتاج قبل runtime. | إعادة مطابقة catalog/types/grants والـ migration ledger الكامل على candidate الإطلاق؛ الفحص الحالي ليس إعادة تشغيل لكل SQL/race tests. |
| 4 — workers والجدولة | workers وأذونات provider وضوابط الجمع لكل هدف وdaily dispatch موجودة. | الجدولة غير نشطة؛ يلزم manifest وboot/rollback proofs والموافقات التشغيلية. ضوابط rollout نفسها لم تعد عملًا غير منفذ. |
| 5 — outlier وتجميع التقرير | domain scorer وreport assembler موجودان مع اختبارات. | إثبات التقرير بأرقام حقيقية، والتاريخ المرجعي وnulls والفترات على candidate نهائي. |
| 6 — جمع حساب المالك | مسارا page-linked/direct موجودان مع طوابير وحدود عمل وفحوص. | أول جمع حي معتمد وإثبات المقاييس والتواريخ والاستمرار والحفظ؛ جداول الإنتاج فارغة الآن. |
| 7 — جمع المنافسين | watchlist وعامل جمع ومنافذ Graph/Apify موجودة. | جمع هدف تجريبي معتمد وإثبات استبعاد بقية الأهداف؛ مسار Apify المدفوع يبقى مؤجلًا حسب القرار القائم. |
| 8 — واجهة المنافسين والاحتفاظ | #306 مدموج: UI وreport endpoint وretention بمفتاح مستقل. | رحلة حية وإثبات سلامة الاحتفاظ؛ cron الاحتفاظ غير نشط. |
| 9 — واجهة الأداء والتنقل | شاشة الأداء وروابط تبويبات Instagram موجودة. | pagination وcursor غير مكتملين؛ راجع العيبين أدناه. #326 يعالج رسالة رفض Sync فقط. |
| 10 — API/MCP والعقد الموحد | proxy يوجّه Instagram للتقرير وThreads لـ `threads-insights`. | إصلاح 401 لمسار تقرير Instagram الداخلي واختبار parity عبر composition الفعلي. Facebook غير مدعوم في فرع `get_post_analytics` هذا حاليًا. |
| 11 — القبول والرحلات والتسليم | spec/plan في #309 وتحديثهما في #320 مدموجان؛ هذا التقرير يحدّث الحالة للمستخدم. | checker والـ fixtures والأدلة المجمعة والرحلات النهائية وموافقات B–E لم تُغلق. تقرير الحالة وحده لا يحقق G-X أو G-L. |

### نواقص محددة لمهام إصلاح مستقلة

1. **رسالة Sync — #326 مفتوح.** المحوّل كان يرمي رسالة SDK العامة بدل سبب الرفض. #326 يستخدم `invokeErrorMessage` ويترجم `collection_disabled`. اجتازت نسخته 30 اختبارًا محليًا، typecheck وbuild وبوابة lint/i18n؛ وجميع checks التي أبلغ عنها GitHub ناجحة. لم يُدمج وقت المراجعة ولا يغيّر تشغيل الجمع.
2. **pagination — فجوة بالكود، لا تجربة متصفح مكتملة.** [الشاشة](../../src/features/instagram-insights/ui/InstagramPerformanceScreen.tsx) لا تمرر cursor أو `onLoadMore`. [الجدول](../../src/features/instagram-insights/ui/MediaPerformanceTable.tsx) لا يعرض Load more إلا مع callback، والاستعلام الافتراضي يطلب 20 عنصرًا. يلزم توصيل الصفحة التالية واختبار تراكم النتائج وعدم تكرارها.
3. **عقد cursor غير متطابق.** [المحوّل](../../src/features/instagram-insights/infrastructure/supabaseInstagramInsightsGateway.ts) يرسل `published_at` و`media_id`، بينما [parseCursor](../../supabase/functions/instagram-insights-report/handler.ts) يقبل `publishedAt` و`mediaId`. يلزم اختبار الحد بين المحوّل والـ handler. هذا لا يفسر رفض Sync الحالي.
4. **تقرير Instagram عبر service role يرجع 401 — أُعيد إنتاجه للقراءة فقط.** أُرسل POST بمفتاح الخدمة المحفوظ على الخادم، وحساب مملوك و`user_id` صحيحين؛ عاد `UNAUTHORIZED`. [جذر الدالة](../../supabase/functions/instagram-insights-report/index.ts) يستدعي `authenticateCaller(req)` بلا `bodyUserId`، بينما [مساعد المصادقة](../../supabase/functions/_shared/auth-helper.ts) يشترطه لهذا المسار. [proxy](../../supabase/functions/n8n-api/serviceProxy.ts) يرسل المعرف داخل الجسم بالفعل. يجب أن يحافظ الإصلاح على هوية JWT للمستخدم وعلى فحوص الملكية.

### أدلة الإيقاف الحالية

فحص SQL للقراءة فقط عند التوقيت المثبت أعلى التقرير:

- لا يوجد صف `collection_instagram_insights_enabled`؛ النتيجة الفعلية `collection_disabled`.
- `collection_instagram_rollout_policy`: كل من `owners.mode` و`competitors.mode` يساوي `off`، وقائمتا الأهداف فارغتان.
- الجداول `ig_media_insight_snapshots` و`ig_account_insight_daily` و`ig_account_profile_observations`: صفر صفوف في كل منها.
- وظائف cron الموجودة وغير النشطة: `instagram-insights-enqueue-daily`، `instagram-insights-drain`، `competitor-snapshot-enqueue-daily`، `competitor-snapshot-drain`، `competitor-retention`.
- سجلا Sync لحساب `curemedkw` عند 21:15:41 و21:15:53 UTC يوم 2026-10-31 يثبتان `503 collection_disabled`.

الحالة متسقة مع [runbook الطرح التدريجي](../runbooks/instagram-collection-rollout.md). لا تُعِد تنفيذ R1/R2/C1 لمجرد أن خطة أقدم تصفها بأنها غير منفذة؛ طابق الكتالوج الحالي أولًا.

## وش ما تغيّر

هذه مراجعة وتحديث وثائق. لم تغيّر مفاتيح الجمع أو قوائم الحسابات، ولم تشغّل cron أو تجمع بيانات من Meta/Apify أو تنشر منشورًا. لا migrations أو تغييرات production code في تحديث الوثائق هذا.

تطوير أداء تاريخي جديد لـ Facebook أو Threads يحتاج تحديدًا منفصلًا للمقاييس والتخزين والصلاحيات والقبول. خطة Instagram لا تمنح تلقائيًا قبولًا أو تفويضًا لتلك الإضافة. كذلك [صفحة Analytics للمطورين](../developer/analytics.md) تخص public API v1؛ عبارتها «غير متاح» لا تنفي وجود الشاشات والـ proxy الداخلي.

## جرّبها بنفسك

لم تتضمن المراجعة تسجيل دخول ومتصفحًا لكل منصة أو طلبات provider حية. هذه رحلة تحقق مقترحة، وليست اختبارات منجزة. أي Sync أو تحليل جديد قد يبدأ عملًا أو استهلاك API؛ نفّذه ضمن فحص معتمد للحساب.

| # | الخطوة | المتوقع أو ما يجب إثباته |
|---|---|---|
| 1 | افتح [أداء Instagram](https://postora.cloud/analytics/instagram?tab=performance)، واختر الحساب والفترة. | الفصل بين تقرير بلا تاريخ وخطأ تحميل، وعدم عرض البيانات غير المتاحة كصفر مؤكد. |
| 2 | في تجربة Sync معتمدة، افحص الرفض قبل التفعيل. | قبل نشر #326 قد تبقى رسالة SDK العامة؛ بعد نشره يجب شرح سبب الإيقاف بالعربية والإنجليزية. |
| 3 | بعد جمع معتمد لحساب واحد، افحص التقرير ثم الصفحة التالية. | قيم محفوظة وfreshness صحيح؛ يلزم إصلاح pagination لقبول نهاية الخطوة. |
| 4 | افتح [Facebook Analytics](https://postora.cloud/analytics/facebook) وحلل صفحة متفقًا عليها. | إثبات المصدر والمقاييس والصلاحيات، والفصل بين cache وطلب جديد؛ ليست لوحة لقطات تاريخية. |
| 5 | افتح [Threads Insights](https://postora.cloud/analytics/threads?tab=insights)، واختر حسابًا وفترة. | إثبات إجماليات الفترتين والمقاييس المتاحة، وإظهار نقص الصلاحية أو البيانات بوضوح. |
| 6 | جرّب [الاكتشاف](https://postora.cloud/analytics/threads?tab=discovery) و[الكلمات المفتاحية](https://postora.cloud/analytics/threads?tab=keyword_search) ضمن الفحص المعتمد. | تحقق مستقل من كل endpoint وصلاحياته وpagination؛ نجاح Insights وحده لا يثبت نجاحهما. |

**للتأكد إنها اشتغلت فعلًا:** اربط الواجهة برد الخادم والحساب المالك والفترة والمصدر. في Instagram أضف دليل حفظ اللقطات وjob status؛ في Facebook وThreads لا تعتبر الشاشة أو مفاتيح التطبيق إثباتًا لنجاح Meta.

## أشياء تحتاج تعرفها

ترتيب العمل المقترح:

1. مراجعة ودمج #326 ونشر الواجهة وفق المسار المعتاد؛ لا يعتبر ذلك تفعيلًا للجمع.
2. إصلاح مصادقة تقرير Instagram الداخلي، ثم cursor وpagination، مع اختبارات تمر عبر الحدود الفعلية.
3. إغلاق فجوات Task 2 ثم Task 11 على candidate ثابت. الملفات المقترحة `scripts/check-instagram-release-gates.mjs` و`e2e/fixtures/instagramReleaseServer.ts` و`e2e/fixtures/instagramReleaseSeed.ts` و`docs/runbooks/instagram-insights-release.md` غير موجودة في `main` المفحوص.
4. استكمال [بوابات B وC وD](../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step): manifest ومطابقة schema/runtime، حساب تجريبي مسمى، reconnect والصلاحيات، ثم جمع ذلك الحساب وإثبات استبعاد الآخرين. لا تختصرها بتشغيل المفتاح العام.
5. بعد نجاح حساب المالك: تجربة منافس واحدة، ثم جدولة تدريجية وretention بموافقتها المستقلة وفق البوابة E.
6. إجراء تحقق حي مستقل لـ Facebook وThreads. بعدها يُحدد نطاق أي تطوير جديد لتوحيد التاريخ والمقاييس، بدل معاملته كتفعيل لمفتاح Instagram.

**حدود الأدلة:** لم تُعد المهمة تشغيل كامل Node/Deno/SQL/E2E للميزة أو اختبارات Facebook وThreads. اختبارات #326 وCI تخص ذلك الإصلاح ولا تغلق قبول المنصات الثلاث. hashes أدناه تخص entrypoints فقط، وليست manifest لكل imports أو دليلًا لنسخة frontend المنشورة. `mem0` غير متاح في هذه الجلسة.

---

# English

## In short

The three analytics pages exist, but their data products differ. Instagram has a historical owner-report pipeline deployed in the off state. Facebook offers searched Page/content analysis. Threads offers live connected-account insights, discovery and keyword search. This does not establish equivalent historical coverage or live acceptance across all three.

## What changed

The review reconciles original Instagram tasks 1–11 with merged code, production switches, inactive schedules, empty owner-insight tables and open PR #326. #294, #298, #306 and #317 are merged. The documentation/control records #309/#310/#311/#320 are not activation receipts. #326 remains open with successful reported checks; it explains the disabled Sync response without enabling collection.

Remaining defects include unwired report pagination, snake_case cursor fields sent to a camelCase handler contract, and a reproduced HTTP 401 from a correctly scoped internal service-role report request. The composition root omits the body user identifier required by its authentication helper. The Arabic task matrix and source links above form the detailed inventory, not a retroactive gate sign-off.

## What did not change

No production setting, schedule, provider data, credential, account or post was changed. Historical approval ledgers remain untouched. This documentation update does not authorize collection, paid Apify work or new Facebook/Threads historical analytics products.

## Try it yourself

Use the six-step route journey above in an approved account test. Check the response, owner, period, source and persisted history. Facebook/Threads live provider calls and the full Instagram release journeys were not executed during this review.

## Things you should know

Finish the small error-message PR, repair report boundaries, close discovery and assembled-evidence gaps, then follow B–E for a named pilot. Verify Facebook and Threads independently before deciding product expansion. Component/CI passes do not constitute live rollout approval.

## Entrypoint hash evidence

These deployed `index.ts` hashes matched exact `main` blobs at the revision named above. No credential values were printed or stored.

| Function | SHA256 |
|---|---|
| `brand-scrape` | `f3f5a0744abbd63e5ac2d26692630347cf367b5e0c45efea1095ee7f5b9d71ab` |
| `threads-insights` | `cd98d9d40c99f038aecfaaf030e9c0367ca30d78476e84b88b2204b7c1c7b980` |
| `threads-discovery` | `f13c05c176a1702af8f3aa08aaa68ca4a2d7c978c76e94a74e1b375d53f207bd` |
| `threads-keyword-search` | `8d15fc6f2cef1b19b1792c4050bfff323a8167ad34e5db9d0df2caf216f9f0b8` |
| `instagram-insights-report` | `dfb453a0d660aea33af7bc721542d50895abb94376d4b4f4d97d97c4b4d48078` |
| `instagram-insights-sync` | `391407b3347e55f5e3e06fd9c3412b944e75f3fa2070ea1432108a3997a0df1f` |
| `competitor-tracking-report` | `e46b529f5ab886d87c8727a5cd381cb79d7d41607eda3fc1e9a15b8d9f2b5697` |
| `competitor-snapshot-sync` | `d8c52c2082795decd22ed23ad92bc510626f2553c5f1de1032eda39ae6443b1a` |

## المهمة التالية

```text
Read AGENTS.md, ARCHITECTURE.md and docs/journeys/2026-11-01-meta-analytics-status.md first.
Fix the reproduced service-role authentication failure in the actual instagram-insights-report composition root, preserving normal user-JWT identity and structural account ownership. Read supabase/functions/_shared/auth-helper.ts and supabase/functions/n8n-api/serviceProxy.ts. Add a real-composition regression and a cross-owner rejection; injected successful authentication alone is insufficient.
Then address the cursor mismatch and unwired pagination in src/features/instagram-insights in a separate scoped change. Prove page accumulation without duplicates.
Use a feature branch and scoped commits. Apply clean-code-guard and test-guard; run relevant Node/Deno/SQL checks, typecheck, build and scripts/ci/lint-i18n-regression.mjs. Deploy changed Edge Functions only through the project runbook and the authorized scope.
Do not change collection switches, rollout targets, credentials, cron activation, paid Apify policy or applied migration bytes. Gates B–E remain separate approved operations. Facebook and Threads require independent live verification; no new historical analytics scope is implied.
```
