/**
 * Gallery Saver Plugin
 * Save videos and images directly to Android gallery
 */

import { registerPlugin } from '@capacitor/core';

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
      // Try to trigger download via link
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

export default GallerySaver;
