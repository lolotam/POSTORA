import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, type NodeProps, NodeResizer, useReactFlow } from "@xyflow/react";
import { 
  Share2, Instagram, Facebook, Twitter, Linkedin, 
  Youtube, Music2, MessageCircle, Send, Calendar, Settings2, ChevronDown,
  Users, Globe, Lock, Eye, MapPin, Link2, CalendarIcon, Clock, X, Check, AlertCircle, ExternalLink
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Platform icon mapping
const PLATFORM_ICONS: Record<string, any> = {
  instagram: Instagram,
  facebook: Facebook,
  twitter: Twitter,
  linkedin: Linkedin,
  tiktok: Music2,
  youtube: Youtube,
  threads: MessageCircle,
  bluesky: Globe,
  pinterest: MapPin,
  reddit: MessageCircle,
};

const PLATFORM_COLORS: Record<string, { color: string; bg: string }> = {
  instagram: { color: 'text-pink-500', bg: 'bg-pink-500/10' },
  facebook: { color: 'text-blue-600', bg: 'bg-blue-600/10' },
  twitter: { color: 'text-foreground', bg: 'bg-foreground/10' },
  linkedin: { color: 'text-blue-700', bg: 'bg-blue-700/10' },
  tiktok: { color: 'text-foreground', bg: 'bg-foreground/10' },
  youtube: { color: 'text-red-500', bg: 'bg-red-500/10' },
  threads: { color: 'text-foreground', bg: 'bg-foreground/10' },
  bluesky: { color: 'text-sky-500', bg: 'bg-sky-500/10' },
  pinterest: { color: 'text-red-600', bg: 'bg-red-600/10' },
  reddit: { color: 'text-orange-500', bg: 'bg-orange-500/10' },
};

// Platform-specific settings interfaces
interface InstagramSettings {
  postType: 'feed' | 'reel' | 'story';
  location: string;
  firstComment: string;
  shareToFeed: boolean;
}

interface FacebookSettings {
  postType: 'feed' | 'reel' | 'story';
  audience: 'public' | 'friends' | 'only_me';
  location: string;
}

interface TwitterSettings {
  replySettings: 'everyone' | 'following' | 'mentioned';
  threadMode: boolean;
}

interface LinkedInSettings {
  visibility: 'public' | 'connections';
}

interface TikTokSettings {
  privacyLevel: 'public' | 'friends' | 'private';
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
}

interface YouTubeSettings {
  visibility: 'public' | 'unlisted' | 'private';
  videoType: 'standard' | 'shorts';
}

interface ThreadsSettings {
  replyControl: 'everyone' | 'following' | 'mentioned';
}

export interface PlatformSettings {
  instagram: InstagramSettings;
  facebook: FacebookSettings;
  twitter: TwitterSettings;
  linkedin: LinkedInSettings;
  tiktok: TikTokSettings;
  youtube: YouTubeSettings;
  threads: ThreadsSettings;
}

export interface PlatformNodeData extends Record<string, unknown> {
  enabledPlatforms?: string[];
  selectedAccountIds?: string[];
  settings?: Partial<PlatformSettings>;
  scheduledAt?: string;
  executionResults?: Record<string, { success: boolean; error?: string }>;
  onPublish?: () => void;
  onSchedule?: (date: Date) => void;
}

const defaultSettings: PlatformSettings = {
  instagram: { postType: 'feed', location: '', firstComment: '', shareToFeed: true },
  facebook: { postType: 'feed', audience: 'public', location: '' },
  twitter: { replySettings: 'everyone', threadMode: false },
  linkedin: { visibility: 'public' },
  tiktok: { privacyLevel: 'public', allowComments: true, allowDuet: true, allowStitch: true },
  youtube: { visibility: 'public', videoType: 'standard' },
  threads: { replyControl: 'everyone' },
};

function generateTimeOptions() {
  const times: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 15) {
      times.push(`${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`);
    }
  }
  return times;
}
const TIME_OPTIONS = generateTimeOptions();

// Platform settings sub-components
function InstagramSettingsPanel({ settings, onChange }: { settings: InstagramSettings; onChange: (s: Partial<InstagramSettings>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">Post Type</Label>
        <RadioGroup value={settings.postType} onValueChange={(v) => onChange({ postType: v as any })} className="flex gap-2">
          {['feed', 'reel', 'story'].map(t => (
            <div key={t} className="flex items-center gap-1">
              <RadioGroupItem value={t} id={`ig-${t}`} className="h-3 w-3" />
              <Label htmlFor={`ig-${t}`} className="text-[10px] capitalize cursor-pointer">{t}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" /> Location</Label>
        <Input value={settings.location} onChange={(e) => onChange({ location: e.target.value })} placeholder="Add location..." className="h-7 text-[11px]" />
      </div>
      {settings.postType === 'reel' && (
        <div className="flex items-center justify-between">
          <Label className="text-[10px] text-muted-foreground">Share to Feed</Label>
          <Switch checked={settings.shareToFeed} onCheckedChange={(v) => onChange({ shareToFeed: v })} className="scale-75" />
        </div>
      )}
    </div>
  );
}

function FacebookSettingsPanel({ settings, onChange }: { settings: FacebookSettings; onChange: (s: Partial<FacebookSettings>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">Post Type</Label>
        <RadioGroup value={settings.postType} onValueChange={(v) => onChange({ postType: v as any })} className="flex gap-2">
          {['feed', 'reel', 'story'].map(t => (
            <div key={t} className="flex items-center gap-1">
              <RadioGroupItem value={t} id={`fb-${t}`} className="h-3 w-3" />
              <Label htmlFor={`fb-${t}`} className="text-[10px] capitalize cursor-pointer">{t}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" /> Audience</Label>
        <Select value={settings.audience} onValueChange={(v) => onChange({ audience: v as any })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="public" className="text-xs">🌐 Public</SelectItem>
            <SelectItem value="friends" className="text-xs">👥 Friends</SelectItem>
            <SelectItem value="only_me" className="text-xs">🔒 Only Me</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function TwitterSettingsPanel({ settings, onChange }: { settings: TwitterSettings; onChange: (s: Partial<TwitterSettings>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">Who can reply</Label>
        <Select value={settings.replySettings} onValueChange={(v) => onChange({ replySettings: v as any })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="everyone" className="text-xs">Everyone</SelectItem>
            <SelectItem value="following" className="text-xs">People you follow</SelectItem>
            <SelectItem value="mentioned" className="text-xs">Only mentioned</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground">Thread Mode</Label>
        <Switch checked={settings.threadMode} onCheckedChange={(v) => onChange({ threadMode: v })} className="scale-75" />
      </div>
    </div>
  );
}

function TikTokSettingsPanel({ settings, onChange }: { settings: TikTokSettings; onChange: (s: Partial<TikTokSettings>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">Privacy</Label>
        <Select value={settings.privacyLevel} onValueChange={(v) => onChange({ privacyLevel: v as any })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="public" className="text-xs">🌐 Public</SelectItem>
            <SelectItem value="friends" className="text-xs">👥 Friends</SelectItem>
            <SelectItem value="private" className="text-xs">🔒 Private</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-[10px] text-muted-foreground">Interactions</Label>
        {[
          { key: 'allowComments', label: 'Allow Comments' },
          { key: 'allowDuet', label: 'Allow Duet' },
          { key: 'allowStitch', label: 'Allow Stitch' },
        ].map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{label}</span>
            <Switch checked={(settings as any)[key]} onCheckedChange={(v) => onChange({ [key]: v })} className="scale-75" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LinkedInSettingsPanel({ settings, onChange }: { settings: LinkedInSettings; onChange: (s: Partial<LinkedInSettings>) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">Visibility</Label>
      <Select value={settings.visibility} onValueChange={(v) => onChange({ visibility: v as any })}>
        <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="public" className="text-xs">🌐 Anyone</SelectItem>
          <SelectItem value="connections" className="text-xs">👥 Connections only</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function YouTubeSettingsPanel({ settings, onChange }: { settings: YouTubeSettings; onChange: (s: Partial<YouTubeSettings>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">Video Type</Label>
        <RadioGroup value={settings.videoType} onValueChange={(v) => onChange({ videoType: v as any })} className="flex gap-3">
          <div className="flex items-center gap-1">
            <RadioGroupItem value="standard" id="yt-standard" className="h-3 w-3" />
            <Label htmlFor="yt-standard" className="text-[10px] cursor-pointer">Standard</Label>
          </div>
          <div className="flex items-center gap-1">
            <RadioGroupItem value="shorts" id="yt-shorts" className="h-3 w-3" />
            <Label htmlFor="yt-shorts" className="text-[10px] cursor-pointer">Shorts</Label>
          </div>
        </RadioGroup>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">Visibility</Label>
        <Select value={settings.visibility} onValueChange={(v) => onChange({ visibility: v as any })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="public" className="text-xs">🌐 Public</SelectItem>
            <SelectItem value="unlisted" className="text-xs">🔗 Unlisted</SelectItem>
            <SelectItem value="private" className="text-xs">🔒 Private</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ThreadsSettingsPanel({ settings, onChange }: { settings: ThreadsSettings; onChange: (s: Partial<ThreadsSettings>) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">Who can reply</Label>
      <Select value={settings.replyControl} onValueChange={(v) => onChange({ replyControl: v as any })}>
        <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="everyone" className="text-xs">Everyone</SelectItem>
          <SelectItem value="following" className="text-xs">Profiles you follow</SelectItem>
          <SelectItem value="mentioned" className="text-xs">Mentioned only</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function PlatformSettingsContent({ platformId, settings, onChange }: { platformId: string; settings: PlatformSettings; onChange: (platform: string, s: any) => void }) {
  const panels: Record<string, JSX.Element> = {
    instagram: <InstagramSettingsPanel settings={settings.instagram} onChange={(s) => onChange('instagram', s)} />,
    facebook: <FacebookSettingsPanel settings={settings.facebook} onChange={(s) => onChange('facebook', s)} />,
    twitter: <TwitterSettingsPanel settings={settings.twitter} onChange={(s) => onChange('twitter', s)} />,
    linkedin: <LinkedInSettingsPanel settings={settings.linkedin} onChange={(s) => onChange('linkedin', s)} />,
    tiktok: <TikTokSettingsPanel settings={settings.tiktok} onChange={(s) => onChange('tiktok', s)} />,
    youtube: <YouTubeSettingsPanel settings={settings.youtube} onChange={(s) => onChange('youtube', s)} />,
    threads: <ThreadsSettingsPanel settings={settings.threads} onChange={(s) => onChange('threads', s)} />,
  };
  return panels[platformId] || null;
}

function PlatformNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as PlatformNodeData;
  const { setNodes } = useReactFlow();
  const { data: socialAccounts } = useSocialAccounts();
  
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(nodeData.selectedAccountIds || [])
  );
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
  const [settings, setSettings] = useState<PlatformSettings>({
    ...defaultSettings,
    ...nodeData.settings,
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>(
    nodeData.scheduledAt ? new Date(nodeData.scheduledAt) : undefined
  );
  const [scheduledTime, setScheduledTime] = useState<string>(
    nodeData.scheduledAt ? format(new Date(nodeData.scheduledAt), "HH:mm") : "12:00"
  );

  // Sync data to ReactFlow node state
  const updateNodeData = useCallback((updates: Partial<PlatformNodeData>) => {
    setNodes(nds => nds.map(n => 
      n.id === id ? { ...n, data: { ...n.data, ...updates } } : n
    ));
  }, [id, setNodes]);

  // Group accounts by platform
  const accountsByPlatform = (socialAccounts || []).reduce((acc, account) => {
    const platform = account.platform;
    if (!acc[platform]) acc[platform] = [];
    acc[platform].push(account);
    return acc;
  }, {} as Record<string, typeof socialAccounts extends (infer T)[] | undefined ? T[] : never[]>);

  const availablePlatforms = Object.keys(accountsByPlatform);

  const toggleAccount = useCallback((accountId: string, platform: string) => {
    setSelectedAccountIds(prev => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      // Derive enabled platforms from selected accounts
      const enabledPlatforms = [...next].map(aid => {
        const acc = (socialAccounts || []).find(a => a.id === aid);
        return acc?.platform;
      }).filter(Boolean) as string[];
      
      updateNodeData({ 
        selectedAccountIds: [...next],
        enabledPlatforms: [...new Set(enabledPlatforms)],
      });
      return next;
    });
  }, [socialAccounts, updateNodeData]);

  const updateSettings = useCallback((platform: string, updates: any) => {
    setSettings(prev => {
      const newSettings = {
        ...prev,
        [platform]: { ...(prev as any)[platform], ...updates },
      };
      updateNodeData({ settings: newSettings });
      return newSettings;
    });
  }, [updateNodeData]);

  const handleScheduleConfirm = useCallback(() => {
    if (!scheduledDate) return;
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    const finalDate = new Date(scheduledDate);
    finalDate.setHours(hours, minutes, 0, 0);
    updateNodeData({ scheduledAt: finalDate.toISOString() });
    setShowScheduler(false);
    nodeData.onSchedule?.(finalDate);
  }, [scheduledDate, scheduledTime, nodeData, updateNodeData]);

  const clearSchedule = useCallback(() => {
    setScheduledDate(undefined);
    updateNodeData({ scheduledAt: undefined });
  }, [updateNodeData]);

  const handlePublish = useCallback(() => {
    nodeData.onPublish?.();
  }, [nodeData]);

  const enabledCount = selectedAccountIds.size;
  const isScheduled = !!scheduledDate;
  const executionResults = nodeData.executionResults;

  return (
    <div className="relative">
      {/* Floating Label with status */}
      <div className="absolute -top-8 start-6 flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg text-xs font-medium text-muted-foreground border border-border/50 z-10">
        <Share2 className="h-3.5 w-3.5" />
        <span>Publisher</span>
        {enabledCount > 0 ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <AlertCircle className="h-3 w-3 text-amber-500" />
        )}
      </div>

      {/* Floating Toolbar */}
      {selected && (
        <div className="absolute -top-14 start-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-0.5 px-1.5 py-1 bg-card border border-border/50 rounded-xl shadow-lg">
            <button className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-primary/20 hover:text-primary transition-colors" onClick={handlePublish}>
              <Send className="h-3.5 w-3.5" />
            </button>
            <button className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-muted transition-colors" onClick={() => setExpandedPlatform(expandedPlatform ? null : availablePlatforms[0] || null)}>
              <Settings2 className="h-3.5 w-3.5" />
            </button>
            <button className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-destructive/20 hover:text-destructive transition-colors" onClick={() => setShowDeleteConfirm(true)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Node */}
      <div
        className={cn(
          "min-w-[320px] rounded-2xl overflow-hidden transition-all duration-300",
          "bg-card",
          selected ? "node-glow-platform" : "border-2 border-green-500/30 hover:border-green-500/50"
        )}
        style={{ minHeight: 200 }}
      >
        {/* Category accent strip */}
        <div className="h-1 bg-green-500/80" />
        <NodeResizer
          color="hsl(150 80% 45%)"
          isVisible={selected}
          minWidth={320}
          minHeight={200}
          handleStyle={{ width: 8, height: 8, borderRadius: '50%', border: '2px solid hsl(150 80% 45%)', background: 'hsl(var(--card))' }}
          lineStyle={{ borderColor: 'hsl(150 80% 45%)', borderWidth: 1 }}
        />

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete node?</AlertDialogTitle>
              <AlertDialogDescription>This will permanently delete this Platform node and its connections.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => setNodes(nodes => nodes.filter(n => n.id !== id))}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Input Handles */}
        <div className="px-3 pt-3 space-y-2">
          <div className="flex items-center gap-2 relative">
            <Handle type="target" position={Position.Left} id="caption"
              className={cn("!w-3.5 !h-3.5 !border-2 !bg-card !rounded-full !-left-[8px]", "!border-blue-500 hover:!bg-blue-500/20", "transition-colors")} />
            <span className="text-[11px] text-muted-foreground ps-1">Caption <span className="text-destructive">*</span></span>
          </div>
          <div className="flex items-center gap-2 relative">
            <Handle type="target" position={Position.Left} id="media"
              className={cn("!w-3.5 !h-3.5 !border-2 !bg-card !rounded-full !-left-[8px]", "!border-purple-500 hover:!bg-purple-500/20", "transition-colors")} />
            <span className="text-[11px] text-muted-foreground ps-1">Media</span>
          </div>
        </div>

        {/* Account Selection */}
        <div className="p-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">
            Connected Accounts {enabledCount > 0 && <span className="text-green-500">({enabledCount} selected)</span>}
          </p>
          <ScrollArea className="max-h-[350px]">
            <div className="space-y-2 pe-2">
              {availablePlatforms.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-xs text-muted-foreground mb-2">No connected accounts</p>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" asChild>
                    <a href="/profiles"><ExternalLink className="h-3 w-3" /> Connect Accounts</a>
                  </Button>
                </div>
              ) : (
                availablePlatforms.map((platform) => {
                  const accounts = accountsByPlatform[platform] || [];
                  const Icon = PLATFORM_ICONS[platform] || Share2;
                  const colors = PLATFORM_COLORS[platform] || { color: 'text-foreground', bg: 'bg-foreground/10' };
                  const isExpanded = expandedPlatform === platform;
                  const selectedCount = accounts.filter(a => selectedAccountIds.has(a.id)).length;

                  return (
                    <Collapsible key={platform} open={isExpanded} onOpenChange={(open) => setExpandedPlatform(open ? platform : null)}>
                      <div className={cn("rounded-lg border transition-colors", selectedCount > 0 ? "border-border bg-muted/30" : "border-transparent hover:bg-muted/20")}>
                        {/* Platform Header */}
                        <div className="flex items-center gap-2 px-2.5 py-2">
                          <div className={cn("h-6 w-6 rounded-md flex items-center justify-center", colors.bg)}>
                            <Icon className={cn("h-3.5 w-3.5", colors.color)} />
                          </div>
                          <span className="text-xs font-medium capitalize flex-1">{platform}</span>
                          {selectedCount > 0 && (
                            <span className="text-[10px] text-green-500 font-medium">{selectedCount}/{accounts.length}</span>
                          )}
                          {selectedCount > 0 && (
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-5 w-5">
                                <Settings2 className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")} />
                              </Button>
                            </CollapsibleTrigger>
                          )}
                        </div>

                        {/* Wrapping account chips */}
                        <div className="px-2.5 pb-2">
                          <div className="flex flex-wrap gap-1.5">
                            {accounts.map(account => {
                              const isSelected = selectedAccountIds.has(account.id);
                              const result = executionResults?.[account.id];
                              return (
                                <button
                                  key={account.id}
                                  onClick={() => toggleAccount(account.id, platform)}
                                  className={cn(
                                    "flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-all",
                                    isSelected
                                      ? "border-primary/50 bg-primary/10"
                                      : "border-border/50 hover:border-border hover:bg-muted/30"
                                  )}
                                >
                                  <Avatar className="h-5 w-5">
                                    <AvatarImage src={account.avatar_url || undefined} />
                                    <AvatarFallback className={cn("text-[8px]", colors.bg)}>
                                      <Icon className={cn("h-2.5 w-2.5", colors.color)} />
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="text-[10px] font-medium max-w-[80px] truncate">
                                    {account.platform_username || platform}
                                  </span>
                                  {result && (
                                    result.success 
                                      ? <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
                                      : <AlertCircle className="h-3 w-3 text-destructive flex-shrink-0" />
                                  )}
                                  {isSelected && !result && (
                                    <Check className="h-3 w-3 text-primary flex-shrink-0" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        
                        {/* Platform Settings (collapsed) */}
                        <CollapsibleContent>
                          <div className="px-3 pb-3 pt-1 border-t border-border/50">
                            <PlatformSettingsContent platformId={platform} settings={settings} onChange={updateSettings} />
                          </div>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Schedule Display */}
        {isScheduled && (
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 p-2 bg-amber-500/10 rounded-lg border border-amber-500/30">
              <Calendar className="h-4 w-4 text-amber-500" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-amber-600">Scheduled for {format(scheduledDate!, "MMM d, yyyy")}</p>
                <p className="text-[10px] text-amber-500/80">{scheduledTime}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-amber-500/20" onClick={clearSchedule}>
                <X className="h-3 w-3 text-amber-500" />
              </Button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-3 pb-3 space-y-2">
          <div className="flex gap-2">
            <Popover open={showScheduler} onOpenChange={setShowScheduler}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn("flex-1 h-8 text-xs gap-1.5", isScheduled && "border-amber-500 text-amber-600")} disabled={enabledCount === 0}>
                  <Calendar className="h-3 w-3" />
                  {isScheduled ? "Reschedule" : "Schedule"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <CalendarIcon className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Schedule Post</span>
                  </div>
                  <CalendarComponent mode="single" selected={scheduledDate} onSelect={setScheduledDate} disabled={(date) => date < new Date()} initialFocus className="rounded-md border pointer-events-auto" />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Time</Label>
                    <Select value={scheduledTime} onValueChange={setScheduledTime}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-[200px]">
                        {TIME_OPTIONS.map(time => <SelectItem key={time} value={time} className="text-xs">{time}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={() => setShowScheduler(false)}>Cancel</Button>
                    <Button size="sm" className="flex-1 h-8 text-xs bg-amber-500 hover:bg-amber-600" onClick={handleScheduleConfirm} disabled={!scheduledDate}>Confirm</Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            
            <Button size="sm" className="flex-1 h-8 text-xs gap-1.5 bg-green-500 hover:bg-green-600" disabled={enabledCount === 0} onClick={handlePublish}>
              <Send className="h-3 w-3" />
              {isScheduled ? "Schedule" : "Publish"}
            </Button>
          </div>
        </div>
      </div>

      {/* Output Handle */}
      <Handle
        type="source" position={Position.Right} id="result"
        className={cn("!w-8 !h-8 !border-2 !bg-card !rounded-full", "!border-green-500 hover:!bg-green-500/20", "flex items-center justify-center transition-colors", "!absolute !-right-4 !-top-4")}
      >
        <Share2 className="h-3.5 w-3.5 text-green-500" style={{ pointerEvents: 'none' }} />
      </Handle>
    </div>
  );
}

export const PlatformNode = memo(PlatformNodeComponent);
