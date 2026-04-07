import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.orange.downloader',
  appName: 'Orange Downloader',
  webDir: 'dist',
  plugins: {
    GallerySaver: {},
    LocalNotifications: {
      smallIcon: 'ic_notification',
      iconColor: '#FF6B35',
      sound: 'beep.wav',
    },
  },
};

export default config;
