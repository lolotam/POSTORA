# حماية إعدادات الوكيل من الضياع، وإصلاح الحسابات اللي تظهر حمراء بدون سبب

**الحالة:** مدموج ومرفوع على السيرفر ✅
**المصدر:** PR #69 · ٢٨ ملف · دُمج ٢٩ أغسطس · رُفع ٣٠ أغسطس

---

## باختصار

شيئين مختلفين تماماً انشحنوا مع بعض:

**الأول تشوفه بعينك** — صفحة إعدادات الوكيل الذكي كانت تضيّع اللي تكتبه إذا غيّرت
الحساب أو المنصة قبل ما تحفظ، بدون أي تحذير. الحين يطلع لك سؤال قبل ما يضيع شي.

**الثاني ما تشوفه** — النظام كان أحياناً يعلّم حسابات سليمة بالأحمر ويطلب إعادة ربط
بدون داعي. صار يفرّق بين انقطاع مؤقت وبين صلاحية انتهت فعلاً.

---

## وش تغيّر بالضبط

### ١. صفحة إعدادات الوكيل: ما تضيع كتابتك بعد اليوم

المشكلة كانت إن حقل «الشخصية والتعليمات» نص طويل تكتب فيه، وأي حركة تطلعك منه كانت
تمسحه بدون ما تحس:

- تغيّر الحساب من القائمة → راح اللي كتبته
- تغيّر المنصة (واتساب، إنستقرام، فيسبوك، ثريدز) → راح اللي كتبته
- تطفي أو تشغّل «الرسائل» أو «التعليقات» → راح اللي كتبته

الحين بأي حركة من هذي يطلع لك مربّع فيه خيارين:

• **`Keep editing`** → يرجّعك للنص اللي كنت تكتبه، وما يتحرك شي
• **`Discard changes`** → يكمل الحركة اللي طلبتها، واللي كتبته يروح — بس هذي المرة
  أنت اللي قررت

وفيه شي ثاني أهم: قبل، لو النظام ما كان محمّل إعدادات الحساب الجديد بعد، كان ممكن
يخليك تكتب ويحفظ كلامك **على حساب غلط**. الحين الحقول تنقفل مؤقتاً لين تخلص التحميل،
وزر الحفظ يكون مطفي أصلاً — فما فيه فرصة إن كلامك يروح للحساب الخطأ.

### ٢. الحسابات الحمراء: النظام صار أذكى بالحكم

المشكلة إن النظام كان يعامل أي فشل بنفس الطريقة. لو الشبكة تعثّرت لحظة، أو فيسبوك
كان مزحوم، كان يحسبها محاولة فاشلة — وبعد ثلاث مرات كذا يعلّم الحساب بالأحمر ويطلب
إعادة ربط، مع إن الحساب سليم مية بالمية. والأسوأ إن التعليم بالأحمر **ما كان يرجع
لحاله**؛ النظام يتجاهل الحسابات الحمراء ولا يحاول معها مرة ثانية.

الحين يفرّق بين حالتين:

• **انقطاع مؤقت** (شبكة، أو ضغط على منصة فيسبوك) → يعيد المحاولة لاحقاً، وما يحسبها
  ضدك إطلاقاً — ولا حتى يزيد عدّاد المحاولات الفاشلة
• **الصلاحية انتهت فعلاً** (فيسبوك رجّع إن التفويض ملغي) → يعلّمه بالأحمر من أول
  مرة، بدون ما ينتظر ثلاث محاولات

يعني صار **أسرع** بالحالة الحقيقية، و**أصبر** بالحالة الوهمية.

### ٣. أشياء إضافية تصلّحت بالطريق

- كانت هناك احتمالية إن النظام يمسح رمز دخول شغّال لحساب إنستقرام **قبل نشر منشور
  مجدول مباشرة** — يعني المنشور يفشل والحساب ينكسر بنفس اللحظة. هذي أُغلقت.
- حسابات إنستقرام المربوطة بطريقة Business Login كانت تروح للمسار الغلط عند تجديد
  الصلاحية. تصلّحت.
- اكتشفنا وقت الرفع إن خدمة «المنشورات المجدولة» على السيرفر كانت شغالة **بدون قفل
  الحماية** الموجود بالكود. الرفع أرجع القفل مكانه.

---

## وش ما تغيّر

- **شكل الصفحات ما تغيّر.** ما فيه أزرار جديدة ولا تصميم جديد — المربّع الجديد يطلع
  فقط لو كنت كاتب شي وما حفظته.
- **الحسابات الحمراء الموجودة حالياً حمراء لأنها فعلاً محتاجة إعادة ربط**، مو غلط من
  النظام. الإصلاح يمنع المشكلة من التكرار، ما يرجّع حسابات انتهت صلاحيتها.
- **لو ضغطت رابط بالقائمة الجانبية وطلعت من الصفحة، كتابتك بتضيع بدون تحذير.** هذي
  الحالة تحديداً ما انغطّت — وسببها تقني: يحتاج تغيير طريقة التنقل بالتطبيق كامل،
  وهذا مشروع منفصل بمخاطر خاصة فيه.

---

## جرّبها بنفسك

### التجربة الأولى: حماية الكتابة (فيها شي تضغطه)

| # | الخطوة | المتوقع |
|---|---|---|
| ١ | افتح `https://postora.cloud/automation/agents` | تفتح صفحة إعداد الوكيل |
| ٢ | اختر منصة فيها **حسابين أو أكثر** مربوطين (إنستقرام مثلاً) | تظهر قائمة اختيار الحساب |
| ٣ | اكتب أي شي بحقل «الشخصية والتعليمات» — لا تحفظ | النص يظهر بالحقل |
| ٤ | غيّر الحساب من القائمة | يطلع مربّع **`You have unsaved changes`** |
| ٥ | اضغط **`Keep editing`** | المربّع يختفي، **نصّك موجود زي ما هو**، والحساب ما تغيّر |
| ٦ | غيّر الحساب مرة ثانية، وهالمرة اضغط **`Discard changes`** | ينتقل للحساب الثاني وتظهر إعداداته هو |
| ٧ | ارجع اكتب شي، وغيّر **المنصة** من فوق | نفس المربّع يطلع — لأن تغيير المنصة برضه يضيّع الكتابة |
| ٨ | اكتب شي واضغط **حفظ**، وبعدها غيّر الحساب | **ما يطلع مربّع** — لأنك حفظت، ما فيه شي يضيع |

**للتأكد إنها اشتغلت فعلاً:** بعد الخطوة ٦، حدّث الصفحة (F5) وارجع للحساب الأول.
لازم تشوف إعداداته الأصلية — يعني اللي كتبته وضغطت `Discard` عليه فعلاً ما انحفظ،
واللي كان محفوظ من قبل ما تأثر.

### التجربة الثانية: الحسابات الحمراء (ما فيه شي تضغطه)

هذا الجزء **ما له واجهة تجربه فيها** — يشتغل بالخلفية كل فترة لحاله. الطريقة الوحيدة
للتحقق هي المراقبة:

- افتح صفحة الحسابات المربوطة وسجّل كم حساب أحمر عندك اليوم
- خلال الأيام الجاية، المفروض **ما تشوف حساب يصير أحمر وأنت متأكد إنه سليم**
- الحسابات الحمراء الحالية بتبقى حمراء لين تعيد ربطها يدوياً — هذا صحيح ومقصود

الوضع الحالي على السيرفر بعد الرفع مباشرة: **٤ فيسبوك، ١١ إنستقرام، ١١ ثريدز** حمراء،
وكلها صلاحياتها منتهية فعلاً — ولا حساب واحد منها أحمر بسبب انقطاع شبكة.

---

## أشياء تحتاج تعرفها

- **الرفع تم والتغييرات شغالة الحين** على `api.postora.cloud`، والاختبارات كلها نجحت
  (٧٤٩ اختبار خلفي و١٠٣٠ اختبار واجهة، بدون أي فشل).
- **بس فيه شي ما اتأكدنا منه عملياً:** ما جرّبنا نجدّد صلاحية حساب حقيقي يدوياً بعد
  الرفع للتأكد من السلوك الجديد على أرض الواقع. الاختبارات تقول إنه صحيح، والمؤشرات
  على السيرفر سليمة، بس التجربة الفعلية على حساب حي ما صارت.
- **فيه شغل تأجّل بقرار مدروس:** كانت هناك خطة لمنع تعارض لو صارت عمليتين تحدّثان نفس
  الحساب بنفس اللحظة. تبيّن إن الحل المقترح ناقص وممكن يسبب مشكلة أكبر من اللي يحلها،
  فانسحب بدل ما ينشحن ناقص.

---

# English

## In short

Two unrelated changes shipped together. One you can see: the AI agent settings page used to
discard whatever you had typed if you switched account or platform before saving — silently. It
now asks first. One you can't see: the system was sometimes flagging perfectly healthy social
accounts red and demanding reconnection. It now tells a temporary network blip apart from a
genuinely expired authorisation.

## What changed

**Unsaved-changes protection.** The persona field is long free text, and three separate actions —
switching account, switching platform, toggling DMs or Comments — used to wipe it without warning.
All three now prompt with `Keep editing` / `Discard changes`. Separately, while a newly selected
account's settings are still loading, the fields are locked: previously you could type into a form
that was about to be overwritten, and in the worst case have your text saved against the wrong
account.

**Smarter account health.** The system treated every refresh failure identically, so three
momentary network hiccups would retire a healthy account — and the red flag never cleared itself,
because flagged accounts are skipped on subsequent runs. It now distinguishes a transient failure
(retried, and not counted against the account at all) from provider-confirmed revocation (flagged
immediately, without waiting for three attempts). Faster on real failures, far more patient on
false ones.

**Fixed along the way.** A path that could have wiped a working Instagram token immediately before
publishing a scheduled post; Instagram Business Login accounts being routed to the wrong refresh
endpoint; and — found during deployment — the scheduled-posts service running on the server without
the auth guard the code already contained.

## What did not change

No new buttons or layout. Currently-red accounts are red because they genuinely need reconnecting —
this prevents recurrence, it doesn't revive expired ones. And leaving the page via a sidebar link
still loses unsaved text: covering that needs a router migration, which is a separate project.

## Try it yourself

Go to `https://postora.cloud/automation/agents`, pick a platform with two or more connected
accounts, type into the persona field without saving, then switch account — you should get the
`You have unsaved changes` dialog. `Keep editing` preserves both your text and the original
account; `Discard changes` moves on and loads the new account's values. Save first, and switching
prompts nothing. To confirm it truly worked, refresh the page after discarding and check the first
account still shows its original settings.

The account-health change has no UI to exercise. Watch over the coming days that no account you
believe is healthy turns red.

## Things you should know

Deployed and live; all gates green (749 backend, 1030 frontend tests, zero failures). Not yet
verified end-to-end against a live account refresh — the tests and the server-side indicators say
it's correct, but a real forced refresh hasn't been run. One piece of planned work was deliberately
dropped: a concurrency guard whose proposed design turned out to be incomplete in a way that could
have caused a worse problem than it solved.

---

## المهمة التالية

فيه بند واحد باقي فعلاً — التحقق العملي على حساب حي. هذا برومبت جاهز للنسخ:

```text
Verify the PR #69 Meta refresh behaviour against live production accounts on the
self-hosted Supabase stack (Contabo 86.48.2.205, stack postorasupabase-supabase-j8axyh).
Use ssh-contabo-mcp only. Read ARCHITECTURE.md §26 and
docs/superpowers/plans/2026-08-29-meta-refresh-hardening.md Task 6 Step 4 first.

Read CRON_SECRET from the edge-functions container environment (never echo its value),
then force a refresh for one account of each kind and record needs_reauth, failure_count
and last_refresh_error before and after:
  1. a healthy Facebook Page account   -> expect status "refreshed", stays green, failure_count 0
  2. an account with a genuinely expired token -> expect "failed", stays red, failure_count +1
  3. the same account pressed twice inside 5 minutes -> expect "cooldown" on the second,
     and NO second failure recorded

Then confirm the invariant that no account is red because of infrastructure noise:
  select platform, platform_username, failure_count, last_refresh_error
  from social_accounts
  where is_active and needs_reauth
    and platform in ('facebook','instagram','threads')
    and (last_refresh_error ilike '%timeout%' or last_refresh_error ilike '%network%');
Expected: zero rows. Any row is a healthy account latched by a transient failure — the
regression this PR exists to prevent. If found, roll back from /root/fn-backup-pr69-*.

Do not redeploy, do not modify code, and report the before/after table verbatim.
```
