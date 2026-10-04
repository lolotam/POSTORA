import { AdminLayout } from "@/components/admin/AdminLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RotateCcw, Youtube, Linkedin, Twitter } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Import refactored components and data
import {
  ChecklistSection,
  PlatformResourceCard,
  useOAuthChecklist,
  googleChecklistItems,
  googleCategoryInfo,
  tiktokChecklistItems,
  tiktokCategoryInfo,
  pinterestChecklistItems,
  pinterestCategoryInfo,
  linkedinChecklistItems,
  linkedinCategoryInfo,
  facebookChecklistItems,
  facebookCategoryInfo,
  instagramChecklistItems,
  instagramCategoryInfo,
  twitterChecklistItems,
  twitterCategoryInfo,
  redditChecklistItems,
  redditCategoryInfo,
  blueskyChecklistItems,
  blueskyCategoryInfo,
  googleResources,
  tiktokResources,
  pinterestResources,
  linkedinResources,
  facebookResources,
  instagramResources,
  twitterResources,
  redditResources,
  blueskyResources,
} from "./oauth-verification";

const AdminOAuthVerification = () => {
  // Use the refactored hook which returns all platforms
  const {
    google,
    tiktok,
    pinterest,
    linkedin,
    facebook,
    instagram,
    twitter,
    reddit,
    bluesky,
    resetAll,
  } = useOAuthChecklist();

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">OAuth Verification Checklists</h1>
            <p className="text-muted-foreground">
              Track verification requirements for all platform integrations
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <RotateCcw className="h-4 w-4" />
                Reset All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all checklists?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will clear all progress for every platform's verification checklist. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={resetAll}>Reset All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <Tabs defaultValue="google" className="w-full">
          <TabsList className="grid grid-cols-3 lg:grid-cols-9 h-auto gap-1">
            <TabsTrigger value="google" className="gap-2 text-xs">
              <Youtube className="h-4 w-4 text-red-500" />
              <span className="hidden sm:inline">Google</span>
            </TabsTrigger>
            <TabsTrigger value="tiktok" className="gap-2 text-xs">
              <PlatformIcon platform="tiktok" size="sm" />
              <span className="hidden sm:inline">TikTok</span>
            </TabsTrigger>
            <TabsTrigger value="pinterest" className="gap-2 text-xs">
              <PlatformIcon platform="pinterest" size="sm" />
              <span className="hidden sm:inline">Pinterest</span>
            </TabsTrigger>
            <TabsTrigger value="linkedin" className="gap-2 text-xs">
              <Linkedin className="h-4 w-4 text-blue-600" />
              <span className="hidden sm:inline">LinkedIn</span>
            </TabsTrigger>
            <TabsTrigger value="facebook" className="gap-2 text-xs">
              <PlatformIcon platform="facebook" size="sm" />
              <span className="hidden sm:inline">Facebook</span>
            </TabsTrigger>
            <TabsTrigger value="instagram" className="gap-2 text-xs">
              <PlatformIcon platform="instagram" size="sm" />
              <span className="hidden sm:inline">Instagram</span>
            </TabsTrigger>
            <TabsTrigger value="twitter" className="gap-2 text-xs">
              <Twitter className="h-4 w-4 text-sky-500" />
              <span className="hidden sm:inline">X/Twitter</span>
            </TabsTrigger>
            <TabsTrigger value="reddit" className="gap-2 text-xs">
              <PlatformIcon platform="reddit" size="sm" />
              <span className="hidden sm:inline">Reddit</span>
            </TabsTrigger>
            <TabsTrigger value="bluesky" className="gap-2 text-xs">
              <PlatformIcon platform="bluesky" size="sm" />
              <span className="hidden sm:inline">Bluesky</span>
            </TabsTrigger>
          </TabsList>

          {/* Google/YouTube Tab */}
          <TabsContent value="google" className="space-y-6">
            <ChecklistSection
              items={googleChecklistItems}
              categoryInfo={googleCategoryInfo}
              completedItems={google.completed}
              onToggle={google.toggle}
              platformName="Google/YouTube"
            />
            <PlatformResourceCard
              platformName="Google/YouTube"
              platformIcon={<Youtube className="h-5 w-5 text-red-500" />}
              description="Official documentation for YouTube Data API and Google OAuth verification"
              resources={googleResources}
            />
          </TabsContent>

          {/* TikTok Tab */}
          <TabsContent value="tiktok" className="space-y-6">
            <ChecklistSection
              items={tiktokChecklistItems}
              categoryInfo={tiktokCategoryInfo}
              completedItems={tiktok.completed}
              onToggle={tiktok.toggle}
              platformName="TikTok"
            />
            <PlatformResourceCard
              platformName="TikTok"
              platform="tiktok"
              description="Official TikTok developer documentation and compliance guidelines"
              resources={tiktokResources}
            />
          </TabsContent>

          {/* Pinterest Tab */}
          <TabsContent value="pinterest" className="space-y-6">
            <ChecklistSection
              items={pinterestChecklistItems}
              categoryInfo={pinterestCategoryInfo}
              completedItems={pinterest.completed}
              onToggle={pinterest.toggle}
              platformName="Pinterest"
            />
            <PlatformResourceCard
              platformName="Pinterest"
              platform="pinterest"
              description="Official Pinterest developer documentation and API reference"
              resources={pinterestResources}
            />
          </TabsContent>

          {/* LinkedIn Tab */}
          <TabsContent value="linkedin" className="space-y-6">
            <ChecklistSection
              items={linkedinChecklistItems}
              categoryInfo={linkedinCategoryInfo}
              completedItems={linkedin.completed}
              onToggle={linkedin.toggle}
              platformName="LinkedIn"
            />
            <PlatformResourceCard
              platformName="LinkedIn"
              platformIcon={<Linkedin className="h-5 w-5 text-blue-600" />}
              description="Official LinkedIn developer documentation and API reference"
              resources={linkedinResources}
            />
          </TabsContent>

          {/* Facebook Tab */}
          <TabsContent value="facebook" className="space-y-6">
            <ChecklistSection
              items={facebookChecklistItems}
              categoryInfo={facebookCategoryInfo}
              completedItems={facebook.completed}
              onToggle={facebook.toggle}
              platformName="Facebook"
            />
            <PlatformResourceCard
              platformName="Facebook"
              platform="facebook"
              description="Official Meta/Facebook developer documentation for Pages API and content publishing"
              resources={facebookResources}
            />
          </TabsContent>

          {/* Instagram Tab */}
          <TabsContent value="instagram" className="space-y-6">
            <ChecklistSection
              items={instagramChecklistItems}
              categoryInfo={instagramCategoryInfo}
              completedItems={instagram.completed}
              onToggle={instagram.toggle}
              platformName="Instagram"
            />
            <PlatformResourceCard
              platformName="Instagram"
              platform="instagram"
              description="Official documentation for Instagram Graph API"
              resources={instagramResources}
            />
          </TabsContent>

          {/* Twitter/X Tab */}
          <TabsContent value="twitter" className="space-y-6">
            <ChecklistSection
              items={twitterChecklistItems}
              categoryInfo={twitterCategoryInfo}
              completedItems={twitter.completed}
              onToggle={twitter.toggle}
              platformName="Twitter/X"
            />
            <PlatformResourceCard
              platformName="Twitter/X"
              platformIcon={<Twitter className="h-5 w-5 text-sky-500" />}
              description="Official documentation for Twitter/X API integration"
              resources={twitterResources}
            />
          </TabsContent>

          {/* Reddit Tab */}
          <TabsContent value="reddit" className="space-y-6">
            <ChecklistSection
              items={redditChecklistItems}
              categoryInfo={redditCategoryInfo}
              completedItems={reddit.completed}
              onToggle={reddit.toggle}
              platformName="Reddit"
            />
            <PlatformResourceCard
              platformName="Reddit"
              platform="reddit"
              description="Official Reddit API documentation and terms"
              resources={redditResources}
            />
          </TabsContent>

          {/* Bluesky Tab */}
          <TabsContent value="bluesky" className="space-y-6">
            <ChecklistSection
              items={blueskyChecklistItems}
              categoryInfo={blueskyCategoryInfo}
              completedItems={bluesky.completed}
              onToggle={bluesky.toggle}
              platformName="Bluesky"
            />
            <PlatformResourceCard
              platformName="Bluesky"
              platform="bluesky"
              description="Official Bluesky and AT Protocol documentation"
              resources={blueskyResources}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
};

export default AdminOAuthVerification;
