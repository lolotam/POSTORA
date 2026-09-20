import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  User,
  Camera,
  Upload,
  Trash2,
  Loader2,
} from "lucide-react";


interface ProfileSectionProps {
  fullName: string;
  setFullName: (name: string) => void;
  email: string;
  onSave: () => void;
  isSaving: boolean;
}

export function ProfileSection({
  fullName,
  setFullName,
  email,
  onSave,
  isSaving,
}: ProfileSectionProps) {
  const { t } = useTranslation("accounts");
  const { toast } = useToast();
  const { profile, refreshProfile, user } = useAuth();


  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return "U";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (!file.type.startsWith("image/")) {
      toast({
        title: t("profile.toast.invalidType", "Invalid file type"),
        description: t("profile.toast.invalidTypeDesc", "Please upload an image file (JPG, PNG, etc.)"),
        variant: "destructive",
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t("profile.toast.tooLarge", "File too large"),
        description: t("profile.toast.tooLargeDesc", "Please upload an image smaller than 5MB"),
        variant: "destructive",
      });
      return;
    }

    setIsUploadingAvatar(true);

    try {
      // Convert file to base64 for Cloudinary upload
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(t("profile.errors.readFile", "Failed to read file")));
        reader.readAsDataURL(file);
      });

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke("cloudinary-upload", {
        body: { fileData: base64, fileName: file.name, fileType: "image" }
      });

      if (uploadError || !uploadData?.success) {
        throw new Error(uploadData?.error || uploadError?.message || t("profile.errors.uploadFailed", "Upload failed"));
      }

      // Use .select() to detect silent 0-row updates (e.g. profile row
      // missing). If no row matched, upsert to guarantee the avatar is saved.
      const { data: updatedRows, error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: uploadData.url })
        .eq("id", user.id)
        .select("id");

      if (updateError) throw updateError;

      if (!updatedRows || updatedRows.length === 0) {
        const { error: upsertError } = await supabase
          .from("profiles")
          .upsert({ id: user.id, email: user.email ?? "", avatar_url: uploadData.url });
        if (upsertError) throw upsertError;
      }

      await refreshProfile();

      toast({
        title: t("profile.toast.updated", "Avatar updated"),
        description: t("profile.toast.updatedDesc", "Your profile picture has been changed."),
      });
    } catch (error) {
      console.error("Avatar upload error:", error);
      toast({
        title: t("profile.toast.uploadFailed", "Upload failed"),
        description: error instanceof Error ? error.message : t("profile.toast.uploadFailedDesc", "Failed to upload avatar"),
        variant: "destructive",
      });
    } finally {
      setIsUploadingAvatar(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = "";
      }
    }
  };

  const handleRemoveAvatar = async () => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: null })
        .eq("id", user.id)
        .select("id");

      if (error) throw error;

      await refreshProfile();

      toast({
        title: t("profile.toast.removed", "Avatar removed"),
        description: t("profile.toast.removedDesc", "Your profile picture has been removed."),
      });
    } catch (error) {
      toast({
        title: t("profile.toast.removeFailed", "Failed to remove avatar"),
        description: error instanceof Error ? error.message : t("profile.errors.generic", "An error occurred"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile Picture Section */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Camera className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">{t("profile.picture.title", "Profile Picture")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("profile.picture.subtitle", "Upload a photo to personalize your account")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <Avatar className="w-24 h-24 border-2 border-border">
            <AvatarImage src={profile?.avatar_url || undefined} alt={t("profile.picture.alt", "Profile")} />
            <AvatarFallback className="text-2xl bg-primary/10 text-primary">
              {getInitials(profile?.full_name)}
            </AvatarFallback>
          </Avatar>

          <div className="space-y-3">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarUpload}
              className="hidden"
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isUploadingAvatar}
              >
                {isUploadingAvatar ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t("profile.picture.uploading", "Uploading...")}
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {t("profile.picture.upload", "Upload Photo")}
                  </>
                )}
              </Button>
              {profile?.avatar_url && (
                <Button variant="ghost" size="icon" onClick={handleRemoveAvatar}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("profile.picture.hint", "JPG, PNG or GIF. Max size 5MB.")}
            </p>
          </div>
        </div>
      </div>

      {/* Profile Info Section */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <User className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">{t("profile.info.title", "Profile Information")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("profile.info.subtitle", "Update your personal information")}
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="fullName">{t("profile.info.fullName", "Full Name")}</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("profile.info.email", "Email")}</Label>
            <Input id="email" type="email" value={email} disabled />
          </div>
        </div>
      </div>



      {/* Account Details */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <h3 className="font-semibold mb-4">{t("profile.details.title", "Account Details")}</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">{t("profile.details.memberSince", "Member since")}</p>
            <p className="font-medium">
              {profile?.created_at
                ? new Date(profile.created_at).toLocaleDateString()
                : t("common:unknown", "Unknown")}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">{t("profile.details.lastUpdated", "Last updated")}</p>
            <p className="font-medium">
              {profile?.updated_at
                ? new Date(profile.updated_at).toLocaleDateString()
                : t("common:unknown", "Unknown")}
            </p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          variant="gradient"
          size="lg"
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t("common:saving", "Saving...")}
            </>
          ) : (
            t("common:saveChanges", "Save Changes")
          )}
        </Button>
      </div>
    </div>
  );
}
