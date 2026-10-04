import { Star, Quote } from "lucide-react";
import { Reveal, GradientHeading } from "@/components/fx";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from "@/components/ui/carousel";

const testimonials = [
  { name: "Sarah Chen", role: "Social Media Manager", company: "TechFlow Inc.", text: "Postora has completely transformed how we manage our social presence. What used to take hours now takes minutes.", rating: 5 },
  { name: "Marcus Johnson", role: "Content Creator", company: "Digital Nomad Co.", text: "The multi-platform scheduling is a game-changer. I can focus on creating content instead of posting it manually.", rating: 5 },
  { name: "Elena Rodriguez", role: "Marketing Director", company: "StartupHub", text: "We've seen a 40% increase in engagement since switching to Postora. The analytics insights are invaluable.", rating: 5 },
  { name: "David Park", role: "Founder", company: "CreativeStudio", text: "Finally, a tool that understands the needs of content creators. The UI is intuitive and the features are exactly what we needed.", rating: 5 },
  { name: "Amanda Foster", role: "Brand Strategist", company: "Elevate Agency", text: "The n8n integration allows us to automate our entire content workflow. Incredible time savings for our team.", rating: 5 },
  { name: "James Wilson", role: "CEO", company: "SocialFirst Media", text: "Postora's reliability is unmatched. We've never missed a scheduled post, and the support team is exceptionally responsive.", rating: 5 },
  { name: "Lisa Thompson", role: "Influencer", company: "Lifestyle & Travel", text: "As a full-time creator, Postora helps me maintain consistency across all platforms without the burnout.", rating: 5 },
  { name: "Michael Brown", role: "Digital Marketing Lead", company: "E-Commerce Plus", text: "The ROI on Postora is incredible. We've reduced our social media management time by 60% while growing our audience.", rating: 5 },
  { name: "Rachel Kim", role: "Community Manager", company: "GamersUnited", text: "Managing multiple gaming communities across platforms was chaotic before Postora. Now it's seamless.", rating: 5 },
  { name: "Alex Turner", role: "Creative Director", company: "BrandCraft Agency", text: "Our clients love the results we deliver using Postora. It's become an essential part of our agency toolkit.", rating: 5 },
  { name: "Jennifer Lee", role: "Small Business Owner", company: "Artisan Bakery", text: "I'm not tech-savvy, but Postora made social media management accessible. My bakery's online presence has never been better.", rating: 5 },
  { name: "Robert Martinez", role: "Head of Growth", company: "SaaS Ventures", text: "The best times to post feature alone has improved our engagement rates by 35%. Data-driven decisions made easy.", rating: 5 },
  { name: "Sophia Anderson", role: "Freelance Consultant", company: "Marketing Maven", text: "I recommend Postora to all my clients. It's professional, reliable, and the pricing is fair for the value delivered.", rating: 5 },
  { name: "Daniel Hughes", role: "VP of Marketing", company: "RetailGiant", text: "Coordinating campaigns across 50+ social accounts was a nightmare. Postora made it manageable and even enjoyable.", rating: 5 },
  { name: "Emily Watson", role: "Podcast Host", company: "Tech Talk Daily", text: "Promoting episodes across all platforms is now a one-click operation. Postora understands content creators.", rating: 5 },
  { name: "Chris Taylor", role: "Agency Owner", company: "Digital Pulse", text: "We've tried every social media tool out there. Postora is the only one that truly delivers on its promises.", rating: 5 },
  { name: "Natalie Green", role: "E-commerce Manager", company: "Fashion Forward", text: "Product launches are so much smoother now. We can schedule teasers, announcements, and follow-ups effortlessly.", rating: 5 },
  { name: "Kevin O'Brien", role: "Startup Founder", company: "InnovateTech", text: "As a bootstrapped startup, Postora gives us enterprise-level social media management at a price we can afford.", rating: 5 },
  { name: "Michelle Davis", role: "Non-Profit Director", company: "GreenEarth Foundation", text: "Spreading our environmental message across platforms has never been easier. Postora amplifies our impact.", rating: 5 },
  { name: "Thomas Wright", role: "Restaurant Owner", company: "Urban Eats", text: "Our social engagement has tripled since using Postora. The visual calendar makes planning promotions intuitive.", rating: 5 },
];

function TestimonialCard({ testimonial }: { testimonial: typeof testimonials[0] }) {
  return (
    <div className="group relative flex-shrink-0 w-80">
      <div className="relative p-6 rounded-2xl border border-border/60 bg-card shadow-md transition-transform duration-500 group-hover:-translate-y-1">
      <Quote className="w-8 h-8 text-foreground mb-4" />
      <p className="text-sm text-muted-foreground mb-4 line-clamp-4">
        "{testimonial.text}"
      </p>
      <div className="flex items-center gap-1 mb-3">
        {Array.from({ length: testimonial.rating }).map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-yellow-500 text-yellow-500" />
        ))}
      </div>
      <div>
        <p className="font-semibold text-sm">{testimonial.name}</p>
        <p className="text-xs text-muted-foreground">{testimonial.role}</p>
        <p className="text-xs font-medium text-foreground">{testimonial.company}</p>
      </div>
      </div>
    </div>
  );
}

export default function LandingTestimonials() {
  return (
    <section id="testimonials" className="relative z-10 pb-32 overflow-hidden scroll-mt-20">
      <Reveal className="text-center mb-16 container mx-auto px-6">
        <GradientHeading preset="amber-rose-violet">Loved by Creators Worldwide</GradientHeading>
        <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
          Join thousands of satisfied users who trust Postora for their social media management.
        </p>
      </Reveal>

      {/* Desktop: Infinite scroll rows */}
      <div className="hidden md:block relative">
        <div className="absolute start-0 top-0 bottom-0 w-24 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
        <div className="absolute end-0 top-0 bottom-0 w-24 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

        <div className="overflow-hidden mb-6">
          <div className="flex gap-6 animate-scroll-left hover:[animation-play-state:paused] w-max">
            {[...testimonials.slice(0, 10), ...testimonials.slice(0, 10)].map((testimonial, index) => (
              <TestimonialCard key={`row1-${index}`} testimonial={testimonial} />
            ))}
          </div>
        </div>

        <div className="overflow-hidden">
          <div className="flex gap-6 animate-scroll-right hover:[animation-play-state:paused] w-max">
            {[...testimonials.slice(10), ...testimonials.slice(10)].map((testimonial, index) => (
              <TestimonialCard key={`row2-${index}`} testimonial={testimonial} />
            ))}
          </div>
        </div>
      </div>

      {/* Mobile: Manual carousel */}
      <div className="md:hidden px-6">
        <Carousel opts={{ align: "start", loop: true }} className="w-full">
          <CarouselContent className="-ms-4">
            {testimonials.map((testimonial, index) => (
              <CarouselItem key={index} className="ps-4 basis-[85%]">
                <div className="p-6 rounded-2xl border border-border/60 bg-card shadow-md">
                  <Quote className="w-8 h-8 text-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4 line-clamp-4">
                    "{testimonial.text}"
                  </p>
                  <div className="flex items-center gap-1 mb-3">
                    {Array.from({ length: testimonial.rating }).map((_, i) => (
                      <Star key={i} className="w-4 h-4 fill-yellow-500 text-yellow-500" />
                    ))}
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{testimonial.name}</p>
                    <p className="text-xs text-muted-foreground">{testimonial.role}</p>
                    <p className="text-xs font-medium text-foreground">{testimonial.company}</p>
                  </div>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          <div className="flex justify-center gap-2 mt-6">
            <CarouselPrevious className="static translate-y-0" />
            <CarouselNext className="static translate-y-0" />
          </div>
        </Carousel>
      </div>
    </section>
  );
}
