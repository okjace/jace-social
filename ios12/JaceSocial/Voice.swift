import Foundation
import WebRTC

struct RoomState {
    var channelId: String?
    var channelName = ""
    var participants: [Participant] = []
    var muted = false
    var deafened = false
    var noMic = false
    var connecting = false
    var camera = false
    var canVideo = true
    var speaker = true
    /// who has their camera on / is sharing their screen (you included): uuid -> video
    var cameras: [String: RTCVideoTrack] = [:]
    var screens: [String: RTCVideoTrack] = [:]
}

/// Voice channels (and calls in group chats): everyone connects to everyone (a mesh, fine up to ~8
/// people). The one who joins starts the connections. If two people change something at once, the
/// smaller id gives way. Like the main app's Voice.swift (server/lib/voice.ts), with callbacks.
final class Voice: NSObject {
    static let changed = Notification.Name("JaceVoiceChanged")

    private final class Peer {
        let uuid: String
        var pc: RTCPeerConnection!
        var audio: RTCAudioTrack?
        var cameraSender: RTCRtpSender?
        var camera: String?             // which of their streams is the camera
        var making = false
        var pending = false
        init(uuid: String) { self.uuid = uuid }
    }

    private(set) var state = RoomState() { didSet { NotificationCenter.default.post(name: Voice.changed, object: nil) } }
    var onError: (String) -> Void = { _ in }
    private var api: Api { Session.shared.api }
    private var me = ""
    private var peers: [String: Peer] = [:]
    private var mic: RTCAudioTrack?
    private var cam: Rtc.Camera?
    private var ice: [[String: Any]] = []
    private var beat: Timer?

    func join(channel: String, name: String) {
        if state.channelId == channel { return }
        if state.channelId != nil { leave() }
        me = Session.shared.me?.uuid ?? ""
        state = RoomState(channelId: channel, channelName: name, connecting: true)
        api.ice { [weak self] r in
            guard let self = self, self.state.channelId == channel else { return }
            guard case .success(let ice) = r else { self.failed("Couldn't join - check your internet connection"); return }
            self.ice = ice
            self.api.voiceJoin(channel) { r in
                guard self.state.channelId == channel else { return }
                switch r {
                case .failure(let e): self.failed(e.message)
                case .success(let room):
                    Rtc.audioOn(speaker: true)
                    Rtc.micAllowed { allowed in
                        guard self.state.channelId == channel else { return }
                        if allowed {
                            let m = Rtc.mic()
                            m.isEnabled = room.can_speak != false
                            self.mic = m
                        }
                        let people = room.participants ?? []
                        self.state.participants = people
                        self.state.muted = room.can_speak == false
                        self.state.connecting = false
                        self.state.canVideo = room.can_stream != false
                        self.state.noMic = self.mic == nil
                        // the one who joins connects to everyone already here
                        for p in people where p.uuid != self.me { self.connect(p.uuid) }
                        self.beat = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.sendState([:]) }
                    }
                }
            }
        }
    }

    private func failed(_ message: String) {
        onError(message)
        leave()
    }

    func leave() {
        let id = state.channelId
        beat?.invalidate(); beat = nil
        for uuid in Array(peers.keys) { drop(uuid) }
        mic = nil
        cam?.stop(); cam = nil
        state = RoomState()
        Rtc.audioOff()
        if let id = id { api.voiceLeave(id) }
    }

    func toggleMute() {
        state.muted.toggle()
        mic?.isEnabled = !state.muted && !state.deafened
        sendState(["muted": state.muted])
    }

    func toggleDeafen() {
        state.deafened.toggle()
        for p in peers.values { p.audio?.isEnabled = !state.deafened }
        mic?.isEnabled = !state.deafened && !state.muted
        sendState(["deafened": state.deafened])
    }

    func toggleSpeaker() {
        state.speaker.toggle()
        Rtc.setSpeaker(state.speaker)
    }

    /// Turn your camera on or off for everyone in the room.
    func toggleCamera() {
        guard state.channelId != nil else { return }
        if let c = cam {
            for (uuid, p) in peers {
                if let s = p.cameraSender { p.pc.removeTrack(s) }
                p.cameraSender = nil
                renegotiate(uuid)
            }
            c.stop(); cam = nil
            state.camera = false
            state.cameras[me] = nil
            return
        }
        guard let c = Rtc.Camera() else { onError("Couldn't turn on your camera - check that it's allowed in Settings"); return }
        cam = c
        state.camera = true
        state.cameras[me] = c.track
        for (uuid, p) in peers {
            p.cameraSender = p.pc.add(c.track, streamIds: [c.streamId])
            renegotiate(uuid)
        }
    }

    /// Live "voice" event: who's in the room changed.
    func refresh() {
        guard let id = state.channelId else { return }
        api.voiceRoom(id) { [weak self] r in
            guard let self = self, self.state.channelId == id, case .success(let people) = r else { return }
            if !people.contains(where: { $0.uuid == self.me }) { self.leave(); return }      // kicked or timed out
            for uuid in Array(self.peers.keys) where !people.contains(where: { $0.uuid == uuid }) { self.drop(uuid) }
            self.state.participants = people
        }
    }

    /// Live "voice_signal" event: an offer or answer from someone in the room.
    func onSignal(_ e: LiveEvent) {
        guard let channel = state.channelId, e.str("channel_id") == channel, let from = e.str("from"),
              let sid = (e.payload["id"] as? NSNumber)?.intValue else { return }
        api.readVoiceSignal(sid) { [weak self] r in
            guard let self = self, self.state.channelId == channel, case .success(let signal) = r else { return }
            let read = Sdp.read(signal.sdp ?? "")
            if signal.kind == "offer" {
                let isNew = self.peers[from] == nil
                guard let peer = self.peers[from] ?? self.newPeer(from), let pc = peer.pc else { return }
                let go = {
                    peer.camera = read.camera
                    pc.setRemote(.offer, read.sdp) { e in
                        guard e == nil else { return }
                        if read.camera == nil { self.state.cameras[from] = nil }
                        if read.screen == nil { self.state.screens[from] = nil }
                        pc.describe(offer: false) { sdp in
                            guard let sdp = sdp, self.state.channelId == channel else { return }
                            self.api.voiceSignal(channel, to: from, kind: "answer", sdp: Sdp.tag(sdp, camera: self.cam?.streamId))
                            // they joined while our camera was on, or our own change gave way: offer ours now
                            if (isNew && self.cam != nil) || peer.pending {
                                peer.pending = false
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.renegotiate(from) }
                            }
                        }
                    }
                }
                if pc.signalingState != .stable || peer.making {
                    // both changed something at once: the bigger id keeps its offer, the smaller one gives way
                    if self.me > from && !read.noYield { return }
                    peer.pending = true
                    if pc.signalingState == .haveLocalOffer { pc.rollback { _ in go() }; return }
                }
                go()
            } else if let peer = self.peers[from], peer.pc.signalingState == .haveLocalOffer {
                if read.camera != nil { peer.camera = read.camera }
                peer.pc.setRemote(.answer, read.sdp) { _ in
                    if peer.pending { peer.pending = false; self.renegotiate(from) }
                }
            }
        }
    }

    // -- inside

    private func newPeer(_ uuid: String) -> Peer? {
        let peer = Peer(uuid: uuid)
        guard let pc = Rtc.factory.peerConnection(with: Rtc.config(ice), constraints: Rtc.constraints(), delegate: self) else { return nil }
        peer.pc = pc
        if let m = mic { pc.add(m, streamIds: ["mic"]) } else {
            let recv = RTCRtpTransceiverInit()
            recv.direction = .recvOnly
            pc.addTransceiver(of: .audio, init: recv)
        }
        if let c = cam { peer.cameraSender = pc.add(c.track, streamIds: [c.streamId]) }
        peers[uuid] = peer
        return peer
    }

    private func connect(_ uuid: String) {
        guard peers[uuid] == nil, newPeer(uuid) != nil else { return }
        renegotiate(uuid)
    }

    /// Send our current camera / mic setup to one person. One change at a time.
    private func renegotiate(_ uuid: String) {
        guard let peer = peers[uuid], let channel = state.channelId else { return }
        if peer.making || peer.pc.signalingState != .stable { peer.pending = true; return }
        peer.making = true
        peer.pc.describe(offer: true) { [weak self] sdp in
            peer.making = false
            guard let self = self, let sdp = sdp, self.state.channelId == channel else { return }
            self.api.voiceSignal(channel, to: uuid, kind: "offer", sdp: Sdp.tag(sdp, camera: self.cam?.streamId))
        }
    }

    private func drop(_ uuid: String) {
        guard let p = peers.removeValue(forKey: uuid) else { return }
        p.pc.close()
        state.cameras[uuid] = nil
        state.screens[uuid] = nil
    }

    private func sendState(_ fields: [String: Any]) {
        guard let id = state.channelId else { return }
        api.voiceState(id, fields)
    }

    private func peer(for pc: RTCPeerConnection) -> Peer? { peers.values.first { $0.pc === pc } }
}

extension Voice: RTCPeerConnectionDelegate {
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
        guard newState == .failed else { return }
        DispatchQueue.main.async {
            guard let p = self.peer(for: peerConnection) else { return }
            self.drop(p.uuid)
            self.connect(p.uuid)                 // try once more
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track else { return }
        let sid = mediaStreams.first?.streamId
        DispatchQueue.main.async {
            guard let p = self.peer(for: peerConnection) else { return }
            if let a = track as? RTCAudioTrack { p.audio = a; a.isEnabled = !self.state.deafened }
            else if let v = track as? RTCVideoTrack {
                if let s = sid, s == p.camera { self.state.cameras[p.uuid] = v } else { self.state.screens[p.uuid] = v }
            }
        }
    }
}
