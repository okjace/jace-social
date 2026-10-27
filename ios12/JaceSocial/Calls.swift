import AudioToolbox
import Foundation
import WebRTC

struct CallInfo {
    var state = "idle"              // idle | calling | ringing | in-call
    var peer = ""
    var peerName = ""
    var muted = false
    var speaker = false
    var noMic = false
    var startedAt: Date?
    var camera: RTCVideoTrack?
    var remoteCamera: RTCVideoTrack?
    var remoteScreen: RTCVideoTrack?
}

/// Calls with a friend: the same signalling as the website and the main app (POST /calls offer /
/// answer / hangup / renegotiate / reanswer, live "call" events), audio plus your camera added
/// mid-call, and their camera and screen shown. Everything runs on the main thread.
final class Calls: NSObject {
    static let changed = Notification.Name("JaceCallChanged")
    private(set) var info = CallInfo() { didSet { NotificationCenter.default.post(name: Calls.changed, object: nil) } }
    var onEnded: (String) -> Void = { _ in }
    var onIncoming: (String) -> Void = { _ in }
    private var api: Api { Session.shared.api }
    private var callId = ""
    private var offerSdp = ""
    private var pc: RTCPeerConnection?
    private var mic: RTCAudioTrack?
    private var cam: Rtc.Camera?
    private var camSender: RTCRtpSender?
    private var remoteCameraId: String?
    private var making = false
    private var pending = false
    private var callerSide = false
    private var timeout: Timer?
    private var ring: Ringer?

    func call(_ uuid: String, name: String) {
        guard info.state == "idle" else { onEnded("You're already in a call"); return }
        let id = Calls.newCallId()
        callId = id
        callerSide = true
        info = CallInfo(state: "calling", peer: uuid, peerName: name)
        ring = Ringer(incoming: false)
        newPeer(id) { [weak self] pc in
            guard let self = self, let pc = pc else { return }
            pc.describe(offer: true) { sdp in
                guard self.callId == id else { return }
                guard let sdp = sdp else { self.end("Couldn't start the call"); return }
                self.api.callSignal(to: uuid, callId: id, kind: "offer", sdp: sdp) { e in
                    if let e = e, self.callId == id { self.end(e.message) } else { self.startTimeout() }
                }
            }
        }
    }

    func answer() {
        guard info.state == "ringing" else { return }
        let peer = info.peer, id = callId
        stopRing()
        timeout?.invalidate()
        info.state = "in-call"
        info.startedAt = Date()
        newPeer(id) { [weak self] pc in
            guard let self = self, let pc = pc else { return }
            let r = Sdp.read(self.offerSdp)
            self.remoteCameraId = r.camera
            pc.setRemote(.offer, r.sdp) { e in
                if e != nil { self.hangUp("Couldn't connect the call"); return }
                pc.describe(offer: false) { sdp in
                    guard self.callId == id else { return }
                    guard let sdp = sdp else { self.hangUp("Couldn't connect the call"); return }
                    self.api.callSignal(to: peer, callId: id, kind: "answer", sdp: sdp)
                }
            }
        }
    }

    func hangUp(_ reason: String = "") {
        guard info.state != "idle" else { return }
        api.callSignal(to: info.peer, callId: callId, kind: "hangup")
        end(reason)
    }

    func toggleMute() {
        info.muted.toggle()
        mic?.isEnabled = !info.muted
    }

    func toggleSpeaker() {
        info.speaker.toggle()
        Rtc.setSpeaker(info.speaker)
    }

    /// Turn your camera on or off (adds or removes a video track, then renegotiates).
    func toggleCamera() {
        guard let pc = pc, info.state == "in-call" else { return }
        if let c = cam {
            if let s = camSender { pc.removeTrack(s) }
            c.stop(); cam = nil; camSender = nil
            info.camera = nil
        } else {
            guard let c = Rtc.Camera() else { onEnded("Couldn't turn on your camera - check that it's allowed in Settings"); return }
            cam = c
            camSender = pc.add(c.track, streamIds: [c.streamId])
            info.camera = c.track
            info.speaker = true
            Rtc.setSpeaker(true)
        }
        renegotiate()
    }

    private func renegotiate() {
        guard let pc = pc else { return }
        if making || pc.signalingState != .stable { pending = true; return }
        making = true
        pc.describe(offer: true) { [weak self] sdp in
            guard let self = self else { return }
            self.making = false
            guard let sdp = sdp else { return }
            self.api.callSignal(to: self.info.peer, callId: self.callId, kind: "renegotiate", sdp: Sdp.tag(sdp, camera: self.cam?.streamId))
        }
    }

    /// A live "call" event: {id, kind, call_id, from, name}.
    func onSignal(_ e: LiveEvent) {
        guard let kind = e.str("kind"), let sid = (e.payload["id"] as? NSNumber)?.intValue else { return }
        let eventCall = e.str("call_id") ?? ""
        let i = info
        if kind == "offer" {
            api.readCallSignal(sid) { [weak self] r in
                guard let self = self, case .success(let signal) = r, let sdp = signal.sdp, let sender = signal.sender else { return }   // expired
                if Sdp.read(sdp).moving { return }        // someone else's call moving between devices
                if self.info.state == "in-call" && eventCall == self.callId && sender == self.info.peer { self.replace(sdp); return }
                if self.info.state != "idle" { self.api.callSignal(to: sender, callId: eventCall, kind: "hangup"); return }   // busy
                self.callId = eventCall
                self.offerSdp = sdp
                let name = (signal.name?.isEmpty == false ? signal.name : e.str("name")) ?? "A friend"
                self.info = CallInfo(state: "ringing", peer: sender, peerName: name)
                self.ring = Ringer(incoming: true)
                self.startTimeout()
                self.onIncoming(name)
            }
            return
        }
        guard eventCall == callId else { return }
        switch kind {
        case "answer" where i.state == "calling":
            stopRing(); timeout?.invalidate()
            info.state = "in-call"; info.startedAt = Date()
            api.readCallSignal(sid) { [weak self] r in
                guard let self = self, case .success(let s) = r else { return }
                let read = Sdp.read(s.sdp ?? "")
                self.remoteCameraId = read.camera
                self.pc?.setRemote(.answer, read.sdp) { e in if e != nil { self.hangUp("Couldn't connect the call") } }
            }
        case "renegotiate":
            api.readCallSignal(sid) { [weak self] r in
                guard let self = self, let pc = self.pc, case .success(let s) = r else { return }
                let read = Sdp.read(s.sdp ?? "")
                let go = {
                    self.remoteCameraId = read.camera
                    pc.setRemote(.offer, read.sdp) { e in
                        guard e == nil else { return }
                        if read.camera == nil { self.info.remoteCamera = nil }
                        if read.screen == nil { self.info.remoteScreen = nil }
                        pc.describe(offer: false) { sdp in
                            guard let sdp = sdp else { return }
                            self.api.callSignal(to: self.info.peer, callId: self.callId, kind: "reanswer", sdp: Sdp.tag(sdp, camera: self.cam?.streamId))
                            if self.pending {
                                self.pending = false
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.renegotiate() }
                            }
                        }
                    }
                }
                if pc.signalingState != .stable || self.making {
                    // both changed something at once: the caller keeps its offer, the one who answered gives way
                    if self.info.state == "in-call" && self.callerSide && !read.noYield { return }
                    self.pending = true
                    if pc.signalingState == .haveLocalOffer { pc.rollback { _ in go() }; return }
                }
                go()
            }
        case "reanswer":
            guard pc?.signalingState == .haveLocalOffer else { return }
            api.readCallSignal(sid) { [weak self] r in
                guard let self = self, case .success(let s) = r else { return }
                self.pc?.setRemote(.answer, s.sdp ?? "") { _ in
                    if self.pending { self.pending = false; self.renegotiate() }
                }
            }
        case "answer" where i.state == "in-call":
            end("Moved the call to another device")
        case "hangup":
            end(i.state == "in-call" ? "\(i.peerName) hung up" : i.state == "calling" ? "\(i.peerName) didn't pick up" : "")
        default: break
        }
    }

    /// Their side moved the call to another device: answer it on a new connection, keeping our camera.
    private func replace(_ offer: String) {
        let id = callId
        let old = pc
        let r = Sdp.read(offer)
        remoteCameraId = r.camera
        making = false; pending = false; callerSide = false
        info.remoteCamera = nil; info.remoteScreen = nil
        newPeer(id) { [weak self] pc in
            guard let self = self, let pc = pc else { return }
            old?.close()
            pc.setRemote(.offer, r.sdp) { e in
                guard e == nil else { self.hangUp("Couldn't connect the call"); return }
                if let c = self.cam { self.camSender = pc.add(c.track, streamIds: [c.streamId]) }
                pc.describe(offer: false) { sdp in
                    guard self.callId == id, let sdp = sdp else { return }
                    self.api.callSignal(to: self.info.peer, callId: id, kind: "answer", sdp: Sdp.tag(sdp, camera: self.cam?.streamId))
                }
            }
        }
    }

    private func newPeer(_ id: String, _ done: @escaping (RTCPeerConnection?) -> Void) {
        api.ice { [weak self] r in
            guard let self = self, self.callId == id else { done(nil); return }
            guard case .success(let ice) = r else { self.end("Couldn't start the call - check your internet connection"); done(nil); return }
            Rtc.audioOn(speaker: self.info.speaker)
            guard let pc = Rtc.factory.peerConnection(with: Rtc.config(ice), constraints: Rtc.constraints(), delegate: self) else {
                self.end("Couldn't start the call"); done(nil); return
            }
            self.pc = pc
            Rtc.micAllowed { allowed in
                if allowed {
                    let m = self.mic ?? Rtc.mic()
                    self.mic = m
                    m.isEnabled = !self.info.muted
                    pc.add(m, streamIds: ["mic"])
                } else {
                    let recv = RTCRtpTransceiverInit()
                    recv.direction = .recvOnly
                    pc.addTransceiver(of: .audio, init: recv)
                }
                self.info.noMic = !allowed
                done(pc)
            }
        }
    }

    private func startTimeout() {
        timeout?.invalidate()
        timeout = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.info.state == "calling" { self.hangUp("No answer") } else if self.info.state == "ringing" { self.end("") }
        }
    }

    private func stopRing() { ring?.stop(); ring = nil }

    private func end(_ reason: String) {
        timeout?.invalidate(); timeout = nil
        stopRing()
        pc?.close(); pc = nil
        mic = nil
        cam?.stop(); cam = nil; camSender = nil
        remoteCameraId = nil
        making = false; pending = false; callerSide = false
        callId = ""; offerSdp = ""
        info = CallInfo()
        Rtc.audioOff()
        if !reason.isEmpty { onEnded(reason) }
    }

    private static func newCallId() -> String {
        var b = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

extension Calls: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        if newState == .failed { DispatchQueue.main.async { if self.pc === peerConnection { self.hangUp("Couldn't connect the call") } } }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track as? RTCVideoTrack else { return }
        let sid = mediaStreams.first?.streamId
        DispatchQueue.main.async {
            if let s = sid, s == self.remoteCameraId { self.info.remoteCamera = track } else { self.info.remoteScreen = track }
        }
    }
}

/// Ringing: the phone's sound for a call coming in, soft beeps while calling out.
final class Ringer {
    private var timer: Timer?
    init(incoming: Bool) {
        let play = { AudioServicesPlaySystemSound(incoming ? 1005 : 1016) }
        play()
        timer = Timer.scheduledTimer(withTimeInterval: incoming ? 2 : 3, repeats: true) { _ in play() }
        if incoming { AudioServicesPlaySystemSound(kSystemSoundID_Vibrate) }
    }
    func stop() { timer?.invalidate(); timer = nil }
}
