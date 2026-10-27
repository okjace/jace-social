import AVFoundation
import Foundation
import WebRTC

/// WebRTC for calls and voice channels: one factory for the app, microphone and camera tracks, and
/// descriptions sent whole once ICE gathering is done (no trickle), like the website and the main app
/// (ios/JaceSocial/Rtc.swift, with callbacks instead of async/await).
enum Rtc {
    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    static func config(_ ice: [[String: Any]]) -> RTCConfiguration {
        let c = RTCConfiguration()
        c.iceServers = ice.compactMap { s in
            let urls = (s["urls"] as? [String]) ?? ((s["urls"] as? String).map { [$0] } ?? [])
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: s["username"] as? String, credential: s["credential"] as? String)
        }
        c.sdpSemantics = .unifiedPlan
        return c
    }

    static func constraints() -> RTCMediaConstraints { RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil) }

    /// The microphone (iOS does echo cancelling in voice chat mode).
    static func mic() -> RTCAudioTrack {
        factory.audioTrack(with: factory.audioSource(with: constraints()), trackId: "mic-\(UUID().uuidString)")
    }

    /// Ask for the microphone (once), then go on, on the main thread.
    static func micAllowed(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
    }

    /// Call sound: voice chat mode, on the speaker when asked.
    static func audioOn(speaker: Bool) {
        let s = RTCAudioSession.sharedInstance()
        s.lockForConfiguration()
        try? s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
        try? s.setActive(true)
        try? s.overrideOutputAudioPort(speaker ? .speaker : .none)
        s.unlockForConfiguration()
    }
    static func setSpeaker(_ on: Bool) {
        let s = RTCAudioSession.sharedInstance()
        s.lockForConfiguration()
        try? s.overrideOutputAudioPort(on ? .speaker : .none)
        s.unlockForConfiguration()
    }
    static func audioOff() {
        let s = RTCAudioSession.sharedInstance()
        s.lockForConfiguration()
        try? s.setActive(false)
        s.unlockForConfiguration()
    }

    /// Your camera being sent: its track, the id of its stream (the receiver tells camera and screen
    /// apart by it), and how to stop it.
    final class Camera {
        let track: RTCVideoTrack
        let streamId = "s-\(UUID().uuidString.prefix(12))"
        private let capturer: RTCCameraVideoCapturer

        init?(front: Bool = true) {
            let devices = RTCCameraVideoCapturer.captureDevices()
            guard let device = devices.first(where: { $0.position == (front ? .front : .back) }) ?? devices.first else { return nil }
            let source = Rtc.factory.videoSource()
            capturer = RTCCameraVideoCapturer(delegate: source)
            // the format closest to 640x360 (light enough for older phones)
            let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
            func distance(_ f: AVCaptureDevice.Format) -> Int {
                let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                return abs(Int(d.width) - 640) + abs(Int(d.height) - 360)
            }
            guard let format = formats.min(by: { distance($0) < distance($1) }) else { return nil }
            let fps = min(20, Int(format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 20))
            capturer.startCapture(with: device, format: format, fps: fps)
            track = Rtc.factory.videoTrack(with: source, trackId: "video-\(UUID().uuidString)")
        }

        func stop() { capturer.stopCapture() }
    }
}

extension RTCPeerConnection {
    func setRemote(_ type: RTCSdpType, _ sdp: String, _ done: @escaping (Error?) -> Void) {
        setRemoteDescription(RTCSessionDescription(type: type, sdp: sdp)) { e in DispatchQueue.main.async { done(e) } }
    }
    func rollback(_ done: @escaping (Error?) -> Void) {
        setLocalDescription(RTCSessionDescription(type: .rollback, sdp: "")) { e in DispatchQueue.main.async { done(e) } }
    }

    /// Make an offer or answer, set it, wait (up to 5 s) for every ICE candidate, then the full description.
    func describe(offer: Bool, _ done: @escaping (String?) -> Void) {
        let made: (RTCSessionDescription?, Error?) -> Void = { d, _ in
            guard let d = d else { DispatchQueue.main.async { done(nil) }; return }
            self.setLocalDescription(d) { e in
                DispatchQueue.main.async {
                    if e != nil { done(nil); return }
                    var waited = 0
                    func check() {
                        if self.iceGatheringState == .complete || waited >= 100 { done(self.localDescription?.sdp); return }
                        waited += 1
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: check)
                    }
                    check()
                }
            }
        }
        if offer { self.offer(for: Rtc.constraints(), completionHandler: made) } else { answer(for: Rtc.constraints(), completionHandler: made) }
    }
}

/// Camera and screen both arrive as video, so each description says which stream is which in one
/// extra line (server/lib/media.ts). Also "a=x-jace-move" (a call moving to another device) and
/// "a=x-jace-noyield" (from Jace Launcher, which can't take back an offer).
enum Sdp {
    static let tagLine = "a=x-jace-streams:"

    struct Read { var sdp = ""; var camera: String?; var screen: String?; var moving = false; var noYield = false }

    static func tag(_ sdp: String, camera: String?) -> String {
        guard let c = camera else { return sdp }
        var s = sdp
        while s.hasSuffix("\n") || s.hasSuffix("\r") { s.removeLast() }
        return s + "\r\n" + tagLine + "camera=\(c)\r\n"
    }

    static func read(_ sdp: String) -> Read {
        var r = Read()
        let lines = sdp.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }.filter { line in
            if line == "a=x-jace-move" { r.moving = true; return false }
            if line == "a=x-jace-noyield" { r.noYield = true; return false }
            if line.hasPrefix(tagLine) {
                for part in line.dropFirst(tagLine.count).split(separator: ",") {
                    let kv = part.split(separator: "=", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
                    guard kv.count == 2, !kv[1].isEmpty else { continue }
                    if kv[0] == "camera" { r.camera = kv[1] }
                    if kv[0] == "screen" { r.screen = kv[1] }
                }
                return false
            }
            return !line.hasPrefix("a=x-jace-")
        }
        r.sdp = lines.joined(separator: "\r\n")
        return r
    }
}
