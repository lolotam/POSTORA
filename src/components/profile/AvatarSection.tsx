import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { User, Upload, Trash2, Loader2 } from "lucide-react";

interface AvatarSectionProps {
  userId: string;
  avatarUrl: string | null | undefined;
  fullName: string | null | undefined;
  onRefresh: () => Promise<void>;
}

export function AvatarSection({ userId, avatarUrl, fullName, onRefresh }: AvatarSectionProps) {
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const getInitials = (name: string | null | undefined) => {
    if (!name) return "U";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid file type",
        description: "Please upload an image file (JPG, PNG, etc.)",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please upload an image smaller than 5MB",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);

    try {
      // Convert file to base64 for Cloudinary upload
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke("cloudinary-upload", {
        body: { fileData: base64, fileName: file.name, fileType: "image" }
      });

      if (uploadError || !uploadData?.success) {
        throw new Error(uploadData?.error || uploadError?.message || "Upload failed");
      }

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: uploadData.url })
        .eq("id", userId);

      if (updateError) throw updateError;

      await onRefresh();

      toast({
        title: "Avatar updated",
        description: "Your profile picture has been changed.",
      });
    } catch (error) {
      console.error("Avatar upload error:", error);
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Failed to upload avatar",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  };

  const handleRemove = async () => {
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: null })
        .eq("id", userId);

      if (error) throw error;

      await onRefresh();

      toast({
        title: "Avatar removed",
        description: "Your profile picture has been removed.",
      });
    } catch (error) {
      toast({
        title: "Failed to remove avatar",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <User className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">Profile Picture</h2>
          <p className="text-sm text-muted-foreground">
            Upload a photo to personalize your account
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <Avatar className="w-24 h-24 border-2 border-border">
          <AvatarImage src={avatarUrl || undefined} alt="Profile" />
          <AvatarFallback className="text-2xl bg-primary/10 text-primary">
            {getInitials(fullName)}
          </AvatarFallback>
        </Avatar>

        <div className="space-y-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="hidden"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 me-2" />
                  Upload Photo
                </>
              )}
            </Button>
            {avatarUrl && (
              <Button variant="ghost" size="icon" onClick={handleRemove}>
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            JPG, PNG or GIF. Max size 5MB.
          </p>
        </div>
      </div>
    </div>
  );
}
