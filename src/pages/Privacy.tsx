import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const Privacy = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl mx-auto px-4 py-12">
        <Link to="/">
          <Button variant="ghost" className="mb-8">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Postora Privacy Policy</h1>
        <p className="text-muted-foreground mb-8">Last updated: January 8, 2026</p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora.cloud is a B2B social media management platform owned and operated by WALEED PROLIFE LLC, a Limited Liability Company registered in Hawaii, USA (Address: 200 N Vineyard Blvd, Ste A325 334, Honolulu, HI 96817 USA).
            </p>
            <p className="text-muted-foreground leading-relaxed">
              We respect your privacy and are committed to protecting your personal data. This privacy policy explains how Postora collects, uses, stores, shares, and safeguards your information when you use our social media management services. This policy applies to all users of Postora and covers data obtained from all connected platforms, including Google, YouTube, and LinkedIn.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Information We Collect</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">Postora collects information that you provide directly to us, including:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Account information (name, email address, password)</li>
              <li>Social media account credentials and OAuth access tokens</li>
              <li>Content you create, upload, or schedule through Postora</li>
              <li>Communication preferences and settings</li>
              <li>Usage data and analytics</li>
            </ul>
            
            <h3 className="text-xl font-semibold mt-6 mb-3">2.1 Google and YouTube User Data</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              When you connect your YouTube account to Postora, we collect the following data through the YouTube API Services:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>YouTube channel information (channel ID, channel name, channel URL)</li>
              <li>YouTube channel profile picture/thumbnail</li>
              <li>OAuth access tokens and refresh tokens for API authentication</li>
              <li>Video upload permissions to post content on your behalf</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Postora's use of information received from Google APIs will adhere to the{" "}
              <a 
                href="https://developers.google.com/terms/api-services-user-data-policy" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>

            <h3 className="text-xl font-semibold mt-6 mb-3">2.2 Google OAuth Sign-In</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora uses Google OAuth 2.0 as an authentication method, allowing you to sign in or create an account using your Google credentials. When you sign in with Google, we collect the following basic profile information:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Your name (as set in your Google account)</li>
              <li>Your email address</li>
              <li>Your Google profile picture</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              This information is used solely to create and manage your Postora user account, display your profile within the app, and communicate with you about your account. We do not use Google sign-in data for advertising, analytics profiling, or any purpose beyond account management.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. How We Use Your Information</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">Postora uses the information we collect exclusively to provide and improve our services:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Provide, maintain, and improve Postora's services</li>
              <li>Process and complete transactions</li>
              <li>Send you technical notices and support messages</li>
              <li>Respond to your comments and questions</li>
              <li>Analyze usage patterns to enhance user experience</li>
              <li>Post content to your connected social media accounts on your behalf</li>
              <li>Read, reply to, hide and delete comments on your own posts and videos when you use the Comment Manager, auto-reply rules or the AI agent</li>
              <li>Display your connected account information within the Postora dashboard</li>
            </ul>

            <h3 className="text-xl font-semibold mt-6 mb-3">3.1 YouTube Data Usage</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Specifically for YouTube/Google user data, we use this information solely to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Upload and publish videos to your YouTube channel on your behalf</li>
              <li>Display your YouTube channel information within the Postora interface</li>
              <li>Authenticate your identity and maintain your connected account session</li>
            </ul>

            <h3 className="text-xl font-semibold mt-6 mb-3">3.2 Prohibited Uses of Google User Data</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora does NOT use Google user data for any of the following prohibited purposes:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Targeted, personalized, retargeted, or interest-based advertising</li>
              <li>Selling data to data brokers or third parties</li>
              <li>Providing data to information resellers</li>
              <li>Determining credit-worthiness or for lending purposes</li>
              <li>Training artificial intelligence or machine learning models</li>
              <li>Creating databases of user information for resale</li>
              <li>Any purpose other than providing or improving Postora's user-facing features</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. Data Sharing and Disclosure</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora does not sell, trade, or rent your personal information or Google user data to third parties. We may share your information only in the following limited circumstances:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li><strong>With your connected social media platforms:</strong> To post content on your behalf as explicitly requested by you</li>
              <li><strong>Service providers:</strong> With trusted third-party service providers who assist us in operating our platform (e.g., cloud hosting), bound by confidentiality agreements</li>
              <li><strong>Legal requirements:</strong> When required by law, subpoena, or other legal process</li>
              <li><strong>Safety:</strong> To protect the rights, property, or safety of Postora, our users, or the public</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              We do not transfer or disclose your Google user data to third parties for purposes other than providing the Postora service functionality you have requested.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. Social Media Integrations</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              When you connect your social media accounts (such as TikTok, Facebook, Instagram, YouTube, Pinterest, X/Twitter, Threads, or Bluesky) to Postora, we access only the permissions necessary to provide our services. This includes the ability to post content, view basic profile information, and access engagement metrics.
            </p>
            <p className="text-muted-foreground leading-relaxed mb-4">
              You can disconnect any social media account at any time through your Postora account settings, which will revoke our access to that platform.
            </p>
            
            <h3 className="text-xl font-semibold mt-6 mb-3">5.1 Revoking YouTube Access</h3>
            <p className="text-muted-foreground leading-relaxed mb-4">
              You can revoke Postora's access to your YouTube account at any time by:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Disconnecting your YouTube account from Postora in your account settings</li>
              <li>Visiting your{" "}
                <a 
                  href="https://myaccount.google.com/permissions" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Google Account permissions page
                </a>
                {" "}and removing Postora's access
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5.2 LinkedIn Data Collection and Retention Policy</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora uses the LinkedIn Application Programming Interface (API) to allow users to authenticate, schedule posts, and view analytics for their authenticated LinkedIn Pages. By connecting your LinkedIn account, you agree to our processing of your data in strict compliance with the{" "}
              <a href="https://legal.linkedin.com/api-terms-of-use" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">LinkedIn API Terms of Use</a>.
            </p>

            <h4 className="text-lg font-semibold mt-4 mb-2">Data We Collect from YouTube</h4>
            <p className="text-muted-foreground leading-relaxed mb-4">
              With your authorization through Google OAuth 2.0 we read your channel name, ID and avatar, upload the videos you create in Postora, and read, reply to, hide and delete comments on your own videos when you use the Comment Manager, auto-reply rules or the AI agent. Comments are read on demand and by a scheduled check; each comment we act on is kept as YouTube returned it (its ID, text, and the commenter's public display name, channel ID and avatar URL) so the same comment is never answered twice. Postora's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.
            </p>

            <h4 className="text-lg font-semibold mt-4 mb-2">Data We Collect from LinkedIn</h4>
            <p className="text-muted-foreground leading-relaxed mb-4">
              We only fetch data explicitly authorized by you via the standard OAuth 2.0 flow. This includes basic profile information, page metadata, post content, and page analytics (impressions, clicks, and comments).
            </p>

            <h4 className="text-lg font-semibold mt-4 mb-2">Strict Data Retention Limits (24/48 Hour Rule)</h4>
            <p className="text-muted-foreground leading-relaxed mb-4">
              To comply with LinkedIn's Developer Policies, we enforce strict data retention limits:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li><strong>LinkedIn Member Profile Data:</strong> Any cached profile data is automatically permanently deleted from our servers within 24 hours of receipt.</li>
              <li><strong>LinkedIn Member Activity Data:</strong> Any fetched activity data (such as comments or likes on your posts) is dynamically displayed and permanently deleted from our servers within 48 hours.</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              We rely on real-time API fetching rather than long-term database storage for these metrics.
            </p>

            <h4 className="text-lg font-semibold mt-4 mb-2">Prohibited Data Uses</h4>
            <p className="text-muted-foreground leading-relaxed mb-4">
              WALEED PROLIFE LLC explicitly states that:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>We do not and will never sell, rent, or transfer LinkedIn data to any third-party data brokers, ad networks, or CRMs.</li>
              <li>We do not use LinkedIn data for lead generation, surveillance, or any external tracking.</li>
              <li>We do not allow the exporting of user activity data (e.g., exporting a list of commenters) outside the Postora platform.</li>
            </ul>

            <h4 className="text-lg font-semibold mt-4 mb-2">Data Revocation &amp; Deletion</h4>
            <p className="text-muted-foreground leading-relaxed">
              You can revoke Postora's access to your LinkedIn account at any time via your LinkedIn settings. Upon account deletion on Postora, all associated API tokens and cached data are immediately and permanently destroyed.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Data Security</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora implements appropriate technical and organizational security measures to protect your personal data against unauthorized access, alteration, disclosure, or destruction:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>All data is transmitted using TLS/SSL encryption</li>
              <li>Access tokens and sensitive credentials are encrypted at rest</li>
              <li>We use industry-standard security practices and regularly review our security procedures</li>
              <li>Access to user data is restricted to authorized personnel only</li>
              <li>Our infrastructure is hosted on secure, enterprise-grade cloud platforms</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. Data Retention and Deletion</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora retains your personal data for as long as your account is active or as needed to provide you services. Specifically:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Account information is retained while your account remains active</li>
              <li>Social media access tokens are retained until you disconnect the account or tokens expire</li>
              <li>Post history and scheduled content are retained until you delete them or close your account</li>
              <li>When you disconnect a social media account, associated tokens are deleted within 24 hours</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4 mb-4">
              <strong>Account Deletion:</strong> You may request deletion of your account and all associated data at any time by:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Using the account deletion option in your Postora account settings</li>
              <li>Contacting our support team at privacy@postora.cloud</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Upon account deletion, we will delete or anonymize your personal data within 30 days, except where we are required to retain data for legal or regulatory purposes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">8. Third-Party Services and Links</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Postora integrates with third-party social media platforms. Each platform has its own privacy policy and terms of service. We encourage you to review the privacy policies of any third-party services you connect to Postora:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>
                <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Google Privacy Policy
                </a>
              </li>
              <li>
                <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  YouTube Terms of Service
                </a>
              </li>
              <li>
                <a href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Meta (Facebook/Instagram) Privacy Policy
                </a>
              </li>
              <li>
                <a href="https://www.tiktok.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  TikTok Privacy Policy
                </a>
              </li>
              <li>
                <a href="https://policy.pinterest.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Pinterest Privacy Policy
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">9. Your Rights</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">You have the right to:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Access and receive a copy of your personal data</li>
              <li>Rectify inaccurate personal data</li>
              <li>Request deletion of your personal data</li>
              <li>Object to processing of your personal data</li>
              <li>Data portability</li>
              <li>Withdraw consent at any time</li>
              <li>Disconnect any connected social media account at any time</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              To exercise any of these rights, please contact us at privacy@postora.cloud or use the relevant options in your Postora account settings.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">10. Changes to This Privacy Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              Postora reserves the right to update this privacy policy at any time. We will notify users of any material changes by posting the new privacy policy on this page and updating the "Last updated" date. If we make changes to how we handle Google user data, we will notify affected users via email. Your continued use of Postora after such changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">11. Contact Us</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about this Privacy Policy or Postora's data practices, please contact us at privacy@postora.cloud.
            </p>
          </section>

          <section className="pt-8 border-t border-border">
            <h2 className="text-2xl font-semibold mb-4">Related Policies</h2>
            <div className="flex flex-wrap gap-4">
              <Link to="/terms">
                <Button variant="outline">Terms of Service</Button>
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

export default Privacy;
