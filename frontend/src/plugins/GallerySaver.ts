/**
 * Gallery Saver Plugin
 * Save videos and images directly to Android gallery
 */

import { registerPlugin, Plugin } from '@capacitor/core';

export interface SaveOptions {
  url: string;
  filename?: string;
  albumName?: string;
}

export interface SaveResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface GallerySaverPlugin {
  saveVideo(options: SaveOptions): Promise<SaveResult>;
  saveImage(options: SaveOptions): Promise<SaveResult>;
  saveAudio(options: SaveOptions): Promise<SaveResult>;
}

// Register the native plugin
const { GallerySaver } = registerPlugin<GallerySaverPlugin>('GallerySaver', {
  web: {
    // Web fallback implementation
    saveVideo: async (options: SaveOptions): Promise<SaveResult> => {
      console.log('[GallerySaver-web] saveVideo called, but running on web - using fallback');
      const a = document.createElement('a');
      a.href = options.url;
      a.download = options.filename || 'video.mp4';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return { success: true };
    },
    saveImage: async (options: SaveOptions): Promise<SaveResult> => {
      console.log('[GallerySaver-web] saveImage called, but running on web - using fallback');
      const a = document.createElement('a');
      a.href = options.url;
      a.download = options.filename || 'image.jpg';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return { success: true };
    },
    saveAudio: async (options: SaveOptions): Promise<SaveResult> => {
      console.log('[GallerySaver-web] saveAudio called, but running on web - using fallback');
      const a = document.createElement('a');
      a.href = options.url;
      a.download = options.filename || 'audio.mp3';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return { success: true };
    }
  }
});

// Debug: Log when plugin is loaded
console.log('[GallerySaver] Plugin loaded, methods:', {
  saveVideo: typeof GallerySaver?.saveVideo,
  saveImage: typeof GallerySaver?.saveImage,
  saveAudio: typeof GallerySaver?.saveAudio
});

export default GallerySaver;
