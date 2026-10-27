import Foundation

/// An error the server explained (its "error" field), or a network problem.
struct ApiError: Error {
    let status: Int
    let message: String
}

typealias Done<T> = (Result<T, ApiError>) -> Void

/// The Jace Social API (docs/api.md), with completion handlers (async/await needs iOS 13).
/// Every handler is called on the main thread.
final class Api {
    /// Test builds can point at the fake API (native-test/mock_api.py) with JACE_API_BASE.
    static let base: String = {
        #if DEBUG
        if let b = ProcessInfo.processInfo.environment["JACE_API_BASE"] { return b + "/api/v1" }
        #endif
        return "https://jace-social.vercel.app/api/v1"
    }()
    private let token: () -> String?
    /// The server said the session is no good any more (401).
    var onExpired: (() -> Void)?
    private let decoder = JSONDecoder()

    init(token: @escaping () -> String?) { self.token = token }

    private func request(_ method: String, _ path: String) -> URLRequest {
        var req = URLRequest(url: URL(string: Api.base + path)!)
        req.httpMethod = method
        req.timeoutInterval = 30
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        req.setValue("JaceSocialiOS12/\(version)", forHTTPHeaderField: "User-Agent")
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func run(_ req: URLRequest, _ done: @escaping Done<Data>) {
        URLSession.shared.dataTask(with: req) { data, response, error in
            let result: Result<Data, ApiError>
            if error != nil {
                result = .failure(ApiError(status: 0, message: "Can't reach Jace Social - check your internet connection"))
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                let body = data ?? Data()
                if (200..<300).contains(code) {
                    result = .success(body)
                } else {
                    let msg = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? String
                    result = .failure(ApiError(status: code, message: msg ?? "Jace Social error (\(code))"))
                }
            }
            DispatchQueue.main.async {
                if case .failure(let e) = result, e.status == 401, self.token() != nil { self.onExpired?() }
                done(result)
            }
        }.resume()
    }

    /// method + path ("/me") -> the answer's JSON data.
    func call(_ method: String, _ path: String, body: [String: Any]? = nil, _ done: @escaping Done<Data>) {
        var req = request(method, path)
        if method != "GET" && (method != "DELETE" || body != nil) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body ?? [:])
        }
        run(req, done)
    }

    /// The same, when only "did it work" matters.
    func send(_ method: String, _ path: String, body: [String: Any]? = nil, _ done: @escaping (ApiError?) -> Void = { _ in }) {
        call(method, path, body: body) { r in
            if case .failure(let e) = r { done(e) } else { done(nil) }
        }
    }

    func get<T: Decodable>(_ path: String, _ done: @escaping Done<T>) { decoded("GET", path, nil, done) }
    func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:], _ done: @escaping Done<T>) { decoded("POST", path, body, done) }

    private func decoded<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]?, _ done: @escaping Done<T>) {
        call(method, path, body: body) { r in
            done(r.flatMap { data in
                Result { try self.decoder.decode(T.self, from: data) }
                    .mapError { _ in ApiError(status: 0, message: "Jace Social sent something this app doesn't understand - update the app") }
            })
        }
    }

    private static func pending(_ data: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["pending"] != nil
    }

    // --- signing in
    func startJace(_ done: @escaping Done<JaceStart>) { post("/auth/jace", [:], done) }
    /// .success(nil) while the browser part isn't done yet
    func pollJace(_ s: JaceStart, _ done: @escaping Done<SignedIn?>) {
        call("GET", "/auth/jace/poll?state=\(s.state)&key=\(s.poll_key)") { r in
            done(r.map { Api.pending($0) ? nil : try? JSONDecoder().decode(SignedIn.self, from: $0) })
        }
    }
    func startMinecraft(_ done: @escaping Done<DeviceCode>) { post("/auth/minecraft", [:], done) }
    func pollMinecraft(_ ticket: String, _ done: @escaping Done<SignedIn?>) {
        call("POST", "/auth/minecraft/poll", body: ["ticket": ticket]) { r in
            done(r.map { Api.pending($0) ? nil : try? JSONDecoder().decode(SignedIn.self, from: $0) })
        }
    }
    func signOut(_ done: @escaping () -> Void) { send("POST", "/auth/signout") { _ in done() } }

    // --- lists
    func me(_ done: @escaping Done<Me>) { get("/me", done) }
    func friends(_ done: @escaping Done<FriendsData>) { get("/friends", done) }
    func groups(_ done: @escaping Done<[Group]>) { get("/groups") { (r: Result<GroupsData, ApiError>) in done(r.map { $0.groups ?? [] }) } }
    func servers(_ done: @escaping Done<[ServerItem]>) { get("/servers") { (r: Result<ServersData, ApiError>) in done(r.map { $0.servers ?? [] }) } }
    func server(_ id: String, _ done: @escaping Done<ServerDetail>) { get("/servers/\(id)", done) }

    // --- messages
    func messages(_ t: ChatTarget, before: Int? = nil, _ done: @escaping Done<MessagesPage>) {
        switch t {
        case .direct(let u): get("/messages?with=\(u)" + (before.map { "&before=\($0)" } ?? ""), done)
        case .channel(let c): get("/channels/\(c)/messages" + (before.map { "?before=\($0)" } ?? ""), done)
        }
    }

    func send(_ t: ChatTarget, _ body: String, replyTo: Int?, attachments: [Attachment], _ done: @escaping Done<Message>) {
        var fields: [String: Any] = ["body": body]
        if let r = replyTo { fields["reply_to"] = r }
        if !attachments.isEmpty {
            fields["attachments"] = attachments.map { a -> [String: Any] in
                var o: [String: Any] = ["url": a.url, "name": a.name ?? "file", "type": a.type ?? "application/octet-stream", "size": a.size ?? 0]
                if let w = a.width, let h = a.height { o["width"] = w; o["height"] = h }
                return o
            }
        }
        let path: String
        switch t {
        case .direct(let u): fields["to"] = u; path = "/messages"
        case .channel(let c): path = "/channels/\(c)/messages"
        }
        post(path, fields) { (r: Result<SentMessage, ApiError>) in done(r.map { $0.message }) }
    }

    private func messagePath(_ t: ChatTarget, _ id: Int) -> String {
        if case .direct = t { return "/messages/direct/\(id)" }
        return "/messages/\(id)"
    }
    func edit(_ t: ChatTarget, _ id: Int, _ body: String, _ done: @escaping (ApiError?) -> Void) {
        send("PATCH", messagePath(t, id), body: ["body": body], done)
    }
    func delete(_ t: ChatTarget, _ id: Int, _ done: @escaping (ApiError?) -> Void) { send("DELETE", messagePath(t, id), done) }
    func react(_ t: ChatTarget, _ id: Int, _ emoji: String, on: Bool, _ done: @escaping (ApiError?) -> Void) {
        let scope: String
        if case .direct = t { scope = "d" } else { scope = "c" }
        send(on ? "POST" : "DELETE", "/reactions", body: ["scope": scope, "message_id": id, "emoji": emoji], done)
    }
    func typing(_ t: ChatTarget) {
        switch t {
        case .direct(let u): send("POST", "/messages/typing", body: ["to": u])
        case .channel(let c): send("POST", "/channels/\(c)/typing")
        }
    }
    func markRead(_ t: ChatTarget) {
        switch t {
        case .direct(let u): send("POST", "/messages/read", body: ["with": u])
        case .channel(let c): send("POST", "/channels/\(c)/read")
        }
    }

    /// Upload a photo for a message straight to storage (not through the API, which has a size limit).
    func upload(name: String, type: String, data: Data, width: Int, height: Int, _ done: @escaping Done<Attachment>) {
        post("/uploads", ["name": name, "type": type, "size": data.count]) { (r: Result<UploadSlot, ApiError>) in
            switch r {
            case .failure(let e): done(.failure(e))
            case .success(let slot):
                var req = URLRequest(url: URL(string: slot.upload_url)!)
                req.httpMethod = "PUT"
                req.timeoutInterval = 120
                for (k, v) in slot.headers ?? [:] { req.setValue(v, forHTTPHeaderField: k) }
                req.setValue(type, forHTTPHeaderField: "Content-Type")
                URLSession.shared.uploadTask(with: req, from: data) { _, response, error in
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    DispatchQueue.main.async {
                        if error == nil && (200..<300).contains(code) {
                            done(.success(Attachment(url: slot.url, name: name, type: type, size: data.count, width: width, height: height, no_preview: nil)))
                        } else {
                            done(.failure(ApiError(status: code, message: "Couldn't upload the photo (\(code))")))
                        }
                    }
                }.resume()
            }
        }
    }

    // --- friends
    /// Send a friend request by @handle or Minecraft name. -> "accepted" if they'd already asked you.
    func addFriend(_ name: String, _ done: @escaping Done<String>) {
        call("POST", "/friends", body: ["name": name]) { r in
            done(r.map { ((try? JSONSerialization.jsonObject(with: $0)) as? [String: Any])?["status"] as? String ?? "pending" })
        }
    }
    func respondFriend(_ uuid: String, accept: Bool, _ done: @escaping (ApiError?) -> Void) {
        send("POST", "/friends/respond", body: ["uuid": uuid, "accept": accept], done)
    }
    /// Remove a friend, or cancel / decline a request.
    func removeFriend(_ uuid: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/friends?uuid=\(uuid)", done) }

    // --- you
    func updateMe(_ fields: [String: Any], _ done: @escaping Done<Me>) {
        call("PATCH", "/me", body: fields) { r in
            switch r {
            case .failure(let e): done(.failure(e))
            case .success(let d):
                if let me = try? self.decoder.decode(Me.self, from: d) { done(.success(me)) }
                else { done(.failure(ApiError(status: 0, message: "Couldn't read your profile"))) }
            }
        }
    }
    func setAvatar(_ d: Data, _ done: @escaping (ApiError?) -> Void) { raw("/me/avatar", d, done) }

    /// A picture as the whole body (avatars, icons).
    func raw(_ path: String, _ data: Data, type: String = "image/jpeg", _ done: @escaping (ApiError?) -> Void) {
        var req = request("POST", path)
        req.timeoutInterval = 60
        req.setValue(type, forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        run(req) { r in if case .failure(let e) = r { done(e) } else { done(nil) } }
    }

    // --- group chats
    func createGroup(_ name: String, _ members: [String], _ done: @escaping Done<String>) {
        call("POST", "/groups", body: ["name": name, "members": members]) { r in
            done(r.map { ((self.json($0)["group"] as? [String: Any])?["id"] as? String) ?? "" })
        }
    }
    func renameGroup(_ id: String, _ name: String, _ done: @escaping (ApiError?) -> Void) { send("PATCH", "/groups/\(id)", body: ["name": name], done) }
    func addToGroup(_ id: String, _ uuid: String, _ done: @escaping (ApiError?) -> Void) { send("POST", "/groups/\(id)/members", body: ["uuid": uuid], done) }
    /// your own uuid: leave; someone else (owner only): remove them
    func removeFromGroup(_ id: String, _ uuid: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/groups/\(id)/members?uuid=\(uuid)", done) }

    // --- servers
    func createServer(_ name: String, _ done: @escaping Done<String>) {
        call("POST", "/servers", body: ["name": name]) { r in
            done(r.map { ((self.json($0)["server"] as? [String: Any])?["id"] as? String) ?? "" })
        }
    }
    /// -> the server's id
    func joinInvite(_ code: String, _ done: @escaping Done<String>) {
        call("POST", "/invites/\(enc(code))", body: [:]) { r in
            done(r.map { ((self.json($0)["server"] as? [String: Any])?["id"] as? String) ?? (self.json($0)["server_id"] as? String) ?? "" })
        }
    }
    func updateServer(_ id: String, _ fields: [String: Any], _ done: @escaping (ApiError?) -> Void) { send("PATCH", "/servers/\(id)", body: fields, done) }
    func deleteServer(_ id: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/servers/\(id)", done) }
    func newInvite(_ id: String, _ done: @escaping Done<String>) {
        call("POST", "/servers/\(id)/invite", body: [:]) { r in done(r.map { self.json($0)["invite_code"] as? String ?? "" }) }
    }
    /// your own uuid: leave; someone else: kick
    func removeMember(_ id: String, _ uuid: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/servers/\(id)/members?uuid=\(uuid)", done) }
    func updateMember(_ id: String, _ fields: [String: Any], _ done: @escaping (ApiError?) -> Void) { send("PATCH", "/servers/\(id)/members", body: fields, done) }
    func bans(_ id: String, _ done: @escaping Done<[Ban]>) {
        struct D: Codable { var bans: [Ban]? }
        get("/servers/\(id)/bans") { (r: Result<D, ApiError>) in done(r.map { $0.bans ?? [] }) }
    }
    func ban(_ id: String, _ uuid: String, reason: String, _ done: @escaping (ApiError?) -> Void) {
        send("POST", "/servers/\(id)/bans", body: ["uuid": uuid, "reason": reason, "delete_messages": false], done)
    }
    func unban(_ id: String, _ uuid: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/servers/\(id)/bans?uuid=\(uuid)", done) }
    func createRole(_ id: String, _ name: String, _ done: @escaping (ApiError?) -> Void) { send("POST", "/servers/\(id)/roles", body: ["name": name, "color": NSNull()], done) }
    func updateRole(_ id: String, _ role: String, _ fields: [String: Any], _ done: @escaping (ApiError?) -> Void) {
        send("PATCH", "/servers/\(id)/roles/\(role)", body: fields, done)
    }
    func deleteRole(_ id: String, _ role: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/servers/\(id)/roles/\(role)", done) }
    func createChannel(_ id: String, _ name: String, kind: String, _ done: @escaping (ApiError?) -> Void) {
        send("POST", "/servers/\(id)/channels", body: ["name": name, "kind": kind], done)
    }
    func updateChannel(_ channel: String, _ fields: [String: Any], _ done: @escaping (ApiError?) -> Void) { send("PATCH", "/channels/\(channel)", body: fields, done) }
    func deleteChannel(_ channel: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/channels/\(channel)", done) }
    func addBot(_ id: String, _ bot: String, _ done: @escaping (ApiError?) -> Void) { send("POST", "/servers/\(id)/bots", body: ["bot": bot], done) }

    // --- bots
    func bots(_ done: @escaping Done<[Bot]>) {
        struct D: Codable { var bots: [Bot]? }
        get("/bots") { (r: Result<D, ApiError>) in done(r.map { $0.bots ?? [] }) }
    }
    /// -> its token (only shown now)
    func createBot(_ name: String, _ done: @escaping Done<String>) {
        call("POST", "/bots", body: ["name": name]) { r in done(r.map { self.json($0)["token"] as? String ?? "" }) }
    }
    func updateBot(_ id: String, _ fields: [String: Any], _ done: @escaping (ApiError?) -> Void) { send("PATCH", "/bots/\(id)", body: fields, done) }
    func deleteBot(_ id: String, _ done: @escaping (ApiError?) -> Void) { send("DELETE", "/bots/\(id)", done) }
    func botToken(_ id: String, _ done: @escaping Done<String>) {
        call("POST", "/bots/\(id)/token", body: [:]) { r in done(r.map { self.json($0)["token"] as? String ?? "" }) }
    }
    func botCode(_ id: String, _ done: @escaping Done<String>) {
        call("GET", "/bots/\(id)") { r in done(r.map { self.json($0)["code"] as? String ?? "" }) }
    }
    /// -> the slash commands it defines
    func saveBotCode(_ id: String, _ code: String?, _ done: @escaping Done<[String]>) {
        call("PUT", "/bots/\(id)/code", body: ["code": code as Any? ?? NSNull()]) { r in
            done(r.map { (self.json($0)["commands"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? [] })
        }
    }
    /// What the code would do for a pretend message or /command (actions, logs, error).
    func tryBotCode(_ id: String, _ code: String, _ text: String, _ done: @escaping Done<[String: Any]>) {
        var body: [String: Any] = ["code": code, "text": text]
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("/") {
            let parts = t.dropFirst().split(separator: " ").map(String.init)
            body["text"] = parts.dropFirst().joined(separator: " ")
            body["command"] = ["name": parts.first ?? "", "args": ["text": parts.dropFirst().joined(separator: " ")]]
        }
        call("POST", "/bots/\(id)/code", body: body) { r in done(r.map { self.json($0)["result"] as? [String: Any] ?? [:] }) }
    }

    // --- calls and voice channels
    /// ICE servers as the website gets them: [{urls, username?, credential?}]
    func ice(_ done: @escaping Done<[[String: Any]]>) {
        call("GET", "/calls/ice") { r in done(r.map { self.json($0)["ice_servers"] as? [[String: Any]] ?? [] }) }
    }
    func callSignal(to: String, callId: String, kind: String, sdp: String? = nil, _ done: @escaping (ApiError?) -> Void = { _ in }) {
        var body: [String: Any] = ["to": to, "call_id": callId, "kind": kind]
        if let s = sdp { body["sdp"] = s }
        send("POST", "/calls", body: body, done)
    }
    func readCallSignal(_ id: Int, _ done: @escaping Done<Signal>) { get("/calls?id=\(id)") { (r: Result<SignalData, ApiError>) in done(r.map { $0.signal }) } }
    func voiceJoin(_ channel: String, _ done: @escaping Done<VoiceJoin>) { post("/channels/\(channel)/voice", ["action": "join"], done) }
    func voiceLeave(_ channel: String) { send("POST", "/channels/\(channel)/voice", body: ["action": "leave"]) }
    func voiceState(_ channel: String, _ fields: [String: Any]) {
        var body = fields
        body["action"] = "state"
        send("POST", "/channels/\(channel)/voice", body: body)
    }
    func voiceRoom(_ channel: String, _ done: @escaping Done<[Participant]>) {
        get("/channels/\(channel)/voice") { (r: Result<ParticipantsData, ApiError>) in done(r.map { $0.participants ?? [] }) }
    }
    func voiceSignal(_ channel: String, to: String, kind: String, sdp: String, _ done: @escaping (ApiError?) -> Void = { _ in }) {
        send("POST", "/voice/signal", body: ["channel_id": channel, "to": to, "kind": kind, "sdp": sdp], done)
    }
    func readVoiceSignal(_ id: Int, _ done: @escaping Done<Signal>) { get("/voice/signal?id=\(id)") { (r: Result<SignalData, ApiError>) in done(r.map { $0.signal }) } }

    func json(_ data: Data) -> [String: Any] { ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:] }
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s }

    func latestRelease(_ done: @escaping Done<Release>) { get("/releases/mobile", done) }

    func presence() { send("POST", "/presence", body: ["activity": ["type": "app", "app": "jace-social-mobile"]]) }
}
