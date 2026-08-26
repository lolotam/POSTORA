import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY")!;
const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET")!;

interface TranscodeRequest {
  media_file_id: string;
  user_id: string;
  target_platform: "tiktok" | "instagram" | "youtube";
}

interface TranscodeResponse {
  success: boolean;
  transcoded_url?: string;
  new_media_file_id?: string;
  error?: string;
}

// Use Cloudinary's eager transformation API with signed upload
async function transcodeWithCloudinary(
  videoUrl: string,
  targetPlatform: string
): Promise<{ url: string; publicId: string }> {
  console.log(`Transcoding video for ${targetPlatform}: ${videoUrl.substring(0, 100)}...`);

  // Define transformations based on platform
  const transformations: Record<string, string> = {
    tiktok: "c_fill,w_720,h_1280,ar_9:16,g_center/vc_h264,q_auto:best,f_mp4",
    instagram: "c_fill,w_1080,h_1920,ar_9:16,g_center/vc_h264,q_auto:best,f_mp4",
    youtube: "c_fill,w_1920,h_1080,ar_16:9,g_center/vc_h264,q_auto:best,f_mp4",
  };

  const transformation = transformations[targetPlatform] || transformations.tiktok;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `postora_${targetPlatform}_${timestamp}_${Math.random().toString(36).substring(7)}`;

  // Parameters to sign for authenticated upload (NO upload_preset for signed uploads)
  const paramsToSign: Record<string, string | number> = {
    public_id: publicId,
    timestamp: timestamp,
    eager: transformation,
    eager_async: "false",
  };

  // Generate signature - sorted params + api secret
  const sortedKeys = Object.keys(paramsToSign).sort();
  const stringToSign = sortedKeys.map(key => `${key}=${paramsToSign[key]}`).join("&");
  
  // Use SubtleCrypto for SHA-1
  const encoder = new TextEncoder();
  const data = encoder.encode(stringToSign + CLOUDINARY_API_SECRET);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const signature = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Build form data for signed upload (no upload_preset needed)
  const formData = new FormData();
  formData.append("file", videoUrl);
  formData.append("public_id", publicId);
  formData.append("timestamp", String(timestamp));
  formData.append("eager", transformation);
  formData.append("eager_async", "false"); // Wait for transformation
  formData.append("api_key", CLOUDINARY_API_KEY);
  formData.append("signature", signature);

  console.log("Uploading to Cloudinary with signed request and eager transformation...");

  const uploadResponse = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  const uploadResult = await uploadResponse.json();
  console.log("Cloudinary upload response status:", uploadResponse.status);

  if (!uploadResponse.ok || uploadResult.error) {
    console.error("Cloudinary error:", uploadResult);
    throw new Error(uploadResult.error?.message || "Cloudinary upload failed");
  }

  // Get the transcoded URL from eager transformation result
  let transcodedUrl: string;
  
  if (uploadResult.eager && uploadResult.eager.length > 0) {
    transcodedUrl = uploadResult.eager[0].secure_url;
    console.log("Eager transformation complete:", transcodedUrl);
  } else {
    // Fallback to building URL manually
    transcodedUrl = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${transformation}/${publicId}.mp4`;
    console.log("Built transformation URL:", transcodedUrl);
  }

  return {
    url: transcodedUrl,
    publicId: uploadResult.public_id,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsOptions();
  }

  try {
    const { media_file_id, user_id, target_platform } = await req.json() as TranscodeRequest;

    if (!media_file_id || !user_id) {
      throw new Error("Missing media_file_id or user_id");
    }

    console.log(`Transcode request: media_file_id=${media_file_id}, platform=${target_platform}`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Get the media file
    const { data: mediaFile, error: mediaError } = await supabase
      .from("media_files")
      .select("*")
      .eq("id", media_file_id)
      .eq("user_id", user_id)
      .single();

    if (mediaError || !mediaFile) {
      throw new Error("Media file not found");
    }

    // Check if it's a video
    if (mediaFile.file_type !== "video") {
      throw new Error("Only video files can be transcoded");
    }

    // Get video URL based on storage type
    let videoUrl: string;
    
    if (mediaFile.storage_bucket === "cloudinary") {
      // Cloudinary files: file_path contains the full URL
      videoUrl = mediaFile.file_path;
      console.log("Using Cloudinary URL directly");
    } else {
      // Supabase storage: create signed URL
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from(mediaFile.storage_bucket || "media")
        .createSignedUrl(mediaFile.file_path, 3600); // 1 hour expiry

      if (signedUrlError || !signedUrlData?.signedUrl) {
        console.error("Failed to create signed URL:", signedUrlError);
        throw new Error("Could not get video URL");
      }

      videoUrl = signedUrlData.signedUrl;
      console.log("Original video signed URL generated (expires in 1 hour)");
    }

    // Transcode with Cloudinary
    const { url: transcodedUrl, publicId } = await transcodeWithCloudinary(
      videoUrl,
      target_platform || "tiktok"
    );

    // The transcoded video is a Cloudinary derived asset — store it directly as a
    // Cloudinary-backed media row (no Supabase Storage write, no byte re-upload).
    const { data: newMediaFile, error: insertError } = await supabase
      .from("media_files")
      .insert({
        user_id: user_id,
        file_path: transcodedUrl,
        file_type: "video",
        file_size: null,
        mime_type: "video/mp4",
        storage_bucket: "cloudinary",
        cloudinary_public_id: publicId,
        metadata: {
          transcoded_from: media_file_id,
          target_platform: target_platform,
          original_file_path: mediaFile.file_path,
        },
      })
      .select()
      .single();

    if (insertError) {
      console.error("DB insert error:", insertError);
      throw new Error("Failed to create media file record");
    }

    console.log("Created new media file record:", newMediaFile.id);

    // Register provider state so provider-aware readers resolve this row consistently.
    try {
      await supabase
        .from("media_file_providers")
        .insert({
          media_file_id: newMediaFile.id,
          provider: "cloudinary",
          object_version: 1,
          object_key: publicId,
          status: "ready",
          delivery_url: transcodedUrl,
          mime_type: "video/mp4",
        });
    } catch (providerError) {
      // Non-fatal: reads fall back to file_path (the Cloudinary URL).
      console.warn("Provider row insert failed (non-fatal):", providerError);
    }

    const response: TranscodeResponse = {
      success: true,
      transcoded_url: transcodedUrl,
      new_media_file_id: newMediaFile.id,
    };

    return jsonResponse(response);

  } catch (error) {
    console.error("Transcode error:", error);
    const response: TranscodeResponse = {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    return errorResponse(response.error || "Unknown error");
  }
});
