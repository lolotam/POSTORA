export interface MediaFile {
  id: string;
  file_path: string;
  file_type: "image" | "video" | "audio" | "document" | "gif" | "raw";
  file_size: number;
  mime_type: string;
  created_at: string;
  storage_bucket: string;
  cloudinary_public_id?: string;
  platforms?: string[];
  social_account_ids?: string[];
  upload_date?: string;
  folder_path?: string;
  publicUrl: string;
  metadata?: Record<string, unknown> | null;
  linked_account_ids?: string[];
  keep_forever?: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  retention_state?: string | null;
  retention_claimed_at?: string | null;
  retention_attempts?: number;
  retention_next_attempt_at?: string | null;
}

export interface MediaFolder {
  id: string;
  name: string;
  parent_path: string;
  full_path: string;
  created_at: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
}

export type ViewMode = "grid" | "list";
export type FilterType = "all" | "image" | "video" | "audio" | "document" | "archive";

export interface DownloadProgress {
  current: number;
  total: number;
}

export interface Breadcrumb {
  name: string;
  path: string;
}
