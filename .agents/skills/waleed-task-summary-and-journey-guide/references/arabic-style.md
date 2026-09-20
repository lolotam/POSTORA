# Arabic Style Guide

The Arabic is the primary output, not a translation of the English. Draft it first. Text written in
English and then converted carries English sentence shapes and reads foreign — the reader notices
immediately, even if they can't name why.

## Register: MSA backbone, Gulf warmth

Modern Standard Arabic grammar, everyday Gulf phrasing, second person, addressed to one person you
respect. Not newspaper Arabic, not a formal report, not heavy dialect.

This is the calibration sample. Match its temperature:

```
## ما الذي تغيّر؟

كانت المشكلة إن الحسابات اللي تنتهي صلاحيتها كانت تظهر باللون الأحمر
حتى بعد ما تسجّل دخولك من جديد.

الحين صار النظام يفرّق بين حالتين:
• انقطاع مؤقت بالشبكة → يعيد المحاولة
• الصلاحية انتهت فعلاً → يطلب منك إعادة الربط

الـ Pull Request (طلب دمج التعديلات) رقم ٦٩
```

What that sample is doing, and why:

- **`اللي` instead of `التي`, `الحين` instead of `الآن`.** These are the connectives people actually
  speak. They cost nothing in correctness and buy a great deal in readability.
- **Direct second person** — `تسجّل دخولك`, `يطلب منك`. The reader is being spoken to, not briefed.
- **Short lines.** A non-technical reader gives up on a dense Arabic paragraph. Break early.
- **Bullets carry the mechanism.** Two states, an arrow, an outcome. Far clearer than a sentence
  trying to hold both branches.
- **Cause before effect** — the problem, then the fix. Never open with the solution.

### Stay in this band

| Too stiff | In band | Too loose |
|---|---|---|
| تعذّر إتمام عملية المصادقة | ما قدر يتحقق من الحساب | ما ضبطت معاه |
| يُرجى التحقق من صحة البيانات | تأكد إن البيانات صحيحة | شوف البيانات عدل |
| تم تنفيذ عملية النشر بنجاح | تم النشر بنجاح | خلصنا النشر |

The right-hand column is too casual for something a teammate or client might read. The left is
correct but cold — it makes a simple fact feel bureaucratic.

## Technical terms: English word, Arabic gloss on first use

The reader sees `Pull Request`, `deploy`, `token` in GitHub and in their dashboard all day.
Translating those into pure Arabic makes the text *harder*, not easier — they then have to map your
invented Arabic back onto the English they actually see.

So: keep the English term, gloss it once in parentheses the first time it appears in a report, then
use the English term alone.

```
الـ Pull Request (طلب دمج التعديلات) رقم ٦٩ تم دمجه.
بعد الدمج، باقي خطوة الـ deploy عشان التغييرات توصل للسيرفر.
```

### Glossary

| English | First-use gloss | Notes |
|---|---|---|
| Pull Request / PR | طلب دمج التعديلات | Keep the number: `الـ PR رقم ٦٩` |
| merge | دمج | `تم دمج التعديلات` reads naturally |
| commit | حفظ التعديلات | Usually skippable for this reader entirely |
| branch | نسخة فرعية من الكود | Rarely worth mentioning |
| deploy | رفع التحديث للسيرفر | The distinction they care about most |
| bug / defect | خلل | `مشكلة` is fine and warmer |
| fix | إصلاح | |
| token | رمز الدخول | For OAuth: `صلاحية الحساب` is often clearer |
| expired token | انتهت صلاحية الحساب | Prefer this to literal token language |
| API | واجهة برمجية | Usually leave as API alone |
| endpoint | نقطة الاتصال | |
| cache | ذاكرة مؤقتة | |
| database | قاعدة البيانات | Fully naturalised, no gloss needed |
| test / tests | اختبارات | |
| rollback | التراجع للنسخة السابقة | |
| refactor | إعادة ترتيب الكود بدون تغيير سلوكه | Say it changes nothing visible |
| edge function | خدمة على السيرفر | Avoid the literal translation |
| webhook | إشعار تلقائي من المنصة | |
| cron / scheduled job | مهمة مجدولة تشتغل تلقائياً | |
| rate limit | حد عدد الطلبات | |
| timeout | انقطاع بسبب طول الانتظار | |

When a term isn't here, apply the test: **does the reader see this word in their own interface?** If
yes, keep it English. If no, use Arabic.

## Numbers

Arabic-Indic numerals (`٦٩`) in flowing Arabic prose — they read as native.

Western numerals everywhere the number is a value to be copied, matched, or typed: PR numbers in a
command, version strings, file paths, SHA hashes, URLs, counts in a table, code blocks. Someone
comparing `٦٩` against GitHub's `69` has been given extra work for no reason.

When in doubt, Western. A number is only decorative in prose.

## Punctuation and direction

- Arabic comma `،` and semicolon `؛` in Arabic sentences. Arabic question mark `؟`.
- Latin punctuation inside Latin fragments — don't write `deploy،`.
- Wrap a bare English term or path in an Arabic sentence in backticks. It stops the RTL renderer
  reordering it into nonsense, and it signals "this is a literal thing" to the reader.
- Never mirror a URL, path, or command into RTL. Backticks handle this.
- Terminals render RTL unreliably — this is why the report is also written to a file. Assume the
  file is where it will actually be read.

## Structure that survives skimming

The reader skims first, then reads what matters to them.

- One idea per paragraph, two to four lines.
- Lead each section with its conclusion.
- Bullets for lists of states, steps, or outcomes; prose for cause and effect.
- Bold the two or three phrases that matter most in a section — not more, or nothing stands out.
- Never open with process (`تم فتح طلب دمج ثم مراجعته`). Open with the outcome the reader cares
  about.

## English section

Same discipline, no ceremony. Plain professional English, short sentences, same structure as the
Arabic so the two can be read side by side. It is a peer section, not an appendix — someone may
forward it to a developer or a client who doesn't read Arabic.

Do not translate the Arabic literally. Write the same content natively in English.
