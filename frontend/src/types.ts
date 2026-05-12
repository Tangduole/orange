// Shared types for Orange Downloader

export interface Task {
  taskId: string; status: string; progress: number;
  title?: string; platform?: string; thumbnailUrl?: string;
  downloadUrl?: string; asrText?: string; copyText?: string;
  coverUrl?: string; isNote?: boolean;
  imageFiles?: Array<{ filename: string; url: string }>;
  subtitleFiles?: Array<{ filename: string; url: string }>;
  error?: string; createdAt: string | number;
  quality?: string; height?: number;
  directLink?: boolean; audioUrl?: string;
  downloadedBytes?: number; totalBytes?: number;
}

export interface HistoryItem {
  taskId: string; status: string; title?: string;
  platform?: string; thumbnailUrl?: string; createdAt: string | number;
  url?: string;
}

export interface QualityOption {
  qualityLabel?: string; quality: string; format: string;
  width: number; height: number; hasVideo: boolean; hasAudio: boolean;
  size?: number; sizeEstimated?: boolean;
}

export interface AutoQuality {
  label: string; height: number;
}

export interface BatchItem {
  url: string; status: string; progress?: number;
}

export interface AuthUser {
  id: string; email: string; tier: string;
  subscriptionStatus?: string; subscriptionEndsAt?: string;
  usage?: { downloads_today: number };
}
