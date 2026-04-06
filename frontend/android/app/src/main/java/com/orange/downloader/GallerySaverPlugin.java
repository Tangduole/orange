package com.orange.downloader;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "GallerySaver")
public class GallerySaverPlugin extends Plugin {
    private static final String TAG = "GallerySaver";
    private static final String ALBUM_NAME = "Orange";

    @PluginMethod
    public void saveVideo(PluginCall call) {
        String urlStr = call.getString("url");
        String filename = call.getString("filename", "video_" + System.currentTimeMillis() + ".mp4");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        final String finalFilename = filename.endsWith(".mp4") ? filename : filename + ".mp4";
        final String finalUrl = urlStr;
        final Context context = getContext();

        new Thread(() -> {
            try {
                File cacheFile = downloadFile(finalUrl, finalFilename);
                if (cacheFile == null) {
                    call.reject("Failed to download file");
                    return;
                }

                String savedPath = saveToGallery(context, cacheFile, "video/mp4", "video");
                cacheFile.delete();

                if (savedPath != null) {
                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("path", savedPath);
                    call.resolve(result);
                } else {
                    call.reject("Failed to save to gallery");
                }
            } catch (Exception e) {
                Log.e(TAG, "Error saving video", e);
                call.reject("Error: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        String urlStr = call.getString("url");
        String filename = call.getString("filename", "image_" + System.currentTimeMillis());

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        String mimeType = "image/jpeg";
        String finalFilename = filename;
        if (filename.endsWith(".png")) {
            mimeType = "image/png";
        } else if (!filename.endsWith(".jpg") && !filename.endsWith(".jpeg")) {
            finalFilename = filename + ".jpg";
        }

        final String finalUrl = urlStr;
        final String finalMimeType = mimeType;
        final String finalFilename2 = finalFilename;
        final Context context = getContext();

        new Thread(() -> {
            try {
                File cacheFile = downloadFile(finalUrl, finalFilename2);
                if (cacheFile == null) {
                    call.reject("Failed to download file");
                    return;
                }

                String savedPath = saveToGallery(context, cacheFile, finalMimeType, "image");
                cacheFile.delete();

                if (savedPath != null) {
                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("path", savedPath);
                    call.resolve(result);
                } else {
                    call.reject("Failed to save to gallery");
                }
            } catch (Exception e) {
                Log.e(TAG, "Error saving image", e);
                call.reject("Error: " + e.getMessage());
            }
        }).start();
    }

    private File downloadFile(String urlStr, String filename) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(30000);
            conn.setDoInput(true);
            conn.connect();

            File cacheDir = getContext().getCacheDir();
            File outputFile = new File(cacheDir, filename);

            InputStream input = conn.getInputStream();
            FileOutputStream output = new FileOutputStream(outputFile);

            byte[] buffer = new byte[8192];
            int len;
            while ((len = input.read(buffer)) > 0) {
                output.write(buffer, 0, len);
            }

            output.close();
            input.close();
            conn.disconnect();

            return outputFile;
        } catch (IOException e) {
            Log.e(TAG, "Download failed", e);
            return null;
        }
    }

    private String saveToGallery(Context context, File sourceFile, String mimeType, String mediaType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveWithMediaStore(context, sourceFile, mimeType, mediaType);
        } else {
            return saveLegacy(context, sourceFile, mimeType, mediaType);
        }
    }

    private String saveWithMediaStore(Context context, File sourceFile, String mimeType, String mediaType) {
        ContentValues values = new ContentValues();

        Uri collection;
        if (mediaType.equals("image")) {
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else {
            collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }

        values.put(MediaStore.MediaColumns.DISPLAY_NAME, sourceFile.getName());
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (mediaType.equals("image")) {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + ALBUM_NAME);
            } else {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + ALBUM_NAME);
            }
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        }

        ContentResolver resolver = context.getContentResolver();
        Uri itemUri = resolver.insert(collection, values);

        if (itemUri == null) {
            Log.e(TAG, "Failed to create MediaStore entry");
            return null;
        }

        try {
            try (InputStream input = new java.io.FileInputStream(sourceFile);
                 java.io.OutputStream output = resolver.openOutputStream(itemUri)) {

                if (output == null) {
                    resolver.delete(itemUri, null, null);
                    return null;
                }

                byte[] buffer = new byte[8192];
                int len;
                while ((len = input.read(buffer)) > 0) {
                    output.write(buffer, 0, len);
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(itemUri, values, null, null);
            }

            Log.d(TAG, "Saved to gallery: " + itemUri);
            return itemUri.toString();

        } catch (IOException e) {
            Log.e(TAG, "Failed to write file", e);
            resolver.delete(itemUri, null, null);
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private String saveLegacy(Context context, File sourceFile, String mimeType, String mediaType) {
        File dir;

        if (mediaType.equals("image")) {
            dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
        } else {
            dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES);
        }

        File albumDir = new File(dir, ALBUM_NAME);
        if (!albumDir.exists() && !albumDir.mkdirs()) {
            return null;
        }

        File destFile = new File(albumDir, sourceFile.getName());

        try {
            java.io.FileInputStream input = new java.io.FileInputStream(sourceFile);
            java.io.FileOutputStream output = new java.io.FileOutputStream(destFile);

            byte[] buffer = new byte[8192];
            int len;
            while ((len = input.read(buffer)) > 0) {
                output.write(buffer, 0, len);
            }

            input.close();
            output.close();

            android.media.MediaScannerConnection.scanFile(context,
                new String[]{destFile.getAbsolutePath()},
                new String[]{mimeType}, null);

            return destFile.getAbsolutePath();

        } catch (IOException e) {
            Log.e(TAG, "Failed to save legacy", e);
            return null;
        }
    }
}
