import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWhatsAppBusinessProfile, WhatsAppProfileError } from "@/hooks/useWhatsAppBusinessProfile";
import { Loader2, Save, Building2, Plus, X, QrCode } from "lucide-react";
import { Link } from "react-router-dom";

const VERTICALS = [
  "AUTOMOTIVE", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN",
  "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH", "NONPROFIT",
  "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "NOT_A_BIZ", "OTHER",
];

const VERTICAL_LABELS: Record<string, string> = {
  AUTOMOTIVE: "Automotive", BEAUTY: "Beauty & Spa", APPAREL: "Apparel & Clothing",
  EDU: "Education", ENTERTAIN: "Entertainment", EVENT_PLAN: "Event Planning",
  FINANCE: "Finance", GROCERY: "Grocery", GOVT: "Government",
  HOTEL: "Hotel & Lodging", HEALTH: "Health & Medical", NONPROFIT: "Non-Profit",
  PROF_SERVICES: "Professional Services", RETAIL: "Retail", TRAVEL: "Travel & Tourism",
  RESTAURANT: "Restaurant", NOT_A_BIZ: "Not a Business", OTHER: "Other",
};

export function BusinessProfileManager() {
  const { profile, isLoading, error, updateProfile, isUpdating } = useWhatsAppBusinessProfile();

  const [about, setAbout] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [websites, setWebsites] = useState<string[]>([]);
  const [vertical, setVertical] = useState("");

  useEffect(() => {
    if (profile) {
      setAbout(profile.about || "");
      setDescription(profile.description || "");
      setAddress(profile.address || "");
      setEmail(profile.email || "");
      setWebsites(profile.websites || []);
      setVertical(profile.vertical || "");
    }
  }, [profile]);

  const handleSave = () => {
    updateProfile({
      about: about || undefined,
      description: description || undefined,
      address: address || undefined,
      email: email || undefined,
      websites: websites.filter(Boolean).length > 0 ? websites.filter(Boolean) : undefined,
      vertical: vertical || undefined,
    });
  };

  const addWebsite = () => {
    if (websites.length < 2) setWebsites([...websites, ""]);
  };

  const removeWebsite = (idx: number) => {
    setWebsites(websites.filter((_, i) => i !== idx));
  };

  const updateWebsite = (idx: number, value: string) => {
    const updated = [...websites];
    updated[idx] = value;
    setWebsites(updated);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Direct QR runs a self-hosted session that Meta knows nothing about, so there is no business
  // profile to load. That is a property of the connection mode, not a failure worth alarming over.
  if (error instanceof WhatsAppProfileError && error.code === "PROFILE_REQUIRES_CLOUD_API") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <QrCode className="h-8 w-8 text-purple-600" />
          <div className="space-y-1">
            <p className="font-medium">Business profile needs a Cloud API connection</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              This number is connected with Direct QR, which runs a self-hosted WhatsApp session.
              Meta only stores a business profile for numbers connected through the Cloud API.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/messaging/whatsapp/setup">Review connection modes</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Failed to load profile: {(error as Error).message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Profile Photo & Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <Avatar className="w-16 h-16">
              {profile?.profile_picture_url ? (
                <AvatarImage src={profile.profile_picture_url} alt="Business profile" />
              ) : null}
              <AvatarFallback><Building2 className="w-8 h-8" /></AvatarFallback>
            </Avatar>
            <div>
              <CardTitle>Business Profile</CardTitle>
              <CardDescription>Manage your WhatsApp Business profile visible to customers</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Profile Fields */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Profile Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* About */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="about">About</Label>
              <span className="text-xs text-muted-foreground">{about.length}/139</span>
            </div>
            <Input
              id="about"
              value={about}
              onChange={(e) => setAbout(e.target.value.slice(0, 139))}
              placeholder="Brief description shown under your business name"
              maxLength={139}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="description">Description</Label>
              <span className="text-xs text-muted-foreground">{description.length}/512</span>
            </div>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 512))}
              placeholder="Detailed business description"
              maxLength={512}
              rows={4}
            />
          </div>

          {/* Address */}
          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Business address"
            />
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Business email"
            />
          </div>

          {/* Websites */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Websites</Label>
              {websites.length < 2 && (
                <Button type="button" variant="ghost" size="sm" onClick={addWebsite} className="gap-1 h-7 text-xs">
                  <Plus className="w-3 h-3" /> Add
                </Button>
              )}
            </div>
            {websites.map((url, idx) => (
              <div key={idx} className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => updateWebsite(idx, e.target.value)}
                  placeholder="https://example.com"
                  type="url"
                />
                <Button type="button" variant="ghost" size="icon" onClick={() => removeWebsite(idx)} className="shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {websites.length === 0 && (
              <p className="text-sm text-muted-foreground">No websites added. You can add up to 2.</p>
            )}
          </div>

          {/* Industry / Vertical */}
          <div className="space-y-2">
            <Label>Industry</Label>
            <Select value={vertical} onValueChange={setVertical}>
              <SelectTrigger>
                <SelectValue placeholder="Select industry" />
              </SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{VERTICAL_LABELS[v] || v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Save */}
          <div className="pt-2">
            <Button onClick={handleSave} disabled={isUpdating} className="gap-2">
              {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Profile
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
