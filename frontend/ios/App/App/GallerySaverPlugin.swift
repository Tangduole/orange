import Foundation
import Capacitor
import Photos
import UIKit

@objc(GallerySaverPlugin)
public class GallerySaverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GallerySaverPlugin"
    public let jsName = "GallerySaver"
    
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveAudio", returnType: CAPPluginReturnPromise),
    ]
    
    private let albumName = "Orange"
    
    @objc func saveVideo(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        let filename = call.getString("filename") ?? "video_\(Int(Date().timeIntervalSince1970)).mp4"
        
        saveMedia(urlString: urlString, filename: filename, mediaType: .video, call: call)
    }
    
    @objc func saveImage(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        let filename = call.getString("filename") ?? "image_\(Int(Date().timeIntervalSince1970)).jpg"
        
        saveMedia(urlString: urlString, filename: filename, mediaType: .image, call: call)
    }
    
    @objc func saveAudio(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        let filename = call.getString("filename") ?? "audio_\(Int(Date().timeIntervalSince1970)).mp3"
        
        saveMedia(urlString: urlString, filename: filename, mediaType: .audio, call: call)
    }
    
    private enum MediaType {
        case video, image, audio
    }
    
    private func saveMedia(urlString: String, filename: String, mediaType: MediaType, call: CAPPluginCall) {
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }
        
        // Request photo library permission
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    call.reject("Photo library permission denied")
                }
                return
            }
            
            // Download file to temp directory
            let task = URLSession.shared.downloadTask(with: url) { tempURL, response, error in
                if let error = error {
                    DispatchQueue.main.async {
                        call.reject("Download failed: \(error.localizedDescription)")
                    }
                    return
                }
                
                guard let tempURL = tempURL else {
                    DispatchQueue.main.async {
                        call.reject("Download failed: no file")
                    }
                    return
                }
                
                // Save to Photos
                PHPhotoLibrary.shared().performChanges({
                    let request: PHAssetChangeRequest
                    switch mediaType {
                    case .video:
                        request = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: tempURL)!
                    case .image:
                        request = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: tempURL)!
                    case .audio:
                        // iOS doesn't support saving audio to Photos, save to Files instead
                        request = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: tempURL)!
                    }
                }) { success, error in
                    DispatchQueue.main.async {
                        if success {
                            call.resolve(["success": true])
                        } else {
                            call.reject("Save failed: \(error?.localizedDescription ?? "unknown error")")
                        }
                    }
                }
            }
            task.resume()
        }
    }
}
