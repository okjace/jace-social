import Foundation

/// A live event from Jace Social: channel, dm_update, friends, groups, message, presence, servers,
/// typing, ... (see docs/native-apps.md). Posted as a notification on the main thread.
struct LiveEvent {
    static let notification = Notification.Name("JaceLiveEvent")
    let event: String
    let payload: [String: Any]
    func str(_ key: String) -> String? { payload[key] as? String }
}

/// Supabase Realtime over a websocket (the Phoenix protocol, like ios/JaceSocial/Live.swift): join our
/// private channel and pass its broadcasts on. Reconnects by itself.
final class Live {
    private(set) var running = false
    private var socket: WebSocket?
    private var heartbeat: Timer?
    private var ref = 0
    private var url: URL?
    private var topic = ""

    func start(_ realtime: Realtime, inbox: String) {
        stop()
        guard !realtime.url.isEmpty, !realtime.key.isEmpty, !inbox.isEmpty else { return }
        let base = realtime.url.replacingOccurrences(of: "https://", with: "wss://").replacingOccurrences(of: "http://", with: "ws://")
        let key = realtime.key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? realtime.key
        guard let u = URL(string: "\(base)/realtime/v1/websocket?apikey=\(key)&vsn=1.0.0") else { return }
        running = true
        url = u
        topic = "realtime:\(inbox)"
        connect()
    }

    func stop() {
        running = false
        heartbeat?.invalidate()
        heartbeat = nil
        let s = socket
        socket = nil
        s?.close()
    }

    private func connect() {
        guard running, let u = url else { return }
        let s = WebSocket(url: u)
        socket = s
        s.onOpen = { [weak self, weak s] in
            guard let self = self, let s = s, self.socket === s else { return }
            self.send("phx_join", topic: self.topic,
                      ["config": ["broadcast": ["ack": false, "self": false], "presence": ["key": ""], "private": false]])
            self.heartbeat?.invalidate()
            self.heartbeat = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
                self?.send("heartbeat", topic: "phoenix", [:])
            }
            // (anything missed while it was down: the screens reload)
            NotificationCenter.default.post(name: LiveEvent.notification, object: LiveEvent(event: "reconnected", payload: [:]))
        }
        s.onText = { text in
            guard let data = text.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  obj["event"] as? String == "broadcast", let inner = obj["payload"] as? [String: Any],
                  let event = inner["event"] as? String else { return }
            NotificationCenter.default.post(name: LiveEvent.notification,
                                            object: LiveEvent(event: event, payload: inner["payload"] as? [String: Any] ?? [:]))
        }
        s.onClose = { [weak self, weak s] in
            guard let self = self, let s = s, self.socket === s, self.running else { return }
            self.heartbeat?.invalidate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in   // reconnect
                guard let self = self, self.running, self.socket === s else { return }
                self.connect()
            }
        }
        s.connect()
    }

    private func send(_ event: String, topic: String, _ payload: [String: Any]) {
        ref += 1
        let msg: [String: Any] = ["topic": topic, "event": event, "payload": payload, "ref": String(ref), "join_ref": "1"]
        if let data = try? JSONSerialization.data(withJSONObject: msg), let text = String(data: data, encoding: .utf8) {
            socket?.send(text)
        }
    }
}
