package com.orange.gallerysaver;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
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

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class GallerySaverPlugin extends Plugin {
    private static final String TAG = "GallerySaverPlugin";
    private static final String ALBUM_NAME = "Orange Downloader";

    @PluginMethod
    public void saveMedia(PluginCall call) {
        String urlStr = call.getString("url");
        String filename = call.getString("filename", "video_" + System.currentTimeMillis() + ".mp4");
        String mediaType = call.getString("mediaType", "video");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        // Determine MIME type
        String mimeType;
        if (mediaType.equals("image")) {
            mimeType = getImageMimeType(filename);
            if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
                // Keep as is
            } else {
                filename = filename + ".jpg";
            }
        } else {
            mimeType = "video/mp4";
            if (!filename.endsWith(".mp4")) {
                filename = filename + ".mp4";
            }
        }

        Context context = getContext();

        try {
            // Download file to cache
            File cacheFile = downloadFile(urlStr, filename);
            if (cacheFile == null) {
                call.reject("Failed to download file");
                return;
            }

            // Save to gallery using MediaStore
            String savedPath = saveToGallery(context, cacheFile, mimeType, mediaType);

            // Delete temp file
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
            Log.e(TAG, "Error saving media", e);
            call.reject("Error: " + e.getMessage());
        }
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
        String savedPath = null;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+ use MediaStore
            savedPath = saveWithMediaStore(context, sourceFile, mimeType, mediaType);
        } else {
            // Legacy method for older Android
            savedPath = saveLegacy(context, sourceFile, mimeType, mediaType);
        }

        return savedPath;
    }

    private String saveWithMediaStore(Context context, File sourceFile, String mimeType, String mediaType) {
        ContentValues values = new ContentValues();

        // Determine collection based on media type
        Uri collection;
        if (mediaType.equals("image")) {
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else {
            collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }

        values.put(MediaStore.MediaColumns.DISPLAY_NAME, sourceFile.getName());
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                mediaType.equals("image") ? Environment.DIRECTORY_PICTURES + "/" + ALBUM_NAME
                                         : Environment.DIRECTORY_MOVIES + "/" + ALBUM_NAME);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        }

        ContentResolver resolver = context.getContentResolver();
        Uri itemUri = resolver.insert(collection, values);

        if (itemUri == null) {
            Log.e(TAG, "Failed to create MediaStore entry");
            return null;
        }

        try {
            // Write file content
            try (InputStream input = new java.io.FileInputStream(sourceFile);
                 java.io.OutputStream output = resolver.openOutputStream(itemUri)) {

                if (output == null) {
                    Log.e(TAG, "Failed to open output stream");
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
                // Clear pending flag
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(itemUri, values, null, null);
            }

            Log.d(TAG, "Saved to gallery: " + itemUri.toString());
            return itemUri.toString();

        } catch (IOException e) {
            Log.e(TAG, "Failed to write file", e);
            resolver.delete(itemUri, null, null);
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private String saveLegacy(Context context, File sourceFile, String mimeType, String mediaType) {
        File picturesDir;

        if (mediaType.equals("image")) {
            picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
        } else {
            picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES);
        }

        File albumDir = new File(picturesDir, ALBUM_NAME);
        if (!albumDir.exists() && !albumDir.mkdirs()) {
            Log.e(TAG, "Failed to create album directory");
            return null;
        }

        File destFile = new File(albumDir, sourceFile.getName());

        try {
            // Copy file
            java.io.FileInputStream input = new java.io.FileInputStream(sourceFile);
            java.io.FileOutputStream output = new java.io.FileOutputStream(destFile);

            byte[] buffer = new byte[8192];
            int len;
            while ((len = input.read(buffer)) > 0) {
                output.write(buffer, 0, len);
            }

            input.close();
            output.close();

            // Notify media scanner
            android.media.MediaScannerConnection.scanFile(
                context,
                new String[]{destFile.getAbsolutePath()},
                new String[]{mimeType},
                null
            );

            return destFile.getAbsolutePath();

        } catch (IOException e) {
            Log.e(TAG, "Failed to save legacy", e);
            return null;
        }
    }

    private String getImageMimeType(String filename) {
        if (filename.endsWith(".png")) return "image/png";
        if (filename.endsWith(".gif")) return "image/gif";
        if (filename.endsWith(".webp")) return "image/webp";
        return "image/jpeg";
    }
}
