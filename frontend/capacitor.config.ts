import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.orange.downloader',
  appName: 'Orange Downloader',
  webDir: 'dist',
  plugins: {
    GallerySaver: {},
  },
};

export default config;
