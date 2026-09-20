# Output Template

Use this structure every time. Consistency is what lets the reader skim to the part they need
instead of reading the whole thing.

Arabic first — it is the primary language. English is a peer section, not an appendix.

Omit any section that has no honest content. An empty heading is worse than a missing one.

---

## Structure

```markdown
# <عنوان يصف النتيجة، مو العملية>

<!-- e.g. «إصلاح مشكلة الحسابات اللي تظهر حمراء بعد إعادة الربط» -->
<!-- not «تقرير عن الـ PR رقم ٦٩» -->

**الحالة:** <مدموج ومرفوع للسيرفر | مدموج بس ما انرفع بعد | تحت المراجعة>
**المصدر:** PR #<N> · <عدد> ملفات · <تاريخ>

---

## باختصار

<جملتين أو ثلاث. وش كانت المشكلة، ووش صار الحين. لا تدخل بالتفاصيل هنا.>

## وش تغيّر بالضبط

<الشرح الحقيقي. السبب قبل النتيجة. استخدم النقاط للحالات والمسارات.>

<لكل تغيير يشوفه المستخدم: قبل وبعد.>

## وش ما تغيّر

<الأشياء اللي ممكن يتوقع إنها تغيّرت وما تغيّرت — وخصوصاً الشغل الداخلي
اللي ما راح يشوف له أثر. الصراحة هنا تبني الثقة.>

## جرّبها بنفسك

<إذا فيه شي يُضغط: خطوات مرقّمة برابط حقيقي واسم زر حقيقي.>
<إذا ما فيه: قل هذا صراحة، ووش يراقب بدالها وخلال أي مدة.>

| # | الخطوة | المتوقع |
|---|---|---|
| ١ | ... | ... |

**للتأكد إنها اشتغلت فعلاً:** <خطوة تحقق تتجاوز شكل الواجهة>

## أشياء تحتاج تعرفها

<المخاطر، المؤجّل، اللي انرفض بالمراجعة وليش، أي شي يمس فلوس أو
بيانات أو عملاء. احذف القسم إذا ما فيه شي حقيقي.>

---

# English

## In short
## What changed
## What did not change
## Try it yourself
## Things you should know

---

## المهمة التالية

<فقط إذا فيه شغل ناقص فعلاً. برومبت واحد جاهز للنسخ.>

```text
<self-contained prompt: files, constraints, gates, architecture doc by name>
```
```

---

## Worked example — the opening of a real report

Showing the temperature and the level of concreteness expected.

```markdown
# إصلاح مشكلة الحسابات اللي تظهر حمراء بعد إعادة الربط

**الحالة:** مدموج ومرفوع للسيرفر
**المصدر:** PR #69 · ١٣ ملف · ٣٠ أغسطس

## باختصار

كانت حسابات فيسبوك وإنستقرام تظهر بعلامة حمراء وتطلب منك إعادة الربط،
حتى بعد ما تربطها من جديد. الحين صار النظام يعرف الفرق بين مشكلة مؤقتة
بالشبكة وبين صلاحية انتهت فعلاً، فما يعلّم الحساب بالأحمر إلا إذا كان
فعلاً محتاج إعادة ربط.

## وش تغيّر بالضبط

المشكلة كانت إن النظام يعامل أي فشل بنفس الطريقة. لو الشبكة انقطعت
لحظة، يحسبها محاولة فاشلة — وبعد ثلاث محاولات كذا يقفل الحساب ويطلب
إعادة ربط، مع إن الحساب سليم تماماً.

الحين صار يفرّق:

• **انقطاع مؤقت** (الشبكة، أو ضغط على منصة فيسبوك) → يعيد المحاولة
  لاحقاً، وما يحسبها ضدك إطلاقاً
• **الصلاحية انتهت فعلاً** (فيسبوك رجّع إن التفويض ملغي) → يعلّم
  الحساب بالأحمر من أول مرة، بدون ما ينتظر ثلاث محاولات

يعني صار أسرع بالحالة الحقيقية، وأصبر بالحالة الوهمية.
```

Notice: the *why* comes before the *what*. The bullets carry two states and two outcomes. The
closing line gives the reader a single sentence they can repeat to someone else.

---

## Common failures

**A journey for an invisible change.** If the diff touched only background jobs, there is nothing to
click. Say so.

**Process narration.** `تم فتح طلب دمج، وبعدها تمت المراجعة، ثم الدمج` — the reader does not care
about the sequence of git operations. Lead with the outcome.

**Unearned confidence.** "تم إصلاح المشكلة" when tests passed but nothing was deployed and no real
account was retried. Write what is actually established.

**A wall of Arabic.** Four-line paragraphs maximum. The reader stops at the fifth.

**Fabricated button labels.** Take control names from the changed code, not from memory. A journey
naming a button that doesn't exist destroys the report's credibility in one step.
