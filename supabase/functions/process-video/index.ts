import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { handleCorsOptions, jsonResponse } from "../_shared/cors.ts";
import { MEDIA_QUOTA_CODE, isMediaQuotaMessage, mediaQuotaHumanMessage } from "../_shared/mediaQuotaError.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY")!;
const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET")!;

interface ProcessVideoRequest {
  media_file_id: string;
  user_id: string;
  operation: "crop" | "compress" | "get_metadata";
  debug_mode?: boolean;
  // Crop options (percentages 0-100)
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    // Optional: target resolution to upscale to after cropping
    targetWidth?: number;
    targetHeight?: number;
  };
  // Compress options
  compress?: {
    quality: number; // 1-100
    maxSizeMB?: number;
  };
}

interface ProcessVideoResponse {
  success: boolean;
  processed_url?: string;
  new_media_file_id?: string;
  error?: string;
  error_code?: string;
  // Debug info
  debug?: {
    transformation: string;
    request_id?: string;
    cloudinary_public_id?: string;
    video_metadata?: VideoMetadata;
  };
}

interface VideoMetadata {
  width: number;
  height: number;
  duration?: number;
  format?: string;
  bit_rate?: number;
  frame_rate?: number;
}

// Generate SHA-1 signature for Cloudinary
async function generateSignature(params: Record<string, string | number>, apiSecret: string): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const stringToSign = sortedKeys.map(key => `${key}=${params[key]}`).join("&");
  
  const encoder = new TextEncoder();
  const data = encoder.encode(stringToSign + apiSecret);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Fetch video metadata from Cloudinary
async function getVideoMetadata(publicId: string): Promise<VideoMetadata> {
  console.log("Fetching video metadata for:", publicId);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { public_id: publicId, timestamp };
  const signature = await generateSignature(paramsToSign, CLOUDINARY_API_SECRET);
  
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/video/upload/${publicId}`,
    {
      headers: {
        Authorization: `Basic ${btoa(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`)}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Failed to fetch metadata:", errorText);
    throw new Error(`Failed to fetch video metadata: ${response.status}`);
  }

  const result = await response.json();
  console.log("Video metadata:", { width: result.width, height: result.height, duration: result.duration });
  
  return {
    width: result.width,
    height: result.height,
    duration: result.duration,
    format: result.format,
    bit_rate: result.bit_rate,
    frame_rate: result.frame_rate,
  };
}

// Map Cloudinary error messages to user-friendly messages
function mapCloudinaryError(error: { message?: string; error?: { message?: string } }): { message: string; code: string } {
  const msg = error?.message || error?.error?.message || "Unknown error";
  
  if (msg.includes("Invalid")) {
    if (msg.includes("transformation") || msg.includes("Eager")) {
      return { 
        message: "Invalid crop/compress settings. Please try different values.", 
        code: "INVALID_TRANSFORMATION" 
      };
    }
    return { message: "Invalid request format.", code: "INVALID_REQUEST" };
  }
  
  if (msg.includes("File size too large")) {
    return { message: "Video file is too large. Max 100MB supported.", code: "FILE_TOO_LARGE" };
  }
  
  if (msg.includes("Unsupported") || msg.includes("format")) {
    return { message: "Video format not supported. Try MP4 or MOV.", code: "UNSUPPORTED_FORMAT" };
  }
  
  if (msg.includes("timeout") || msg.includes("Timeout")) {
    return { message: "Processing took too long. Try a shorter video.", code: "TIMEOUT" };
  }
  
  if (msg.includes("quota") || msg.includes("limit")) {
    return { message: "Service limit reached. Please try again later.", code: "QUOTA_EXCEEDED" };
  }

  return { message: msg, code: "PROCESSING_ERROR" };
}

// Process video with Cloudinary transformations using pixel-perfect cropping
async function processVideoWithCloudinary(
  videoUrl: string,
  operation: "crop" | "compress",
  options: ProcessVideoRequest["crop"] | ProcessVideoRequest["compress"],
  videoMetadata?: VideoMetadata
): Promise<{ url: string; publicId: string; transformation: string; requestId?: string }> {
  console.log(`Processing video: ${operation}`, options);

  let transformation: string;
  
  if (operation === "crop" && options && "x" in options) {
    const cropOpts = options as ProcessVideoRequest["crop"];
    const targetWidth = cropOpts?.targetWidth;
    const targetHeight = cropOpts?.targetHeight;

    if (videoMetadata?.width && videoMetadata?.height) {
      // PIXEL-PERFECT CROPPING: Use actual pixel values from metadata
      const srcWidth = videoMetadata.width;
      const srcHeight = videoMetadata.height;
      
      const toPixels = (percent: number, dimension: number) => {
        // Handle both 0-100 and 0-1 inputs
        const fraction = percent > 1.001 ? percent / 100 : percent;
        return Math.round(fraction * dimension);
      };

      const x = toPixels(cropOpts!.x, srcWidth);
      const y = toPixels(cropOpts!.y, srcHeight);
      const w = toPixels(cropOpts!.width, srcWidth);
      const h = toPixels(cropOpts!.height, srcHeight);

      console.log(`Pixel-perfect crop: x=${x}, y=${y}, w=${w}, h=${h} (from ${srcWidth}x${srcHeight})`);
      
      // Build transformation: crop first, then optionally scale to target resolution
      let cropTransform = `c_crop,x_${x},y_${y},w_${w},h_${h}`;
      
      // Add upscaling if target resolution is specified and cropped size is smaller
      if (targetWidth && targetHeight && (w < targetWidth || h < targetHeight)) {
        cropTransform += `/c_scale,w_${targetWidth},h_${targetHeight}`;
        console.log(`Upscaling to target: ${targetWidth}x${targetHeight}`);
      } else if (!targetWidth && !targetHeight) {
        // Auto-upscale for vertical videos if cropped size is below TikTok minimum
        const cropRatio = w / h;
        if (cropRatio < 0.7 && w < 720) { // Vertical video (roughly 9:16)
          const autoTargetW = 720;
          const autoTargetH = Math.round(autoTargetW / cropRatio);
          cropTransform += `/c_scale,w_${autoTargetW},h_${autoTargetH}`;
          console.log(`Auto-upscaling vertical video to: ${autoTargetW}x${autoTargetH}`);
        }
      }
      
      transformation = `${cropTransform}/vc_h264,q_auto:good,f_mp4`;
    } else {
      // Fallback: Use relative cropping if no metadata available
      const toFraction = (value: number) => {
        const fraction = value > 1.001 ? value / 100 : value;
        return Math.min(1, Math.max(0, fraction));
      };

      const x = Number(toFraction(cropOpts!.x).toFixed(4));
      const y = Number(toFraction(cropOpts!.y).toFixed(4));
      const w = Number(toFraction(cropOpts!.width).toFixed(4));
      const h = Number(toFraction(cropOpts!.height).toFixed(4));

      console.log(`Relative crop (fallback): x=${x}, y=${y}, w=${w}, h=${h}`);
      
      let cropTransform = `c_crop,fl_relative,x_${x},y_${y},w_${w},h_${h}`;
      
      // Add target resolution scaling if specified
      if (targetWidth && targetHeight) {
        cropTransform += `/c_scale,w_${targetWidth},h_${targetHeight}`;
        console.log(`Upscaling to target: ${targetWidth}x${targetHeight}`);
      }
      
      transformation = `${cropTransform}/vc_h264,q_auto:good,f_mp4`;
    }
  } else if (operation === "compress" && options && "quality" in options) {
    const compressOpts = options as ProcessVideoRequest["compress"];
    const quality = Math.max(10, Math.min(100, compressOpts!.quality));
    
    const qualityLevel = quality >= 80 ? "best" : quality >= 50 ? "good" : "eco";
    transformation = `vc_h264,q_auto:${qualityLevel},f_mp4`;
    
    if (compressOpts!.maxSizeMB && compressOpts!.maxSizeMB < 50) {
      const bitrate = compressOpts!.maxSizeMB < 10 ? "500k" : compressOpts!.maxSizeMB < 25 ? "1000k" : "2000k";
      transformation = `vc_h264,br_${bitrate},q_auto:${qualityLevel},f_mp4`;
    }
  } else {
    throw new Error("Invalid operation or options");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `postora_${operation}_${timestamp}_${Math.random().toString(36).substring(7)}`;

  const paramsToSign: Record<string, string | number> = {
    public_id: publicId,
    timestamp: timestamp,
    eager: transformation,
    eager_async: "false",
  };

  const signature = await generateSignature(paramsToSign, CLOUDINARY_API_SECRET);

  const formData = new FormData();
  formData.append("file", videoUrl);
  formData.append("public_id", publicId);
  formData.append("timestamp", String(timestamp));
  formData.append("eager", transformation);
  formData.append("eager_async", "false");
  formData.append("api_key", CLOUDINARY_API_KEY);
  formData.append("signature", signature);

  console.log("Cloudinary eager transformation:", transformation);
  console.log("Uploading to Cloudinary with transformation...");

  const uploadResponse = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  const uploadResult = await uploadResponse.json();
  console.log("Cloudinary response status:", uploadResponse.status);

  if (!uploadResponse.ok || uploadResult.error) {
    console.error("Cloudinary error:", uploadResult);
    const { message, code } = mapCloudinaryError(uploadResult);
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    throw error;
  }

  let processedUrl: string;
  
  if (uploadResult.eager && uploadResult.eager.length > 0) {
    processedUrl = uploadResult.eager[0].secure_url;
    console.log("Eager transformation complete:", processedUrl);
  } else {
    processedUrl = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${transformation}/${publicId}.mp4`;
    console.log("Built transformation URL:", processedUrl);
  }

  return {
    url: processedUrl,
    publicId: uploadResult.public_id,
    transformation,
    requestId: uploadResult.request_id || uploadResult.etag,
  };
}

// Log to api_logs table for debug mode
// deno-lint-ignore no-explicit-any
async function logToApiLogs(
  supabaseAdmin: any,
  userId: string,
  endpoint: string,
  requestData: unknown,
  responseData: unknown,
  statusCode: number
) {
  try {
    await supabaseAdmin.from("api_logs").insert({
      user_id: userId,
      endpoint,
      method: "POST",
      request_data: requestData,
      response_data: responseData,
      status_code: statusCode,
    });
  } catch (err) {
    console.error("Failed to log to api_logs:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsOptions();
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let requestBody: ProcessVideoRequest | null = null;
  let orphanPublicId: string | null = null;

  try {
    requestBody = await req.json() as ProcessVideoRequest;
    const { media_file_id, user_id, operation, crop, compress, debug_mode } = requestBody;

    if (!media_file_id || !user_id || !operation) {
      throw new Error("Missing required parameters: media_file_id, user_id, operation");
    }

    if (operation !== "crop" && operation !== "compress" && operation !== "get_metadata") {
      throw new Error("Invalid operation. Must be 'crop', 'compress', or 'get_metadata'");
    }

    // Get original media file
    const { data: originalFile, error: fetchError } = await supabaseAdmin
      .from("media_files")
      .select("*")
      .eq("id", media_file_id)
      .single();

    if (fetchError || !originalFile) {
      throw new Error(`Media file not found: ${fetchError?.message || "Not found"}`);
    }

    // Verify ownership
    if (originalFile.user_id !== user_id) {
      throw new Error("Unauthorized: You don't own this media file");
    }

    console.log("Original file:", {
      id: originalFile.id,
      file_path: originalFile.file_path?.substring(0, 80),
      cloudinary_public_id: originalFile.cloudinary_public_id,
    });

    // Get video URL - prefer Cloudinary URL
    let videoUrl = originalFile.file_path;
    
    if (!videoUrl.includes("cloudinary.com") && originalFile.cloudinary_public_id) {
      videoUrl = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${originalFile.cloudinary_public_id}`;
    }

    // Fetch video metadata for pixel-perfect cropping
    let videoMetadata: VideoMetadata | undefined;
    
    if (originalFile.cloudinary_public_id) {
      try {
        videoMetadata = await getVideoMetadata(originalFile.cloudinary_public_id);
      } catch (metaErr) {
        console.warn("Could not fetch video metadata, falling back to relative cropping:", metaErr);
      }
    }

    // Handle get_metadata operation
    if (operation === "get_metadata") {
      if (!videoMetadata) {
        throw new Error("Could not retrieve video metadata");
      }
      
      return jsonResponse({
        success: true,
        debug: { video_metadata: videoMetadata },
      });
    }

    console.log("Processing video URL:", videoUrl.substring(0, 100));

    // Process video with Cloudinary
    const options = operation === "crop" ? crop : compress;
    const { url: processedUrl, publicId: newPublicId, transformation, requestId } = await processVideoWithCloudinary(
      videoUrl,
      operation,
      options,
      videoMetadata
    );

    // The derived asset exists before the row. A quota refusal must not leave it behind.
    orphanPublicId = newPublicId;
    const { data: newMediaFile, error: insertError } = await supabaseAdmin
      .from("media_files")
      .insert({
        user_id: user_id,
        file_path: processedUrl,
        file_type: "video",
        mime_type: "video/mp4",
        cloudinary_public_id: newPublicId,
        storage_bucket: "cloudinary",
        platforms: originalFile.platforms,
        social_account_ids: originalFile.social_account_ids,
        metadata: {
          source: "processed",
          operation: operation,
          original_file_id: media_file_id,
          transformation: transformation,
          request_id: requestId,
          video_dimensions: videoMetadata ? { width: videoMetadata.width, height: videoMetadata.height } : null,
          ...(operation === "crop" ? { crop_settings: crop } : { compress_settings: compress }),
        },
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to save processed file: ${insertError.message}`);
    }
    orphanPublicId = null;

    console.log("Created new media file:", newMediaFile.id);

    const response: ProcessVideoResponse = {
      success: true,
      processed_url: processedUrl,
      new_media_file_id: newMediaFile.id,
    };

    // Include debug info if requested
    if (debug_mode) {
      response.debug = {
        transformation,
        request_id: requestId,
        cloudinary_public_id: newPublicId,
        video_metadata: videoMetadata,
      };

      // Log to api_logs for debugging
      await logToApiLogs(
        supabaseAdmin,
        user_id,
        "process-video",
        { operation, crop, compress, media_file_id },
        response,
        200
      );
    }

    return jsonResponse(response);
  } catch (error) {
    console.error("Process video error:", error);
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorCode = (error as { code?: string })?.code || "UNKNOWN_ERROR";

    if (isMediaQuotaMessage(errorMessage)) {
      if (orphanPublicId) {
        try { await destroyCloudinary(orphanPublicId, "video"); } catch { console.error("[process-video] quota cleanup failed"); }
      }
      const quotaBody: ProcessVideoResponse = {
        success: false,
        error: mediaQuotaHumanMessage(errorMessage),
        error_code: MEDIA_QUOTA_CODE,
      };
      // Unlike other errors (logged only in debug mode), a quota refusal is always recorded.
      if (requestBody?.user_id) {
        await logToApiLogs(supabaseAdmin, requestBody.user_id, "process-video", requestBody, quotaBody, 429);
      }
      return jsonResponse(quotaBody, 429);
    }

    const errorResponse: ProcessVideoResponse = {
      success: false,
      error: errorMessage,
      error_code: errorCode,
    };

    // Log errors in debug mode
    if (requestBody?.debug_mode && requestBody?.user_id) {
      await logToApiLogs(
        supabaseAdmin,
        requestBody.user_id,
        "process-video",
        requestBody,
        errorResponse,
        500
      );
    }

    return jsonResponse(errorResponse, 500);
  }
});
