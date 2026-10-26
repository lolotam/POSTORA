# تحليل Instagram والمنافسين في Postora: إيه الناقص مقارنةً بـ vidIQ

تاريخ التقرير: 26 أكتوبر 2026
النوع: تحليل وإرشاد فقط. مفيش أي تعديل في كود Postora.

**الكود اللي اتراجع:** فرع `origin/ccr-f0848f64-lbmmrr` (commit `1a6429a6`)، وهو أحدث فرع على GitHub وفيه أدوات MCP الجديدة. نسخة `main` المحلية في `E:\Dev\Projects\postora_new` متأخرة 126 commit عن `origin/main`، فما اتعتمدش عليها. أرقام السطور في التقرير من الفرع ده.

**مستندات Meta:** اتراجعت النهارده من developers.facebook.com. الروابط في آخر التقرير.

---

## الخلاصة في 6 نقط

1. **Postora مش فاضي من ناحية المنافسين.** فيه صفحة اسمها Brand Intelligence (والصفحة اللي اسمها "Instagram Analytics" هي نفسها). بتجيب بروفايل أي حساب Business أو Creator وآخر 50 بوست بتاعه عن طريق **Business Discovery** الرسمي. ولو فشل، بتلجأ لـ **Apify** (scraping) لو الأدمن مفعّله.
2. **بس فيه عيب بيخلي الطريق الرسمي يفشل غالباً.** الكود بيدور على حساب Instagram نوعه `facebook_page` بس. والربط اللي بيعمل النوع ده (`facebook-oauth`) **مش بيطلب** `instagram_manage_insights`، وMeta بتشترطها لـ Business Discovery. أما الربط اللي بيطلبها (`instagram-business-oauth`) فبيحفظ الحساب بنوع `facebook_business`، والكود بيتجاهله. والنتيجة إن الطلب غالباً بيروح على Apify أو بيطلع خطأ.
3. **تحليلات حسابك أنت (Insights) مش موجودة خالص لـ Instagram وFacebook**، مع إن Postora **بيطلب الصلاحيات بتاعتها فعلاً** (`instagram_manage_insights` و`instagram_business_manage_insights` و`read_insights`). الصلاحية موجودة، وكمان **Meta وافقت عليها Advanced Access**، بس عدد استخدامها في App Dashboard صفر لأن الكود اللي يقرا بيها مش موجود. أداة MCP `get_post_analytics` بتقول صراحة إنها بتدعم Threads وTikTok بس.
4. **أرقام المنافسين مش بتتخزن على مدار الوقت.** بتتحفظ نسخة واحدة JSON في الـ cache لمدة ساعة وفي سجل البحث. مفيش تاريخ يومي، فمش ممكن نحسب "الريل ده عمل كام ضعف المعتاد" إلا من آخر لقطة.
5. **اللي vidIQ بيعمله في `instagram_tiktok_outlier_search` و`ig_accounts_from_outliers` (بحث في كل Instagram بموضوع ومنطقة ولغة) مالوش API رسمي من Meta.** ده محتاج فهرس ضخم مبني بالـ scraping أو بيانات مشتراه من مزود. مش هيتعمل بالصلاحيات الرسمية مهما اتطلبت.
6. **Ad Library API مش هيفيد في الخليج.** API الإعلانات بيرجّع الإعلانات التجارية بس لو وصلت لدولة في الاتحاد الأوروبي، وغير كده بيرجّع إعلانات السياسة والقضايا الاجتماعية بس. إعلانات Vaseline أو CeraVe اللي شغالة في الكويت بس مش هتطلع منه.

---

## 1) أدوات vidIQ بتشتغل إزاي

vidIQ مش بيقول بيجيب بياناته منين بالظبط، فالكلام هنا استنتاج من اللي Meta بتسمح بيه رسمياً ومن شكل البيانات اللي رجعت في `research/vidiq-trends-competitors-2026-10.ar.md`.

### `ig_profile` و`ig_profile_reels`: بروفايل عام وآخر 12 ريل لأي handle

- **رسمياً فيه طريق قريب:** Business Discovery. بتبعت الطلب باسم حسابك أنت (لازم يكون Business أو Creator ومربوط بصفحة فيسبوك) وتكتب اسم الحساب التاني. بيرجّع عدد المتابعين وعدد البوستات وقائمة البوستات بـ `like_count` و`comments_count` و`view_count` (للريلز) و`media_product_type` و`caption` و`permalink`.
- **حدوده:** شغال على حسابات Business وCreator بس. مش بيرجّع الحسابات الشخصية ولا الخاصة. الحسابات المقيدة بالسن بيقول عنها: "Data about age-gated Instagram Business IG Users will not be returned". و`like_count` بيختفي لو صاحب الحساب مخبي اللايكات. و`view_count` على الريلز بيجمع المشاهدات المدفوعة والعادية مع بعض.
- **إيه اللي vidIQ بيجيبه زيادة:** لو بيجيب حسابات شخصية أو بيانات مش موجودة في Business Discovery، يبقى أكيد عنده مصدر غير رسمي: scraping أو مزود بيانات.

### `instagram_tiktok_outlier_search`: ريلز عملت أضعاف معدل صاحبها، بالموضوع والمنطقة واللغة

- **رسمياً مستحيل.** Meta مفيهاش endpoint يدور في كل الريلز بكلمة أو بلد أو لغة. أقرب حاجة Hashtag Search (تحت)، وده بيرجّع بوستات هاشتاج واحد بدون مشاهدات وبدون اسم صاحب البوست، و30 هاشتاج بس كل 7 أيام.
- **إزاي بيتعمل فعلاً:** فهرس ضخم بيتحدث باستمرار. ملايين الحسابات العامة بيتقرا منها آخر الريلز وأرقامها بشكل دوري، بـ scraping أو من مزود بيانات. بعدين لكل حساب بيتحسب median المشاهدات، والريل اللي يعدي المعدل بكذا ضعف يتعلّم عليه outlier. وبيتصنف بالموضوع (من الكابشن والصوت والصورة، غالباً بـ AI)، وبالمنطقة واللغة (من لغة الكابشن وبلد الحساب).

### `ig_accounts_from_outliers`: اكتشاف حسابات منافسة

- **رسمياً مستحيل.** Business Discovery لازم تديله اسم الحساب بالظبط. مفيش API رسمي يقولك "مين الحسابات اللي بتتكلم عن ترطيب الجلد في الخليج".
- **إزاي بيتعمل:** نفس الفهرس اللي فات. بياخد الريلز المتفوقة، ويجمع أصحابها، ويرتبهم.

### `instagram_owner_insights`: الأرقام الخاصة لحسابك

- **ده الوحيد اللي رسمي 100%.** بتربط حسابك بـ OAuth، وبيقرا Insights بـ `instagram_business_manage_insights` (Instagram Login) أو `instagram_manage_insights` (Facebook Login).
- **بيدّي حاجات مش موجودة للمنافسين:** reach و`saved` و`shares` و`views` و`total_interactions` و`ig_reels_avg_watch_time` و`profile_visits` و`follows`، وكمان بيانات الجمهور.
- **ده بالظبط اللي Postora يقدر يعمله النهارده بالصلاحيات اللي معاه، ولسه مش عامله.**

### الفرق باختصار

| الأداة | ينفع بـ Meta الرسمي؟ | محتاج فهرس / scraping؟ |
|---|---|---|
| `instagram_owner_insights` | أيوه، كامل | لأ |
| `ig_profile` + `ig_profile_reels` | أيوه لحسابات Business وCreator (Business Discovery) | بس لو عايز حسابات شخصية أو بيانات أكتر |
| `instagram_tiktok_outlier_search` | لأ | أيوه |
| `ig_accounts_from_outliers` | لأ | أيوه |

---

## 2) صلاحيات Meta: كل واحدة بتسمح بإيه، ومش بتسمح بإيه

| الصلاحية / الخاصية | بتسمح بإيه | مش بتسمح بإيه (خصوصاً المنافسين) |
|---|---|---|
| `instagram_basic` | قراية بروفايل حسابك المربوط وبوستاته (username وid وmedia). وهي شرط لـ Hashtag Search. | مش بتدّي Insights. ولوحدها مش بتفتح Business Discovery. |
| `instagram_manage_insights` | Insights لحساب Instagram المربوط بصفحة فيسبوك. ونص Meta بيقول كمان إنها بتسمح باكتشاف وقراية بروفايل وبوستات حسابات Business تانية، يعني **دي اللي بتفتح Business Discovery**. | مش بتدّي Insights المنافسين (reach وsaves وshares وجمهورهم). بتدّي بس الحقول العامة (public). |
| `pages_read_engagement` | قراية محتوى الصفحة ومتابعينها والـ metadata والـ insights بتاعتها. وهي شرط مع `instagram_manage_insights` في Business Discovery وInsights عن طريق Facebook Login. | مش بتقرا صفحات غيرك. |
| `read_insights` | Insights للصفحات والتطبيقات والدومينات اللي الشخص **يملكها**. | صفحات غيرك مستحيل. |
| **Business Discovery** | بروفايل حساب Business أو Creator تاني وبوستاته بحقول عامة: `followers_count` و`media_count` و`like_count` و`comments_count` و`view_count` (ريلز) و`media_product_type` و`caption` و`permalink`. ومتاح **مع Facebook Login بس**، بتوكن فيه `instagram_basic` و`instagram_manage_insights` و`pages_read_engagement`. | مفيش حسابات شخصية أو خاصة أو مقيدة بالسن. مفيش `saved_count` ("Only accessible by the media owner"). مفيش reach ولا shares ولا جمهور. ولازم تعرف اسم الحساب مسبقاً. |
| **Hashtag Search** (`ig_hashtag_search` + `top_media` / `recent_media`) | بوستات عامة على هاشتاج: `top_media` (الأشهر) و`recent_media` (آخر 24 ساعة بس)، بحد أقصى 50 في الصفحة. الحقول: `like_count` و`comments_count` و`caption` و`permalink` و`timestamp` و`media_type`. محتاج الخاصية **Instagram Public Content Access** و`instagram_basic` وFacebook Login. | **"You can query a maximum of 30 unique hashtags within a 7 day period"** لكل حساب Instagram، وحتى طلب `top_media` أو `recent_media` بيتحسب من الـ 30. مش بيرجّع `username` لصاحب البوست. مفيش مشاهدات. مفيش إعلانات ولا بوستات مدفوعة. والهاشتاجات الحساسة بترجّع خطأ. |
| `instagram_business_*` (Instagram Login: `instagram_business_basic` و`_content_publish` و`_manage_comments` و`_manage_messages` و`_manage_insights`) | ربط Instagram مباشر من غير صفحة فيسبوك. `instagram_business_manage_insights` بتدّي Insights حسابك. | **مفيش Business Discovery ولا Hashtag Search** في الطريق ده؛ المستندات بتقول "Available for the Instagram API with Facebook Login" بس. ومفيش webhooks للـ Insights. وفيه حقول زي `media_product_type` و`total_views` بتشتغل مع Facebook Login بس. |
| **Meta Content Library + API** | كل المحتوى العام في Facebook وInstagram تقريباً، وفيه بحث. | **للباحثين بس.** لازم تكون تابع لمؤسسة أكاديمية أو بحثية غير ربحية، والطلبات بتتراجع عن طريق جهة مستقلة (CASD حالياً، وقبلها ICPSR). والشغل كله جوه بيئة مقفولة (Secure Research Environment)، والتصدير محدود. **مش متاح لمنتج تجاري زي Postora.** |
| **Ad Library API** (`ads_archive`) | بحث في إعلانات Meta بالكلمة أو بالصفحة (لحد 10 صفحات). | النص الرسمي: **"Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics."** يعني الإعلانات التجارية بتاعة الخليج مش هترجع إلا لو وصلت لدولة أوروبية. ومحتاج تأكيد هوية على حساب المطور (حسب أدلة الاستخدام؛ صفحة Meta نفسها رفضت تفتح أثناء المراجعة). |

**قواعد عامة من مستندات Insights:**
- Insights متاحة لحسابات Business وCreator بس.
- Meta بتحتاج **Advanced Access** (يعني App Review) عشان التطبيق يخدم حسابات مش ملك أصحابه. و**Standard Access** بيكفي بس للحسابات اللي تملكها ومضافة كأدوار في التطبيق.
- بعض المقاييس مش بتشتغل لو الحساب أقل من 100 متابع، ولما البيانات مش موجودة الرد بيرجع فاضي مش `0`.
- أرقام البوست ممكن تتأخر لحد 48 ساعة، وبتفضل محفوظة لحد سنتين. أرقام الحساب بتفضل 90 يوم.
- أرقام الستوري بتعيش 24 ساعة بس.
- `impressions` اتشالت من البوستات اللي اتنشرت بعد 2 يوليو 2024. البديل `views`.

---

## 3) Postora عنده إيه النهارده

### الصلاحيات اللي بيطلبها

| طريقة الربط | الملف | الصلاحيات | نوع الحساب المحفوظ |
|---|---|---|---|
| Facebook (صفحات + Instagram عن طريق الصفحة) | `supabase/functions/facebook-oauth/index.ts:20` | `pages_show_list` و`pages_read_engagement` و`pages_manage_posts` و`pages_manage_engagement` و`pages_read_user_content` و`business_management` و`pages_manage_metadata` و`pages_messaging` و`read_insights` و`instagram_basic` و`instagram_content_publish` و`instagram_manage_comments` و`instagram_manage_messages` و`whatsapp_business_*` و`ads_read` و`ads_management` و`leads_retrieval` و`pages_manage_ads`. **مفيش `instagram_manage_insights`.** | `facebook_page` (السطور 797 و975 و1059) |
| Instagram عن طريق Facebook Business | `supabase/functions/instagram-business-oauth/index.ts:37` | `pages_show_list` و`pages_read_engagement` و`pages_manage_metadata` و`pages_messaging` و`business_management` و`instagram_basic` و`instagram_content_publish` و`instagram_manage_comments` و**`instagram_manage_insights`** و`instagram_manage_messages` | `facebook_business` (سطر 213) |
| Instagram Login (مباشر) | `supabase/functions/instagram-oauth/index.ts:34` | `instagram_business_basic` و`instagram_business_content_publish` و`instagram_business_manage_messages` و`instagram_business_manage_comments` و**`instagram_business_manage_insights`** | `business_login` |
| نسخة الواجهة من صلاحيات Facebook | `src/hooks/oauth/useFacebookOAuth.ts:59` | نفس قايمة `facebook-oauth` | |
| Threads | `src/components/brand-intelligence/ThreadsPermissionStatus.tsx:16` | `threads_profile_discovery` و`threads_keyword_search` و`threads_manage_insights` | |

### حالة App Review في Meta (من App Dashboard، 26 أكتوبر 2026)

وليد بعت حالة الصلاحيات من صفحة App Review لتطبيق POSTORA (App ID `3353035928180840`). فيها 35 بند واخدين **Advanced access granted**. المهم منهم للتحليلات:

| الصلاحية / الخاصية | الحالة | عدد الـ API calls |
|---|---|---|
| `instagram_manage_insights` | Advanced access granted | **Ready to use (0)** |
| `instagram_business_manage_insights` | Advanced access granted | **Ready to use (0)** |
| `read_insights` | Advanced access granted | Active (26) |
| `pages_read_engagement` | Advanced access granted | Active (1.133K) |
| `instagram_basic` / `instagram_business_basic` | Advanced access granted | Active (58) / Active (3.626K) |
| **Page Public Content Access** | Advanced access granted | Active (352) |
| `ads_read` / `ads_management` | Advanced access granted | Active (822) / Active (828) |
| **Instagram Public Content Access** | **مش موجودة في القايمة** | — |

اللي بنفهمه من الجدول ده:

1. **صلاحيات الـ Insights الاتنين متوافق عليهم من Meta**، بس عدد استخداماتهم **صفر**. وده بيأكد اللي لقيناه في الكود: مفيش ولا سطر بيقرا Insights لـ Instagram.
2. **`instagram_manage_insights` = صفر** معناها كمان إن Business Discovery عمره ما اشتغل بالطريق الرسمي من Postora. وده متسق مع العيب في `brand-scrape/index.ts:549` (تحت في الجزء 4-ب). وعلى الأغلب كل نتايج Brand Intelligence لـ Instagram كانت جاية من Apify.
3. **Page Public Content Access** موجودة وشغالة. دي بتسمح بقراية البيانات العامة لصفحات Facebook اللي مش بتديرها، يعني تحليل صفحات فيسبوك المنافسة رسمي ومسموح.
4. **Instagram Public Content Access مش موجودة**، فـ Hashtag Search لسه محتاج App Review.
5. القايمة كمان بتقول إن التطبيق في وضع **Development**. لو ده صحيح، الناس اللي مالهمش دور في التطبيق مش هيقدروا يربطوا حساباتهم. بس عدد الاستدعاءات الكبير بيقول إن الربط شغال فعلاً، فالأحسن تتأكد من الوضع من App Dashboard قبل ما نعتمد على المعلومة دي.

ملحوظة: قايمة المراجعة جوه الكود (`src/pages/admin/oauth-verification/checklist-data/instagram.ts`) مفيهاش `instagram_manage_insights`، فهي قديمة بالنسبة للحالة الحقيقية في Meta.

### الـ Graph API endpoints اللي بتقرا بيانات

| الـ endpoint | الملف | بيعمل إيه |
|---|---|---|
| `GET /{ig-user-id}?fields=business_discovery...&username=` | `supabase/functions/brand-scrape/index.ts:14` | بروفايل المنافس وآخر 50 بوست (likes وcomments و`video_view_count`) |
| `GET graph.instagram.com/{ig-user-id}/media` + بروفايل | `supabase/functions/brand-scrape/index.ts:62` و`:72` | بوستاتك أنت (لو ربطت بـ Instagram Login)، أرقام عامة بس من غير Insights |
| Apify actor `apify~instagram-scraper` | `supabase/functions/brand-scrape/index.ts:108` | scraping لأي حساب لما الطريق الرسمي يفشل، لو `apify_enabled` شغال من `src/components/admin/BrandIntelligenceSettings.tsx` |
| صفحات Facebook وReels بتاعتها | `supabase/functions/brand-scrape/index.ts:162` | تحليل صفحة فيسبوك منافسة |
| `GET /{ad-account-id}/insights` | `supabase/functions/ad-analytics/index.ts:131` | أرقام **إعلاناتك أنت** (spend وreach وclicks) |
| `graph.threads.net/v1.0/keyword_search` | `supabase/functions/threads-keyword-search/index.ts:196` | بحث في Threads بالكلمة، وده أقرب حاجة لـ "trends" عند Meta |
| `graph.threads.net/{post}/insights` | `supabase/functions/threads-insights/index.ts:254` | Insights لبوستات Threads بتاعتك |

### بيقرا Insights ولا لأ؟

- **Instagram: لأ.** مفيش ولا نداء لـ `/{ig-media-id}/insights` ولا `/{ig-user-id}/insights` في الكود كله.
- **صفحات Facebook: لأ.** بيطلب `read_insights` ومفيش كود بيستعملها.
- **Threads وTikTok والإعلانات: أيوه.**
- أداة MCP `get_post_analytics` (`supabase/functions/mcp/index.ts:459`) بتقول بالنص إنها Threads وTikTok بس، وغيرهم بيرجّع "not supported yet".

### البيانات بتتخزن فين

| الجدول | الملف | فيه إيه |
|---|---|---|
| `posts` | `src/integrations/supabase/types.ts:4191` | البوست والكابشن والمنصات والحالة. **مفيش أعمدة أرقام.** |
| `platform_posts` | `src/integrations/supabase/types.ts:4097` | `platform_post_id` و`platform_post_url` و`response_data` لكل منصة. ده المفتاح اللي هنجيب بيه Insights بعدين. |
| `brand_scrape_cache` | `supabase/migrations/20260324013145_58e93514-87ec-4785-befb-d2d740c10819.sql:4` | رد المنافس كامل JSON، وبيعيش ساعة (`ttlMinutes = 60` افتراضياً) |
| `brand_scrape_sessions` | نفس الملف، سطر 17 | سجل البحث: `profile_data` و`posts_data` JSON |
| `bi_post_content` | `src/integrations/supabase/types.ts:1228` | المحتوى اللي اتولد من بوست منافس |
| `tiktok_api_analytics_cache` | migration `20260418203613_...` | أرقام TikTok |

**مفيش جدول لأرقام Instagram على مدار الوقت، لا لحسابك ولا للمنافسين.**

---

## 4) تحليل الفجوة: إيه الناقص لكل ميزة

التقدير بالأيام لمطور واحد شغال على الكود ده. **تحليلات حسابك وتحليل المنافسين مش محتاجين أي مراجعة جديدة من Meta**، لأن صلاحياتهم واخدة Advanced Access خلاص. المراجعة محتاجها بس Hashtag Search.

### أ) تحليل حسابك أنت (Owner Insights)

| البند | التفاصيل |
|---|---|
| **الناقص** | (1) edge function أو cron بيقرا `/{ig-media-id}/insights` لكل بوست في `platform_posts` بالمقاييس `views` و`reach` و`saved` و`shares` و`likes` و`comments` و`total_interactions` و`ig_reels_avg_watch_time`، وكمان بيانات الحساب. (2) جدول جديد زي `ig_media_insights_snapshots` (account و`platform_post_id` والتاريخ والمقاييس)، عشان نعرف الأرقام بتكبر إزاي. (3) سحب البوستات اللي اتنشرت **من برّه Postora** عن طريق `/{ig-user-id}/media`، عشان التحليل يبقى كامل. (4) تفعيل Instagram وFacebook في `get_post_analytics` في MCP. (5) صفحة تحليلات حقيقية بدل اللي اسمها "Instagram Analytics" وهي فعلياً بحث منافسين. |
| **الصلاحيات** | موجودة في الكود: `instagram_business_manage_insights` (Instagram Login) و`instagram_manage_insights` (Facebook Business). ولازم كمان تضيفها لـ `facebook-oauth` لو هتفضل تستخدم الطريق ده. |
| **App Review** | **مش محتاج.** `instagram_business_manage_insights` و`instagram_manage_insights` الاتنين واخدين Advanced access granted. الشغل كله كود. |
| **حدود البيانات** | تأخير لحد 48 ساعة. مفيش Insights لصور جوه الكاروسيل. بعض المقاييس محتاجة 100 متابع. الستوري بتعيش 24 ساعة بس، فلازم تتسحب في نفس اليوم. وكل المقاييس محسوبة من rate limit الـ Business Use Case. |
| **المجهود** | 5 إلى 8 أيام (backend وجدول وcron وMCP وواجهة بسيطة). |
| **القيمة** | **الأعلى.** دي الأرقام اللي اتقالت عنها في ملف vidIQ إنها ناقصة (الكاروسيل والصور ونسبة التفاعل)، ومش هتلاقيها عند أي مزود خارجي غير لو ربطت حسابك عنده. |

### ب) تحليل المنافسين بـ Business Discovery

| البند | التفاصيل |
|---|---|
| **الموجود** | `brand-scrape` شغال، ومعاه الواجهة والـ cache. |
| **الناقص (إصلاحات)** | (1) `brand-scrape/index.ts:549` يقبل كمان الحسابات من نوع `facebook_business`، أو يضيف `instagram_manage_insights` لصلاحيات `facebook-oauth`. **من غير ده، الطريق الرسمي غالباً بيفشل.** والاستثناء الوحيد إن نفس الشخص يكون إدّى الصلاحية قبل كده لنفس تطبيق Meta من الطريق التاني. ويتأكد ده من `account_metadata.granted_scopes`. (2) تبديل `video_view_count` بـ **`view_count`**، لأن الحقل القديم مش موجود في مستند IG Media الحالي، فمشاهدات الريلز على الأغلب بترجع صفر. وكمان إضافة `media_product_type` عشان نفرق الريل من البوست العادي (الكود الحالي بيعتبر أي فيديو ريل). (3) **قايمة منافسين ثابتة** (watchlist) وcron يومي يحفظ snapshot لكل حساب وبوست في جدول، بدل cache ساعة. (4) pagination عشان نعدي الـ 50 بوست. |
| **الصلاحيات** | `instagram_basic` و`instagram_manage_insights` و`pages_read_engagement` (عن طريق Facebook Login)، وكلها مطلوبة أصلاً في `instagram-business-oauth`. |
| **App Review** | **مش محتاج.** `instagram_manage_insights` و`instagram_basic` و`pages_read_engagement` كلهم واخدين Advanced access granted. بس الحسابات المربوطة قبل كده من `facebook-oauth` لازم تتربط تاني بعد إضافة الصلاحية، عشان التوكن يشملها. |
| **حدود البيانات** | حسابات Business وCreator بس، ولازم تعرف الـ username. المتاح: followers وmedia_count وlikes (لو مش مخفية) وcomments وviews للريلز (مدفوع وعادي مع بعض). مفيش saves ولا shares ولا reach ولا جمهور. محسوب من rate limit تطبيقك. |
| **المجهود** | الإصلاحات (1) و(2): يوم واحد. الـ watchlist والـ snapshots اليومية: 3 إلى 4 أيام. |
| **ملحوظة للتجربة** | Vaseline Arabia وCeraVe Arabia وHepta على الأغلب حسابات Business، فهينفعوا. |

### ج) ترندات الهاشتاجات

| البند | التفاصيل |
|---|---|
| **الناقص** | كل حاجة: `ig_hashtag_search` و`top_media` و`recent_media`، وجدول يسجل الـ 30 هاشتاج المستخدمين في الأسبوع لكل حساب، وsnapshots. |
| **App Review** | **محتاج.** الخاصية **Instagram Public Content Access** مش موجودة في صلاحيات التطبيق (تختلف عن Page Public Content Access اللي موجودة). وهي من أصعب المراجعات عند Meta، وبتشتغل مع Facebook Login بس. أما `instagram_basic` فموجودة. |
| **حدود البيانات** | **30 هاشتاج مختلف كل 7 أيام لكل حساب Instagram مربوط.** `recent_media` = آخر 24 ساعة بس. مفيش مشاهدات. مفيش اسم صاحب البوست، فمش هتعرف مين المنافس. الإعلانات مش موجودة. |
| **المجهود** | 4 إلى 6 أيام، والمراجعة ممكن تتأخر أو تترفض. |
| **رأيي** | **قيمة قليلة مقابل المجهود.** الهاشتاجات العربية في الخليج ضعيفة كمؤشر للترند، و30 هاشتاج في الأسبوع قليلين. البديل الأرخص: `threads-keyword-search` موجود أصلاً، وvidIQ متاح لك. |

### د) Outlier score (أداء البوست مقارنةً بـ median الحساب)

| البند | التفاصيل |
|---|---|
| **الناقص** | دالة بسيطة: لكل حساب، median الـ `view_count` (للريلز) أو `like_count + comments_count` (للصور) لآخر 12 إلى 30 بوست، والـ score = أرقام البوست ÷ الـ median. وأي بوست score بتاعه ≥ 3 يتعلّم عليه outlier. ولحسابك أنت ممكن نستعمل `views` و`saved` و`shares` من Insights، وده أدق بكتير. |
| **المصدر** | (ب) للمنافسين و(أ) لحسابك. لازم يكون فيه snapshots محفوظة الأول. |
| **App Review** | مفيش جديد. |
| **حدود البيانات** | بيشتغل على الحسابات اللي **أنت** حاطتها في القايمة بس. مش هيكتشف حسابات أو ريلز جديدة في السوق، وده الفرق الأساسي عن vidIQ. ولازم البوست يعدّي 48 إلى 72 ساعة قبل ما نحكم عليه. |
| **المجهود** | 1 إلى 2 يوم بعد (أ) و(ب). |

### هـ) Meta Ad Library

| البند | التفاصيل |
|---|---|
| **الناقص** | edge function لـ `ads_archive` بـ `search_page_ids` و`ad_reached_countries`، وواجهة. |
| **App Review / متطلبات** | تأكيد هوية على حساب Meta للمطور وقبول شروط Ad Library API (حسب أدلة الاستخدام؛ ما اتأكدتش من صفحة Meta نفسها لأنها رفضت تفتح أثناء المراجعة). |
| **حدود البيانات** | **الإعلانات التجارية بترجع بس لو وصلت للاتحاد الأوروبي.** في الكويت والخليج هيرجع إعلانات السياسة والقضايا الاجتماعية بس. أرقام الصرف والوصول بتتعرض بس للإعلانات السياسية أو إعلانات أوروبا. |
| **المجهود** | 2 إلى 3 أيام. |
| **رأيي** | **مش مجدي للخليج.** لو عايز تشوف إعلانات منافس، افتح موقع Ad Library يدوي (بيعرض كل الإعلانات الشغالة في أي بلد) أو استعمل مزود خارجي. |

---

## 5) اللي مش هيتعمل بـ API رسمي من Meta خالص

- بحث في **كل** ريلز Instagram بموضوع أو بلد أو لغة (outlier search العام).
- **اكتشاف** حسابات منافسة أنت مش عارف اسمها.
- أرقام **الحسابات الشخصية أو الخاصة**، أو الحسابات المقيدة بالسن.
- reach وsaves وshares والجمهور ووقت المشاهدة **لحسابات غيرك**.
- ستوري الحسابات التانية.
- إعلانات الخليج التجارية عن طريق API.
- البيانات الكاملة للباحثين (Content Library) لمنتج تجاري.

### البدائل والمخاطر القانونية

| البديل | بيدّي إيه | المخاطر |
|---|---|---|
| **vidIQ (الـ connector اللي عندك)** | بالظبط اللي ناقص: outliers واكتشاف حسابات وريلز أي حساب | الأقل خطورة عليك، لأن vidIQ هو اللي شايل مسؤولية جمع البيانات. وده بيتعمل جوه Claude، مش جوه Postora. |
| **Apify (موجود في Postora أصلاً)** | scraping لأي حساب عام | شروط Meta بتمنع جمع البيانات بوسائل آلية من غير إذن. فيه حكم أمريكي سنة 2024 (Meta ضد Bright Data) في صالح scraping البيانات العامة **من غير تسجيل دخول**، بس ده مش معناه إن الموضوع آمن في كل الدول، وMeta ممكن تحظر الحسابات أو الـ IPs. **الخطر الأكبر على Postora:** لو بيانات الـ scraping اتخلطت ببيانات تطبيق Meta الرسمي، أو اتعرضت كإنها رسمية، ممكن ده يأثر على مراجعة التطبيق أو يوقف صلاحياته. |
| **مزودين بيانات تجاريين** (زي Bright Data وHypeAuditor وModash وPhyllo) | فهارس جاهزة بالـ API واكتشاف حسابات | اشتراك شهري غالي. والخطر القانوني بيبقى على المزود بشكل أساسي، بس لازم تقرا العقد: مين المسؤول، والبيانات الشخصية بتتعامل إزاي. |
| **فهرس خاص بيك تبنيه بنفسك** | تحكم كامل | الأغلى والأخطر: بنية scraping وتكلفة proxies وصيانة مستمرة، وكل المسؤولية القانونية عليك. **مش منصوح بيه.** |

**قواعد لو هتستعمل أي مصدر غير رسمي:** خليه حسابات Business عامة بس. ما تخزّنش بيانات شخصية لأفراد (أسماء المعلّقين أو صورهم). اكتب جنب كل رقم مصدره (`official` أو `apify` أو `vendor`)، والكود الحالي بيعمل ده جزئياً في `strategyUsed`. وما تعرضش بيانات الـ scraping في الأجزاء اللي بتتراجع من Meta (فيديوهات App Review).

---

## 6) الترتيب المقترح

1. **إصلاحات Business Discovery** (يوم واحد): نوع الحساب و`view_count` و`media_product_type`. أسرع مكسب، وبيخلّي الطريق الرسمي يشتغل فعلاً بدل Apify.
2. **Owner Insights لحسابك** (5 إلى 8 أيام، ومن غير مراجعة Meta): أعلى قيمة، والصلاحيات متوافق عليها خلاص.
3. **قايمة منافسين + snapshots يومية + outlier score** (4 إلى 6 أيام).
4. **الترندات واكتشاف الحسابات:** استمر بـ vidIQ جوه Claude. ما تبنيهاش في Postora.
5. **Hashtag Search وAd Library API:** أجّلهم، القيمة قليلة في الخليج.

**ملحوظة جانبية لاحظتها ومش جزء من الطلب:** فيه 56 نداء في `supabase/functions` لسه على `graph.facebook.com/v18.0`، والإصدار ده قديم وغالباً طلع من مدة الدعم بتاعة Meta (حوالي سنتين من الإصدار)، وده معناه إن Meta بتحوّله لوحدها لأقدم إصدار مدعوم. يستاهل مراجعة.

أي تعديل من دول يروح لجلسة Postora-Orchestrator-Manager'Jahra' على فرعها الحالي، مش على main.

---

## المصادر (Meta، اتراجعت 26 أكتوبر 2026)

- Business Discovery: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- IG Media (الحقول العامة و`view_count`): https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- Hashtag Search: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
- Hashtag top_media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/top-media
- Hashtag recent_media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media
- Insights: https://developers.facebook.com/docs/instagram-platform/insights
- Media Insights: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- Permissions reference: https://developers.facebook.com/docs/permissions
- Ad Library API (`ads_archive`): https://developers.facebook.com/docs/graph-api/reference/ads_archive/
- Content Library: https://developers.facebook.com/docs/content-library-and-api و https://developers.facebook.com/docs/content-library-and-api/get-access
