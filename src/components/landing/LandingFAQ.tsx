import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Reveal, GradientHeading } from "@/components/fx";

const faqItems = [
  { question: "What platforms does Postora support?", answer: "Postora supports all major social media platforms including Instagram, Facebook, TikTok, Twitter/X, LinkedIn, YouTube, Pinterest, Threads, Bluesky, and Reddit. We're constantly adding support for new platforms." },
  { question: "How does the free plan work?", answer: "Our free plan includes 2 social profiles, 10 posts per month, and basic analytics. It's perfect for individuals just getting started with social media management. No credit card required." },
  { question: "Can I schedule posts in advance?", answer: "Yes! All plans include post scheduling. You can schedule posts days, weeks, or even months in advance. Pro and Business plans also include AI-powered best time suggestions for optimal engagement." },
  { question: "Is there a limit on how many posts I can schedule?", answer: "The free plan allows 10 posts per month. Pro and Business plans offer unlimited posts, so you can schedule as much content as you need without worrying about limits." },
  { question: "How does the AI caption generation work?", answer: "Available on Pro and Business plans, our AI analyzes your content and generates engaging captions tailored to each platform's best practices. You can customize the tone, add hashtags, and edit before posting." },
  { question: "Can I cancel my subscription anytime?", answer: "Absolutely. There are no long-term contracts or cancellation fees. You can upgrade, downgrade, or cancel your subscription at any time from your account settings." },
  { question: "Do you offer team collaboration features?", answer: "Yes, our Business plan includes full team collaboration with role-based permissions, approval workflows, and shared content calendars. Perfect for agencies and marketing teams." },
  { question: "Is my data secure with Postora?", answer: "Security is our top priority. We use enterprise-grade encryption, OAuth 2.0 for social connections, and never store your social media passwords. All data is hosted on secure, SOC 2 compliant servers." },
  { question: "What is the n8n integration?", answer: "Our n8n integration provides a powerful HTTP API that allows you to automate your posting workflow. Connect Postora with hundreds of other apps to create custom automation workflows." },
  { question: "Do you offer a student or non-profit discount?", answer: "Yes! We offer special pricing for students, educators, and registered non-profit organizations. Contact our support team with proof of eligibility to receive your discount code." },
];

export default function LandingFAQ() {
  return (
    <section id="faq" className="relative z-10 container mx-auto px-6 pb-32 scroll-mt-20">
      <Reveal className="text-center mb-16">
        <GradientHeading preset="emerald-cyan-sky">Frequently Asked Questions</GradientHeading>
        <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
          Everything you need to know about Postora. Can't find what you're looking for? Contact our support team.
        </p>
      </Reveal>

      <div className="max-w-3xl mx-auto">
        <Accordion type="single" collapsible className="space-y-4">
          {faqItems.map((item, index) => (
            <Reveal key={index} delay={index * 60}>
              <AccordionItem
                value={`item-${index}`}
                className="group relative border border-border/60 rounded-2xl px-6 bg-card/80 backdrop-blur-md shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:border-cyan-400/40"
              >
                <AccordionTrigger className="text-start hover:no-underline py-5">
                  <span className="font-medium">{item.question}</span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-5">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            </Reveal>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
