import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Download, Calendar, CheckCircle2, ArrowRight } from "lucide-react";

const TEMPLATE_URL = "/content-calendar-template.csv";

export default function ContentCalendarTemplate() {
  useEffect(() => {
    const prevTitle = document.title;
    const prevDescription = document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");

    document.title =
      "Free Social Media Content Calendar Template (CSV / Google Sheets) | Postora";

    const setMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", name);
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", content);
    };

    setMeta(
      "description",
      "Download a free social media content calendar template. CSV file opens in Google Sheets or Excel. Plan, organize, and schedule your posts across every platform."
    );

    // Set canonical
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute(
      "href",
      "https://postora.cloud/templates/content-calendar-template"
    );

    return () => {
      document.title = prevTitle;
      if (prevDescription) setMeta("description", prevDescription);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <Link to="/" className="text-lg font-semibold">
            Postora
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/pricing" className="text-muted-foreground hover:text-foreground">
              Pricing
            </Link>
            <Link to="/auth">
              <Button size="sm">Start scheduling free</Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-12">
        <article>
          <div className="mb-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" aria-hidden="true" />
            <span>Free template · CSV (Google Sheets &amp; Excel)</span>
          </div>

          <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
            Free Social Media Content Calendar Template
          </h1>

          <p className="mb-8 text-lg text-muted-foreground">
            A simple, downloadable content calendar template to plan posts
            across Instagram, Facebook, TikTok, LinkedIn, X, Pinterest, and
            YouTube. Open it in Google Sheets or Excel and start mapping your
            month in minutes.
          </p>

          <Card className="mb-12 flex flex-col items-start gap-4 p-6 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium">Content Calendar Template (.csv)</p>
              <p className="text-sm text-muted-foreground">
                Works in Google Sheets, Excel, Numbers, and Notion.
              </p>
            </div>
            <a href={TEMPLATE_URL} download>
              <Button size="lg" className="gap-2">
                <Download className="h-4 w-4" aria-hidden="true" />
                Download template
              </Button>
            </a>
          </Card>

          <section className="mb-12">
            <h2 className="mb-4 text-2xl font-semibold">
              What&apos;s inside the template
            </h2>
            <ul className="space-y-3">
              {[
                "Date, day, and time slot for every scheduled post",
                "Platform column (Instagram, Facebook, TikTok, LinkedIn, X, Pinterest, YouTube)",
                "Post type (reel, image, short video, article, pin, story)",
                "Content pillar / topic to keep your brand voice consistent",
                "Caption, hashtags, media, and call-to-action fields",
                "Status column to track draft, scheduled, and published posts",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <CheckCircle2
                    className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="mb-4 text-2xl font-semibold">
              How to use a social media content calendar
            </h2>
            <ol className="space-y-4 text-muted-foreground">
              <li>
                <strong className="text-foreground">1. Define your content pillars.</strong>{" "}
                Pick three to five recurring themes that match your brand —
                e.g. tips, behind the scenes, product, customer stories,
                promotions. Every post should ladder up to one pillar.
              </li>
              <li>
                <strong className="text-foreground">2. Decide your cadence per platform.</strong>{" "}
                Frequency matters more than volume. Start with what you can
                sustain (e.g. 3 posts/week on Instagram, 1 long-form post/week
                on LinkedIn) and grow from there.
              </li>
              <li>
                <strong className="text-foreground">3. Batch your planning.</strong>{" "}
                Fill the calendar one month at a time. Group similar tasks —
                writing captions, choosing hashtags, sourcing media — to stay
                in flow instead of switching contexts post by post.
              </li>
              <li>
                <strong className="text-foreground">4. Track status.</strong>{" "}
                Use the status column (Draft &rarr; Scheduled &rarr; Published)
                so nothing slips. Review weekly and roll incomplete items
                forward.
              </li>
              <li>
                <strong className="text-foreground">5. Review what worked.</strong>{" "}
                At the end of each month, mark top performers and double down
                on the pillars and formats that drove the most engagement.
              </li>
            </ol>
          </section>

          <section className="mb-12">
            <h2 className="mb-4 text-2xl font-semibold">
              Why a content calendar matters
            </h2>
            <p className="text-muted-foreground">
              Consistency is the single biggest predictor of social growth.
              A calendar removes the daily &ldquo;what should I post?&rdquo;
              decision so you can focus on quality and engagement instead.
              It also makes collaboration easier — designers, writers, and
              clients can all see what&apos;s shipping and when.
            </p>
          </section>

          <Card className="bg-muted/40 p-8">
            <h2 className="mb-2 text-2xl font-semibold">
              Stop copy-pasting between tabs
            </h2>
            <p className="mb-6 text-muted-foreground">
              Once your calendar is full, plug it into Postora to schedule
              and auto-publish posts to every platform from one place.
              Caption, hashtags, media, and timing — all in a single
              workflow.
            </p>
            <Link to="/auth">
              <Button size="lg" className="gap-2">
                Start scheduling for free
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          </Card>
        </article>
      </main>

      <footer className="mt-16 border-t">
        <div className="container mx-auto flex flex-col items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground md:flex-row">
          <span>© {new Date().getFullYear()} WALEED PROLIFE LLC</span>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
