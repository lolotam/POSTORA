import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const Terms = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl mx-auto px-4 py-12">
        <Link to="/">
          <Button variant="ghost" className="mb-8">
            <ArrowLeft className="me-2 h-4 w-4" />
            Back to Home
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Postora Terms of Service</h1>
        <p className="text-muted-foreground mb-8">Last updated: January 8, 2026</p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Acceptance of Terms</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              These Terms of Service constitute a legally binding agreement made between you and WALEED PROLIFE LLC ("Company", "we", "us", or "our"), a Limited Liability Company registered in Hawaii, USA (Address: 200 N Vineyard Blvd, Ste A325 334, Honolulu, HI 96817 USA), concerning your access to and use of the Postora.cloud platform.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              By accessing or using Postora, you agree to be bound by these Terms of Service and all applicable laws and regulations. If you do not agree with any of these terms, you are prohibited from using or accessing Postora.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Description of Service</h2>
            <p className="text-muted-foreground leading-relaxed">
              Postora is a social media management platform that provides tools for managing, scheduling, and publishing content across multiple social media platforms including YouTube, Facebook, Instagram, TikTok, Pinterest, X/Twitter, Threads, and Bluesky. Postora enables you to connect your social media accounts, create and schedule posts, analyze performance metrics, and manage your social media presence from a single dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. Account Registration</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">To use Postora, you must:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>Be at least 18 years of age</li>
              <li>Provide accurate and complete registration information</li>
              <li>Maintain the security of your account credentials</li>
              <li>Notify us immediately of any unauthorized use of your Postora account</li>
              <li>Accept responsibility for all activities that occur under your account</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. Social Media Account Connections</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              When you connect your social media accounts to Postora, you authorize Postora to access and interact with those accounts on your behalf. You represent that you have the authority to grant such access and that your use of Postora complies with the terms of service of each connected platform.
            </p>
            
            <h3 className="text-xl font-semibold mt-6 mb-3">4.1 YouTube and Google Services</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora uses YouTube API Services to enable you to upload and publish videos to your YouTube channel. By connecting your YouTube account to Postora:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>You agree to be bound by the{" "}
                <a 
                  href="https://www.youtube.com/t/terms" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  YouTube Terms of Service
                </a>
              </li>
              <li>You acknowledge that Google's Privacy Policy (
                <a 
                  href="https://policies.google.com/privacy" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  https://policies.google.com/privacy
                </a>
                ) applies to your use of YouTube features
              </li>
              <li>You can revoke Postora's access to your YouTube account at any time via your{" "}
                <a 
                  href="https://myaccount.google.com/permissions" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Google Account permissions
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. User Content</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">You retain ownership of all content you create and post through Postora. However, you grant Postora a license to:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>Store and process your content to provide our services</li>
              <li>Display content within the Postora platform interface</li>
              <li>Transmit content to connected social media platforms</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              You are solely responsible for ensuring that your content complies with applicable laws and does not infringe on any third-party rights. You are also responsible for ensuring your content complies with the community guidelines and terms of service of each platform you post to.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Prohibited Uses</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">You agree not to use Postora to:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>Violate any applicable laws or regulations</li>
              <li>Post content that is illegal, harmful, threatening, abusive, or defamatory</li>
              <li>Infringe on intellectual property rights of others</li>
              <li>Distribute spam or engage in automated posting that violates platform policies</li>
              <li>Attempt to gain unauthorized access to Postora's systems or other users' accounts</li>
              <li>Interfere with or disrupt the Postora service or servers</li>
              <li>Violate the terms of service or community guidelines of any connected social media platform</li>
              <li>Post content that violates YouTube's Community Guidelines when using YouTube features</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. Third-Party Platform Terms</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Your use of Postora to interact with third-party platforms is subject to each platform's own terms of service and policies. You agree to comply with:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>
                <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  YouTube Terms of Service
                </a>
              </li>
              <li>
                <a href="https://www.facebook.com/legal/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Meta (Facebook/Instagram) Terms of Service
                </a>
              </li>
              <li>
                <a href="https://www.tiktok.com/legal/terms-of-service" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  TikTok Terms of Service
                </a>
              </li>
              <li>
                <a href="https://policy.pinterest.com/terms-of-service" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Pinterest Terms of Service
                </a>
              </li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Postora is not responsible for changes to third-party platform APIs, terms, or policies that may affect the availability or functionality of certain features.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7.1 Social Media Integrations and Fair Use</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora allows you to connect third-party social media accounts, including LinkedIn. By connecting these accounts, you agree to comply with the respective platform's Terms of Service, including the{" "}
              <a href="https://legal.linkedin.com/api-terms-of-use" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">LinkedIn API Terms of Use</a>.
            </p>
            <h4 className="text-lg font-semibold mt-4 mb-2">User Restrictions</h4>
            <p className="text-muted-foreground leading-relaxed mb-4">
              As a user of Postora, you agree that you will NOT:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ms-4">
              <li>Use our platform to send automated spam, bulk messages, or unsolicited promotional content.</li>
              <li>Attempt to scrape, export, or permanently store user data, comments, or interactions fetched from LinkedIn.</li>
              <li>Use Postora to build a database of LinkedIn members for recruitment, sales, or lead-generation purposes.</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              WALEED PROLIFE LLC reserves the right to immediately suspend or terminate any Postora account that violates these platform-specific restrictions to maintain our compliance with third-party API providers.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">8. Service Availability</h2>
            <p className="text-muted-foreground leading-relaxed">
              Postora strives to provide reliable service but cannot guarantee uninterrupted access. Postora reserves the right to modify, suspend, or discontinue any aspect of the service at any time. Postora is not liable for any scheduled posts that fail to publish due to service interruptions, third-party platform changes, API limitations, or token expiration.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">9. Intellectual Property</h2>
            <p className="text-muted-foreground leading-relaxed">
              Postora, including its original content, features, and functionality, is owned by Postora and protected by international copyright, trademark, and other intellectual property laws. The Postora name and logo may not be used in connection with any product or service without prior written consent.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">10. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              To the maximum extent permitted by law, Postora shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or business opportunities, arising out of or in connection with your use of Postora or any third-party platform integrations.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">11. Termination</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora may terminate or suspend your account and access to the service immediately, without prior notice, for conduct that Postora believes violates these Terms of Service or is harmful to other users, Postora, or third parties, or for any other reason at Postora's sole discretion.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Upon termination, your right to use Postora will immediately cease. You may request deletion of your data in accordance with our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">12. Changes to Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Postora reserves the right to modify these terms at any time. Postora will notify users of any material changes by posting the new Terms of Service on this page and updating the "Last updated" date. Your continued use of Postora after such changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">13. Contact Information</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about these Terms of Service, please contact Postora at legal@postora.cloud.
            </p>
          </section>

          <section className="pt-8 border-t border-border">
            <h2 className="text-2xl font-semibold mb-4">Related Policies</h2>
            <div className="flex flex-wrap gap-4">
              <Link to="/privacy">
                <Button variant="outline">Privacy Policy</Button>
              </Link>
              <Link to="/cookies">
                <Button variant="outline">Cookie Policy</Button>
              </Link>
              <Link to="/google-api-disclosure">
                <Button variant="outline">Google API Disclosure</Button>
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default Terms;
