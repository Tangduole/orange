import { Plugin, PluginResult } from '@capacitor/core';

export interface SaveOptions {
  url: string;
  filename?: string;
  albumName?: string;
  mediaType?: 'video' | 'image';
}

export interface SaveResult {
  success: boolean;
  path?: string;
  error?: string;
}

const { registerPlugin } = require('@capacitor/core');

export interface GallerySaverPlugin {
  saveVideo(options: SaveOptions): Promise<SaveResult>;
  saveImage(options: SaveOptions): Promise<SaveResult>;
}

class GallerySaverPluginImpl extends Plugin {
  async saveVideo(options: SaveOptions): Promise<SaveResult> {
    return this.saveMedia({ ...options, mediaType: 'video' });
  }

  async saveImage(options: SaveOptions): Promise<SaveResult> {
    return this.saveMedia({ ...options, mediaType: 'image' });
  }

  private async saveMedia(options: SaveOptions): Promise<SaveResult> {
    try {
      const result: PluginResult = await this.load();

      // 使用原生方法
      const ret = await this.callNative('saveMedia', {
        url: options.url,
        filename: options.filename || 'video_' + Date.now(),
        mediaType: options.mediaType || 'video'
      });

      return { success: true, path: ret.path };
    } catch (e: any) {
      return { success: false, error: e.message || 'Unknown error' };
    }
  }
}

export const GallerySaver = registerPlugin<GallerySaverPlugin>('GallerySaver', {
  web: {
    saveVideo: async (options: SaveOptions): Promise<SaveResult> => {
      // Web fallback - open URL
      window.open(options.url, '_blank');
      return { success: true };
    },
    saveImage: async (options: SaveOptions): Promise<SaveResult> => {
      window.open(options.url, '_blank');
      return { success: true };
    }
  }
});

export { GallerySaverPluginImpl };
