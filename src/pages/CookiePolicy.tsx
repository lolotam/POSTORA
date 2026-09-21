import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Cookie, Shield, Settings, Info } from "lucide-react";

const CookiePolicy = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl py-12 px-4">
        <Link to="/">
          <Button variant="ghost" className="mb-8">
            <ArrowLeft className="me-2 h-4 w-4" />
            Back to Home
          </Button>
        </Link>

        <div className="space-y-8">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <Cookie className="h-8 w-8 text-primary" />
              <h1 className="text-4xl font-bold">Cookie Policy</h1>
            </div>
            <p className="text-muted-foreground">
              Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Info className="h-5 w-5" />
                What Are Cookies
              </h2>
              <p className="text-muted-foreground">
                Cookies are small text files that are stored on your computer or mobile device when you visit a website. 
                They are widely used to make websites work more efficiently and provide information to website owners.
              </p>
              <p className="text-muted-foreground">
                This Cookie Policy explains how Postify ("we", "us", or "our") uses cookies and similar technologies 
                when you visit our website or use our services.
              </p>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Cookie className="h-5 w-5" />
                Types of Cookies We Use
              </h2>
              
              <div className="space-y-6">
                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold text-lg mb-2">Essential Cookies</h3>
                  <p className="text-muted-foreground text-sm mb-2">
                    These cookies are necessary for the website to function properly. They enable core functionality 
                    such as security, network management, and account access.
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground text-sm space-y-1">
                    <li><strong>Authentication cookies:</strong> Keep you signed in to your account</li>
                    <li><strong>Security cookies:</strong> Protect against fraudulent activity and maintain security</li>
                    <li><strong>Session cookies:</strong> Remember your preferences during a browsing session</li>
                  </ul>
                </div>

                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold text-lg mb-2">Functional Cookies</h3>
                  <p className="text-muted-foreground text-sm mb-2">
                    These cookies enable enhanced functionality and personalization, such as remembering your preferences.
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground text-sm space-y-1">
                    <li><strong>Theme preference:</strong> Remember your light/dark mode selection</li>
                    <li><strong>Timezone settings:</strong> Store your preferred timezone for scheduling</li>
                    <li><strong>Language preferences:</strong> Remember your language choice</li>
                  </ul>
                </div>

                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold text-lg mb-2">Third-Party Cookies</h3>
                  <p className="text-muted-foreground text-sm mb-2">
                    We integrate with third-party services that may set their own cookies:
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground text-sm space-y-1">
                    <li><strong>Supabase:</strong> Authentication and session management</li>
                    <li><strong>Google/YouTube:</strong> OAuth authentication for YouTube integration</li>
                    <li><strong>Facebook/Instagram:</strong> OAuth authentication for social media posting</li>
                    <li><strong>Pinterest:</strong> OAuth authentication for Pinterest integration</li>
                    <li><strong>TikTok:</strong> OAuth authentication for TikTok integration</li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Your Cookie Choices
              </h2>
              <p className="text-muted-foreground">
                You have several options for managing cookies:
              </p>
              
              <div className="space-y-4">
                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold mb-2">Browser Settings</h3>
                  <p className="text-muted-foreground text-sm">
                    Most web browsers allow you to control cookies through their settings. You can usually find these 
                    options in the "Options" or "Preferences" menu of your browser. You can set your browser to:
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground text-sm mt-2 space-y-1">
                    <li>Block all cookies</li>
                    <li>Accept only first-party cookies</li>
                    <li>Delete cookies when you close your browser</li>
                    <li>Browse in "private" or "incognito" mode</li>
                  </ul>
                </div>

                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold mb-2">Third-Party Opt-Out</h3>
                  <p className="text-muted-foreground text-sm">
                    You can opt out of third-party cookies by visiting the respective platforms:
                  </p>
                  <ul className="list-disc list-inside text-muted-foreground text-sm mt-2 space-y-1">
                    <li>
                      <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Google Analytics Opt-out
                      </a>
                    </li>
                    <li>
                      <a href="https://www.facebook.com/help/568137493302217" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Facebook Cookie Settings
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Impact of Disabling Cookies
              </h2>
              <p className="text-muted-foreground">
                Please note that if you disable or decline cookies, some features of our service may not function properly. 
                Specifically:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>You may not be able to stay signed in to your account</li>
                <li>Your preference settings may not be saved</li>
                <li>Social media platform connections may not work correctly</li>
                <li>Some security features may be impacted</li>
              </ul>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">GDPR Compliance</h2>
              <p className="text-muted-foreground">
                Under the General Data Protection Regulation (GDPR), you have the right to:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>Access your personal data</li>
                <li>Rectify inaccurate personal data</li>
                <li>Request erasure of your personal data</li>
                <li>Restrict processing of your personal data</li>
                <li>Data portability</li>
                <li>Object to processing of your personal data</li>
              </ul>
              <p className="text-muted-foreground mt-4">
                For more information about how we handle your personal data, please see our{" "}
                <Link to="/privacy" className="text-primary hover:underline">Privacy Policy</Link>.
              </p>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Updates to This Policy</h2>
              <p className="text-muted-foreground">
                We may update this Cookie Policy from time to time to reflect changes in our practices or for other 
                operational, legal, or regulatory reasons. We encourage you to review this page periodically.
              </p>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Contact Us</h2>
              <p className="text-muted-foreground">
                If you have any questions about our use of cookies or this Cookie Policy, please contact us through our{" "}
                <a href="https://postora.cloud/contact" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Contact Page</a>.
              </p>
            </section>

            <section className="mt-8 pt-8 border-t">
              <h3 className="font-semibold mb-4">Related Policies</h3>
              <div className="flex flex-wrap gap-4">
                <Link to="/privacy">
                  <Button variant="outline">Privacy Policy</Button>
                </Link>
                <Link to="/terms">
                  <Button variant="outline">Terms of Service</Button>
                </Link>
                <Link to="/google-api-disclosure">
                  <Button variant="outline">Google API Disclosure</Button>
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CookiePolicy;
