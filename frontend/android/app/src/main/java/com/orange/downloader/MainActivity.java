package com.orange.downloader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Register Gallery Saver Plugin
        registerPlugin(GallerySaverPlugin.class);
    }
}
