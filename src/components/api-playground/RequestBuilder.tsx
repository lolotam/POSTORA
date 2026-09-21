import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformIcon, ExtendedPlatform, getPlatformName } from "@/components/PlatformIcon";
import { Key, Zap, RefreshCw, ChevronDown, ChevronRight, Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Account } from "./types";
import { PLATFORMS } from "./types";

interface RequestBuilderProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  fetchAccounts: () => void;
  isFetchingAccounts: boolean;
  selectedPlatforms: ExtendedPlatform[];
  togglePlatform: (platform: ExtendedPlatform) => void;
  getAccountsForPlatform: (platform: ExtendedPlatform) => Account[];
  isAccountSelected: (platform: ExtendedPlatform, accountId: string) => boolean;
  toggleAccountForPlatform: (platform: ExtendedPlatform, account: Account) => void;
  accounts: Account[];
  operation: string;
  setOperation: (op: string) => void;
  caption: string;
  setCaption: (caption: string) => void;
  mediaUrl: string;
  setMediaUrl: (url: string) => void;
  firstComment: string;
  setFirstComment: (comment: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (show: boolean) => void;
  scheduledDate: string;
  setScheduledDate: (date: string) => void;
  timezone: string;
  setTimezone: (tz: string) => void;
  instagramShareToFeed: boolean;
  setInstagramShareToFeed: (val: boolean) => void;
  tiktokPrivacy: string;
  setTiktokPrivacy: (val: string) => void;
  youtubePrivacy: string;
  setYoutubePrivacy: (val: string) => void;
  youtubeCategoryId: string;
  setYoutubeCategoryId: (val: string) => void;
  twitterReplySettings: string;
  setTwitterReplySettings: (val: string) => void;
  linkedinVisibility: string;
  setLinkedinVisibility: (val: string) => void;
  pinterestBoardId: string;
  setPinterestBoardId: (val: string) => void;
  pinterestLink: string;
  setPinterestLink: (val: string) => void;
  isLoading: boolean;
  sendRequest: () => void;
}

export function RequestBuilder(props: RequestBuilderProps) {
  const {
    apiKey, setApiKey, fetchAccounts, isFetchingAccounts,
    selectedPlatforms, togglePlatform, getAccountsForPlatform,
    isAccountSelected, toggleAccountForPlatform, accounts,
    operation, setOperation, caption, setCaption, mediaUrl, setMediaUrl,
    firstComment, setFirstComment, showAdvanced, setShowAdvanced,
    scheduledDate, setScheduledDate, timezone, setTimezone,
    instagramShareToFeed, setInstagramShareToFeed,
    tiktokPrivacy, setTiktokPrivacy, youtubePrivacy, setYoutubePrivacy,
    youtubeCategoryId, setYoutubeCategoryId, twitterReplySettings, setTwitterReplySettings,
    linkedinVisibility, setLinkedinVisibility, pinterestBoardId, setPinterestBoardId,
    pinterestLink, setPinterestLink, isLoading, sendRequest,
  } = props;

  return (
    <div className="space-y-6">
      {/* API Key */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="w-4 h-4" /> Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="api-key">API Key</Label>
            <div className="flex gap-2 mt-1.5">
              <Input id="api-key" type="password" placeholder="postora-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="font-mono text-sm" />
              <Button variant="outline" size="icon" onClick={fetchAccounts} disabled={isFetchingAccounts}>
                {isFetchingAccounts ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <Link to="/api-keys" className="text-primary hover:underline">Get your API key</Link> from settings
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Request Configuration */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="w-4 h-4" /> Request Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Platform Selection */}
          <div>
            <Label>Platforms (select multiple)</Label>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {PLATFORMS.map((platform) => {
                const platformAccounts = getAccountsForPlatform(platform);
                const isSelected = selectedPlatforms.includes(platform);
                return (
                  <Button key={platform} variant={isSelected ? "default" : "outline"} size="sm" onClick={() => togglePlatform(platform)} className="gap-2">
                    <PlatformIcon platform={platform} size="xs" />
                    {getPlatformName(platform)}
                    {platformAccounts.length > 0 && <Badge variant="secondary" className="ms-1 text-xs">{platformAccounts.length}</Badge>}
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Account Selection */}
          {selectedPlatforms.length > 0 && accounts.length > 0 && (
            <div className="space-y-3">
              <Label>Select Accounts</Label>
              {selectedPlatforms.map((platform) => {
                const platformAccounts = getAccountsForPlatform(platform);
                if (platformAccounts.length === 0) return null;
                return (
                  <div key={platform} className="p-3 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-2 mb-2">
                      <PlatformIcon platform={platform} size="sm" />
                      <span className="font-medium text-sm">{getPlatformName(platform)}</span>
                    </div>
                    <div className="space-y-2">
                      {platformAccounts.map((account) => (
                        <div
                          key={account.id}
                          className={cn(
                            "flex items-center gap-3 p-2 rounded-md border cursor-pointer transition-colors",
                            isAccountSelected(platform, account.id) ? "bg-primary/10 border-primary/30" : "bg-background hover:bg-muted/50"
                          )}
                          onClick={() => toggleAccountForPlatform(platform, account)}
                        >
                          <Checkbox checked={isAccountSelected(platform, account.id)} className="pointer-events-none" />
                          {account.avatar_url && <img src={account.avatar_url} alt="" className="w-6 h-6 rounded-full" />}
                          <span className="text-sm">{account.platform_username}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Operation */}
          <div>
            <Label>Operation</Label>
            <Select value={operation} onValueChange={setOperation}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="upload_photos">Upload Photos</SelectItem>
                <SelectItem value="upload_video">Upload Video</SelectItem>
                <SelectItem value="upload_reel">Upload Reel</SelectItem>
                <SelectItem value="upload_story">Upload Story</SelectItem>
                <SelectItem value="create_text_post">Create Text Post</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Caption */}
          <div>
            <Label>Caption</Label>
            <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write your caption..." className="mt-1.5 min-h-[100px]" />
          </div>

          {/* Media URL */}
          <div>
            <Label>Media URL(s)</Label>
            <Input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://example.com/image.jpg" className="mt-1.5" />
            <p className="text-xs text-muted-foreground mt-1">Separate multiple URLs with commas</p>
          </div>

          {/* First Comment */}
          {selectedPlatforms.some(p => ["instagram", "facebook", "youtube"].includes(p)) && (
            <div>
              <Label>First Comment (optional)</Label>
              <Input value={firstComment} onChange={(e) => setFirstComment(e.target.value)} placeholder="Add hashtags or a follow-up comment..." className="mt-1.5" />
            </div>
          )}

          {/* Advanced Settings */}
          <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full justify-between">
            <span>Platform-Specific Settings</span>
            {showAdvanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </Button>

          {showAdvanced && (
            <div className="space-y-4 pt-2 border-t border-border">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Scheduled Date (Optional)</Label>
                  <Input type="datetime-local" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className="mt-1.5" />
                </div>
                <div>
                  <Label>Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="UTC">UTC</SelectItem>
                      <SelectItem value="America/New_York">New York</SelectItem>
                      <SelectItem value="America/Los_Angeles">Los Angeles</SelectItem>
                      <SelectItem value="Europe/London">London</SelectItem>
                      <SelectItem value="Europe/Paris">Paris</SelectItem>
                      <SelectItem value="Asia/Tokyo">Tokyo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {selectedPlatforms.includes("instagram") && (
                <div className="flex items-center justify-between">
                  <Label>Share to Feed (for Reels)</Label>
                  <Switch checked={instagramShareToFeed} onCheckedChange={setInstagramShareToFeed} />
                </div>
              )}

              {selectedPlatforms.includes("tiktok") && (
                <div>
                  <Label>Privacy Level</Label>
                  <Select value={tiktokPrivacy} onValueChange={setTiktokPrivacy}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PUBLIC_TO_EVERYONE">Public</SelectItem>
                      <SelectItem value="MUTUAL_FOLLOW_FRIENDS">Friends</SelectItem>
                      <SelectItem value="FOLLOWER_OF_CREATOR">Followers</SelectItem>
                      <SelectItem value="SELF_ONLY">Private</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {selectedPlatforms.includes("youtube") && (
                <div className="space-y-4">
                  <div>
                    <Label>Privacy Status</Label>
                    <Select value={youtubePrivacy} onValueChange={setYoutubePrivacy}>
                      <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="unlisted">Unlisted</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Category ID</Label>
                    <Select value={youtubeCategoryId} onValueChange={setYoutubeCategoryId}>
                      <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="22">People & Blogs</SelectItem>
                        <SelectItem value="24">Entertainment</SelectItem>
                        <SelectItem value="28">Science & Technology</SelectItem>
                        <SelectItem value="20">Gaming</SelectItem>
                        <SelectItem value="10">Music</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {selectedPlatforms.includes("twitter") && (
                <div>
                  <Label>Reply Settings</Label>
                  <Select value={twitterReplySettings} onValueChange={setTwitterReplySettings}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="everyone">Everyone</SelectItem>
                      <SelectItem value="mentionedUsers">Mentioned Users</SelectItem>
                      <SelectItem value="following">Following</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {selectedPlatforms.includes("linkedin") && (
                <div>
                  <Label>Visibility</Label>
                  <Select value={linkedinVisibility} onValueChange={setLinkedinVisibility}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PUBLIC">Public</SelectItem>
                      <SelectItem value="CONNECTIONS">Connections Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {selectedPlatforms.includes("pinterest") && (
                <div className="space-y-4">
                  <div>
                    <Label>Board ID</Label>
                    <Input placeholder="Board ID or name" value={pinterestBoardId} onChange={(e) => setPinterestBoardId(e.target.value)} className="mt-1.5" />
                  </div>
                  <div>
                    <Label>Destination Link</Label>
                    <Input placeholder="https://yourwebsite.com/page" value={pinterestLink} onChange={(e) => setPinterestLink(e.target.value)} className="mt-1.5" />
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Send Button */}
      <Button onClick={sendRequest} disabled={isLoading || !apiKey} size="lg" className="w-full gap-2">
        {isLoading ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Sending Request...</>
        ) : (
          <><Send className="w-4 h-4" /> Send Request</>
        )}
      </Button>
    </div>
  );
}
