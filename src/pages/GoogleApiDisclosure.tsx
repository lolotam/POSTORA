import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Youtube, Shield, Lock, Trash2, AlertTriangle, ExternalLink, Target } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const GoogleApiDisclosure = () => {
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
              <Youtube className="h-8 w-8 text-red-500" />
              <h1 className="text-4xl font-bold">Google API Services Disclosure</h1>
            </div>
            <p className="text-muted-foreground">
              Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>

          <Alert className="border-blue-500/50 bg-blue-500/10">
            <AlertTriangle className="h-4 w-4 text-blue-500" />
            <AlertDescription className="text-sm">
              This disclosure explains how Postora uses Google API Services, including YouTube Data API, 
              in compliance with Google's policies and requirements.
            </AlertDescription>
          </Alert>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">Overview</h2>
              <p className="text-muted-foreground">
                Postora ("we", "us", or "our") uses Google API Services, specifically the YouTube Data API v3, 
                to enable users to publish content to their YouTube channels. This disclosure describes how we 
                access, use, store, and share information obtained through Google APIs.
              </p>
              <p className="text-muted-foreground">
                Our use of information received from Google APIs adheres to the{" "}
                <a 
                  href="https://developers.google.com/terms/api-services-user-data-policy" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Google API Services User Data Policy
                  <ExternalLink className="h-3 w-3" />
                </a>
                , including the Limited Use requirements.
              </p>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Target className="h-5 w-5" />
                Minimum Scopes Principle
              </h2>
              <Alert className="border-primary/50 bg-primary/10">
                <Shield className="h-4 w-4 text-primary" />
                <AlertDescription className="text-sm">
                  <strong>We only request the minimum permissions necessary to provide our service.</strong>
                </AlertDescription>
              </Alert>
              <p className="text-muted-foreground">
                In accordance with Google's{" "}
                <a 
                  href="https://developers.google.com/identity/protocols/oauth2/policies#request-minimum-required-scopes"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  OAuth 2.0 Policy
                  <ExternalLink className="h-3 w-3" />
                </a>
                , Postora adheres to the principle of requesting minimum scopes:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>
                  <strong>Two narrow YouTube scopes only:</strong> We request exactly{" "}
                  <code className="bg-muted px-1 rounded">https://www.googleapis.com/auth/youtube.readonly</code> and{" "}
                  <code className="bg-muted px-1 rounded">https://www.googleapis.com/auth/youtube.upload</code>.
                  Together they cover the YouTube operations we perform — uploading videos with your chosen metadata and
                  thumbnail, and reading basic channel info to display your connected account.
                </li>
                <li>
                  <strong>No broad management scope:</strong> We intentionally do not request the full{" "}
                  <code className="bg-muted px-1 rounded">youtube</code> scope, because it would grant far more access
                  (managing playlists, editing or deleting existing videos, channel settings) than Postora needs.
                </li>
                <li>
                  <strong>No analytics, monetization, or membership data:</strong> We never request scopes that would let us
                  read your YouTube Analytics, channel memberships, or partner/monetization data.
                </li>
              </ul>
              <div className="border rounded-lg p-4 bg-muted/30">
                <h3 className="font-semibold mb-2">Scopes We Intentionally Do NOT Request:</h3>
                <ul className="list-disc list-inside text-muted-foreground text-sm space-y-1">
                  <li><code className="bg-muted px-1 rounded">youtube</code> (broad) — Full channel management is not needed for publishing</li>
                  <li><code className="bg-muted px-1 rounded">youtube.force-ssl</code> — We don't manage or moderate your existing videos and comments</li>
                  <li><code className="bg-muted px-1 rounded">youtube.channel-memberships.creator</code> — We don't access membership data</li>
                  <li><code className="bg-muted px-1 rounded">yt-analytics.readonly</code> — We don't access your YouTube analytics</li>
                  <li><code className="bg-muted px-1 rounded">youtube.partner</code> — We don't access monetization data</li>
                </ul>
              </div>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Shield className="h-5 w-5" />
                What Data We Access
              </h2>
              <p className="text-muted-foreground">
                When you connect your YouTube account to Postora, we request access to the following scopes:
              </p>
              
              <div className="space-y-4">
                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold text-lg mb-2">YouTube Data API Scopes</h3>

                  <div className="space-y-4 mt-4">
                    <div className="border-l-4 border-primary ps-4">
                      <h4 className="font-semibold text-base">
                        <code className="bg-muted px-2 py-1 rounded text-sm">https://www.googleapis.com/auth/youtube.upload</code>
                      </h4>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Purpose:</strong> Lets Postora publish the videos you create or schedule to your own
                        YouTube channel, on your explicit instruction.
                      </p>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Justification — what we actually do with this scope:</strong>
                      </p>
                      <ul className="list-disc list-inside text-muted-foreground text-sm mt-2 space-y-1 ms-4">
                        <li>
                          <strong>Upload videos and Shorts</strong> to your channel with the title, description, tags,
                          category and privacy setting (public / unlisted / private) you choose in Postora.
                        </li>
                        <li>
                          <strong>Set a custom thumbnail</strong> on the video you just uploaded
                          (<code className="bg-muted px-1 rounded">thumbnails.set</code>), when you provide one.
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>User-facing feature:</strong> When you create a post with video content and select YouTube
                        as a target platform, Postora uploads the video and optionally sets your custom thumbnail — all
                        under your explicit instruction. This scope does not allow us to edit or delete your existing videos.
                      </p>
                    </div>

                    <div className="border-l-4 border-primary ps-4">
                      <h4 className="font-semibold text-base">
                        <code className="bg-muted px-2 py-1 rounded text-sm">https://www.googleapis.com/auth/youtube.readonly</code>
                      </h4>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Purpose:</strong> Read-only access used to identify and display your connected channel.
                      </p>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Justification — what we actually do with this scope:</strong>
                      </p>
                      <ul className="list-disc list-inside text-muted-foreground text-sm mt-2 space-y-1 ms-4">
                        <li>
                          <strong>Read basic channel info</strong> (channel name, channel ID, profile picture) at
                          connection time so we can show which YouTube account you connected and confirm the correct
                          channel before publishing.
                        </li>
                        <li>
                          <strong>Verify the connection stays healthy</strong> so we can warn you if the channel needs to
                          be reconnected before a scheduled post fails.
                        </li>
                      </ul>
                    </div>

                    <div className="border-l-4 border-muted ps-4">
                      <h4 className="font-semibold text-base">
                        <code className="bg-muted px-2 py-1 rounded text-sm">userinfo.profile</code> & <code className="bg-muted px-2 py-1 rounded text-sm">userinfo.email</code>
                      </h4>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Purpose:</strong> These scopes are requested only during Google Sign-In (not during YouTube connection)
                        to identify your Google account.
                      </p>
                      <p className="text-muted-foreground text-sm mt-2">
                        <strong>Note:</strong> When connecting YouTube separately, only the two YouTube scopes above are
                        requested. The userinfo scopes are handled by the initial Google login flow.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5" />
                How We Use Your Data
              </h2>
              <p className="text-muted-foreground">
                We use the data obtained through Google APIs solely for the following purposes:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>
                  <strong>Video Publishing:</strong> To upload videos you create or schedule to your connected YouTube channel
                </li>
                <li>
                  <strong>Account Display:</strong> To show your YouTube channel name and profile picture within the Postora interface
                </li>
                <li>
                  <strong>Authentication:</strong> To verify your identity and maintain your connected account status
                </li>
              </ul>

              <Alert className="border-green-500/50 bg-green-500/10 mt-4">
                <Shield className="h-4 w-4 text-green-500" />
                <AlertDescription className="text-sm">
                  <strong>We DO NOT:</strong>
                  <ul className="list-disc list-inside mt-2 space-y-1">
                    <li>Sell your data to third parties</li>
                    <li>Use your data for advertising purposes</li>
                    <li>Use your data for training AI/ML models</li>
                    <li>Share your data with other users</li>
                    <li>Access your data for any purpose other than providing our service</li>
                  </ul>
                </AlertDescription>
              </Alert>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Data Storage & Security</h2>
              <p className="text-muted-foreground">
                Your Google/YouTube data is stored securely:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>OAuth tokens are encrypted at rest in our database</li>
                <li>We use industry-standard security practices (HTTPS, encrypted connections)</li>
                <li>Access to data is restricted to authorized personnel only</li>
                <li>We regularly review and update our security measures</li>
              </ul>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Data Retention</h2>
              <p className="text-muted-foreground">
                We retain your Google/YouTube data for as long as your account is active or as needed to provide our services. 
                Specifically:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>OAuth tokens are retained while your YouTube account remains connected</li>
                <li>Channel information is retained for display purposes while connected</li>
                <li>Post history and metadata are retained according to our standard data retention policy</li>
              </ul>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Trash2 className="h-5 w-5" />
                Revoking Access & Data Deletion
              </h2>
              <p className="text-muted-foreground">
                You can revoke Postora's access to your Google/YouTube account at any time:
              </p>
              
              <div className="space-y-4">
                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold mb-2">Option 1: Through Postora</h3>
                  <p className="text-muted-foreground text-sm">
                    Navigate to <strong>Settings → Connected Accounts</strong> and disconnect your YouTube account. 
                    This will delete your YouTube connection data from our systems.
                  </p>
                </div>

                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold mb-2">Option 2: Through Google</h3>
                  <p className="text-muted-foreground text-sm">
                    Visit your{" "}
                    <a 
                      href="https://myaccount.google.com/permissions" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      Google Account Permissions
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {" "}page, find "Postora" in the list of connected apps, and click "Remove Access".
                  </p>
                </div>

                <div className="border rounded-lg p-4">
                  <h3 className="font-semibold mb-2">Option 3: Request Complete Deletion</h3>
                  <p className="text-muted-foreground text-sm">
                    Contact us through our{" "}
                    <a href="https://postora.cloud/contact" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Contact Page</a>
                    {" "}to request complete deletion of all data associated with your Google account.
                  </p>
                </div>
              </div>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Third-Party Sharing</h2>
              <p className="text-muted-foreground">
                We do not share your Google user data with any third parties, except:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>
                  <strong>Service Providers:</strong> We use Supabase for database hosting and authentication, 
                  which processes data on our behalf under strict confidentiality agreements
                </li>
                <li>
                  <strong>Legal Requirements:</strong> We may disclose data if required by law or to protect our rights
                </li>
              </ul>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">YouTube Terms of Service</h2>
              <p className="text-muted-foreground">
                By using Postora to connect to YouTube, you also agree to be bound by:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>
                  <a 
                    href="https://www.youtube.com/t/terms" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    YouTube Terms of Service
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a 
                    href="https://policies.google.com/privacy" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Google Privacy Policy
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a 
                    href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    YouTube Community Guidelines
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              </ul>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Limited Use Disclosure</h2>
              <p className="text-muted-foreground">
                Postora's use and transfer of information received from Google APIs to any other app will adhere to the{" "}
                <a 
                  href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Google API Services User Data Policy
                  <ExternalLink className="h-3 w-3" />
                </a>
                , including the Limited Use requirements.
              </p>
            </section>

            <section className="space-y-4 mt-8">
              <h2 className="text-2xl font-semibold">Contact Us</h2>
              <p className="text-muted-foreground">
                If you have questions about this disclosure or how we handle your Google data, please contact us through our{" "}
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
                <Link to="/cookies">
                  <Button variant="outline">Cookie Policy</Button>
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GoogleApiDisclosure;
