import Foundation

/// A JSON value, or null when there's none (the API clears a field with null).
func orNull(_ v: Any?) -> Any { v ?? NSNull() }

/// An error the server explained (its "error" field), or a network problem.
struct ApiError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// The Jace Social API (docs/api.md).
final class Api {
    /// Test builds can point at the fake API (native-test/mock_api.py) with JACE_API_BASE.
    static let base: URL = {
        #if DEBUG
        if let b = ProcessInfo.processInfo.environment["JACE_API_BASE"], let u = URL(string: b + "/api/v1") { return u }
        #endif
        return URL(string: "https://jace-social.vercel.app/api/v1")!
    }()
    var token: () -> String?
    let decoder = JSONDecoder()

    init(token: @escaping () -> String?) { self.token = token }

    /// method + path ("/me") -> the answer's JSON data. Throws ApiError.
    func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: URL(string: Api.base.absoluteString + path)!)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("JaceSocialiOS/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?")", forHTTPHeaderField: "User-Agent")
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if method != "GET" && (method != "DELETE" || body != nil) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            #if DEBUG
            NSLog("Jace API %@ %@ failed: %@", method, path, String(describing: error))
            #endif
            throw ApiError(status: 0, message: "Can't reach Jace Social - check your internet connection")
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ApiError(status: code, message: msg ?? "Jace Social error (\(code))")
        }
        return data
    }

    /// A picture as the whole body (avatars, icons, banners).
    func callRaw(_ path: String, _ data: Data, type: String) async throws {
        var req = URLRequest(url: URL(string: Api.base.absoluteString + path)!)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue(type, forHTTPHeaderField: "Content-Type")
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.httpBody = data
        let (out, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: out) as? [String: Any])?["error"] as? String
            throw ApiError(status: code, message: msg ?? "Jace Social error (\(code))")
        }
    }

    func json(_ data: Data) -> [String: Any] { ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:] }

    func get<T: Decodable>(_ path: String) async throws -> T { try decoder.decode(T.self, from: try await call("GET", path)) }
    func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:]) async throws -> T {
        try decoder.decode(T.self, from: try await call("POST", path, body: body))
    }

    private func pending(_ data: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["pending"] != nil
    }

    // --- the endpoints so far (more as screens are added)
    func me() async throws -> Me { try await get("/me") }
    func friends() async throws -> FriendsData { try await get("/friends") }
    func startJace() async throws -> JaceStart { try await post("/auth/jace") }
    /// nil while the browser part isn't done yet
    func pollJace(_ s: JaceStart) async throws -> SignedIn? {
        let data = try await call("GET", "/auth/jace/poll?state=\(s.state)&key=\(s.poll_key)")
        return pending(data) ? nil : try decoder.decode(SignedIn.self, from: data)
    }
    func startMinecraft() async throws -> DeviceCode { try await post("/auth/minecraft") }
    func pollMinecraft(_ ticket: String) async throws -> SignedIn? {
        let data = try await call("POST", "/auth/minecraft/poll", body: ["ticket": ticket])
        return pending(data) ? nil : try decoder.decode(SignedIn.self, from: data)
    }
    func signOut() async { _ = try? await call("POST", "/auth/signout") }

    // --- chats (direct messages, group chats and server channels share these)
    func groups() async throws -> [Group] { (try await get("/groups") as GroupsData).groups }
    func servers() async throws -> [ServerItem] { (try await get("/servers") as ServersData).servers }
    func server(_ id: String) async throws -> ServerDetail { try await get("/servers/\(id)") }

    func messages(_ t: ChatTarget, before: Int? = nil) async throws -> MessagesPage {
        var page: MessagesPage
        switch t {
        case .direct(let u): page = try await get("/messages?with=\(u)" + (before.map { "&before=\($0)" } ?? ""))
        case .channel(let c): page = try await get("/channels/\(c)/messages" + (before.map { "?before=\($0)" } ?? ""))
        }
        for i in page.messages.indices where page.messages[i].body.contains("[[delete-account") {
            page.messages[i].body = withoutBotMarks(page.messages[i].body)
        }
        return page
    }

    func send(_ t: ChatTarget, _ body: String, replyTo: Int? = nil) async throws -> Message {
        var fields: [String: Any] = ["body": body]
        if let r = replyTo { fields["reply_to"] = r }
        let path: String
        switch t {
        case .direct(let u): fields["to"] = u; path = "/messages"
        case .channel(let c): path = "/channels/\(c)/messages"
        }
        return try decoder.decode(SentMessage.self, from: try await call("POST", path, body: fields)).message
    }

    private func messagePath(_ t: ChatTarget, _ id: Int) -> String {
        if case .direct = t { return "/messages/direct/\(id)" }
        return "/messages/\(id)"
    }

    func edit(_ t: ChatTarget, _ id: Int, _ body: String) async throws { _ = try await call("PATCH", messagePath(t, id), body: ["body": body]) }
    func delete(_ t: ChatTarget, _ id: Int) async throws { _ = try await call("DELETE", messagePath(t, id)) }

    func react(_ t: ChatTarget, _ id: Int, _ emoji: String, on: Bool) async throws {
        let scope: String
        if case .direct = t { scope = "d" } else { scope = "c" }
        _ = try await call(on ? "POST" : "DELETE", "/reactions", body: ["scope": scope, "message_id": id, "emoji": emoji])
    }

    func typing(_ t: ChatTarget) async {
        switch t {
        case .direct(let u): _ = try? await call("POST", "/messages/typing", body: ["to": u])
        case .channel(let c): _ = try? await call("POST", "/channels/\(c)/typing")
        }
    }

    func markRead(_ t: ChatTarget) async {
        switch t {
        case .direct(let u): _ = try? await call("POST", "/messages/read", body: ["with": u])
        case .channel(let c): _ = try? await call("POST", "/channels/\(c)/read")
        }
    }

    // friends
    /// Send a friend request by Minecraft or Jace name (@name: Jace only). "accepted" if they'd already asked you.
    func addFriend(_ name: String) async throws -> String {
        let data = try await call("POST", "/friends", body: ["name": name])
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["status"] as? String ?? "pending"
    }
    func respondFriend(_ uuid: String, accept: Bool) async throws {
        _ = try await call("POST", "/friends/respond", body: ["uuid": uuid, "accept": accept])
    }
    /// Remove a friend, or cancel / decline a request.
    func removeFriend(_ uuid: String) async throws { _ = try await call("DELETE", "/friends?uuid=\(uuid)") }

    // --- you
    func updateMe(_ fields: [String: Any]) async throws -> Me { try decoder.decode(Me.self, from: try await call("PATCH", "/me", body: fields)) }
    func setAvatar(_ d: Data, type: String) async throws { try await callRaw("/me/avatar", d, type: type) }
    func removeAvatar() async throws { _ = try await call("DELETE", "/me/avatar") }
    func setBanner(_ d: Data, type: String) async throws { try await callRaw("/me/banner", d, type: type) }
    func removeBanner() async throws { _ = try await call("DELETE", "/me/banner") }
    func presence() async { _ = try? await call("POST", "/presence", body: ["activity": ["type": "app", "app": "jace-social-mobile"]]) }
    func offline() async { _ = try? await call("POST", "/presence", body: ["activity": NSNull(), "offline": true, "app": true]) }
    func linkJace() async throws -> JaceStart { try await post("/link/jace") }
    func unlinkJace() async throws { _ = try await call("DELETE", "/link/jace") }
    func pollLinkJace(_ s: JaceStart) async throws -> Bool { !pending(try await call("GET", "/auth/jace/poll?state=\(s.state)&key=\(s.poll_key)")) }
    func startLinkMinecraft() async throws -> DeviceCode { try await post("/link/minecraft/device") }
    func pollLinkMinecraft(_ ticket: String) async throws -> Bool { !pending(try await call("POST", "/link/minecraft/device/poll", body: ["ticket": ticket])) }

    // --- people
    func profile(_ uuid: String) async throws -> FullProfile { try await get("/users/\(uuid)") }
    func addFriend(uuid: String) async throws { _ = try await call("POST", "/friends", body: ["uuid": uuid]) }

    // --- group chats
    func createGroup(_ name: String, _ members: [String]) async throws -> String {
        ((json(try await call("POST", "/groups", body: ["name": name, "members": members]))["group"] as? [String: Any])?["id"] as? String) ?? ""
    }
    func renameGroup(_ id: String, _ name: String) async throws { _ = try await call("PATCH", "/groups/\(id)", body: ["name": name]) }
    func setGroupIcon(_ id: String, _ d: Data, type: String) async throws { try await callRaw("/groups/\(id)/icon", d, type: type) }
    func addToGroup(_ id: String, _ uuid: String) async throws { _ = try await call("POST", "/groups/\(id)/members", body: ["uuid": uuid]) }
    /// your own uuid: leave; someone else (owner only): remove them
    func removeFromGroup(_ id: String, _ uuid: String) async throws { _ = try await call("DELETE", "/groups/\(id)/members?uuid=\(uuid)") }

    // --- servers
    func createServer(_ name: String) async throws -> String {
        ((json(try await call("POST", "/servers", body: ["name": name]))["server"] as? [String: Any])?["id"] as? String) ?? ""
    }
    func invite(_ code: String) async throws -> InvitePreview { try await get("/invites/\(enc(code))") }
    func joinInvite(_ code: String) async throws -> JoinedServer { try decoder.decode(JoinedServer.self, from: try await call("POST", "/invites/\(enc(code))", body: [:])) }
    func updateServer(_ id: String, _ fields: [String: Any]) async throws { _ = try await call("PATCH", "/servers/\(id)", body: fields) }
    func deleteServer(_ id: String) async throws { _ = try await call("DELETE", "/servers/\(id)") }
    func setServerIcon(_ id: String, _ d: Data, type: String) async throws { try await callRaw("/servers/\(id)/icon", d, type: type) }
    func setServerBanner(_ id: String, _ d: Data, type: String) async throws { try await callRaw("/servers/\(id)/banner", d, type: type) }
    func removeServerBanner(_ id: String) async throws { _ = try await call("DELETE", "/servers/\(id)/banner") }
    func newInvite(_ id: String) async throws -> String { json(try await call("POST", "/servers/\(id)/invite", body: [:]))["invite_code"] as? String ?? "" }
    /// your own uuid: leave; someone else: kick
    func removeMember(_ id: String, _ uuid: String) async throws { _ = try await call("DELETE", "/servers/\(id)/members?uuid=\(uuid)") }
    func updateMember(_ id: String, _ fields: [String: Any]) async throws { _ = try await call("PATCH", "/servers/\(id)/members", body: fields) }
    func bans(_ id: String) async throws -> [Ban] {
        struct D: Codable { var bans: [Ban] = [] }
        return (try await get("/servers/\(id)/bans") as D).bans
    }
    func ban(_ id: String, _ uuid: String, reason: String) async throws {
        _ = try await call("POST", "/servers/\(id)/bans", body: ["uuid": uuid, "reason": reason, "delete_messages": true])
    }
    func unban(_ id: String, _ uuid: String) async throws { _ = try await call("DELETE", "/servers/\(id)/bans?uuid=\(uuid)") }
    func addBot(_ id: String, _ bot: String) async throws { _ = try await call("POST", "/servers/\(id)/bots", body: ["bot": bot]) }
    func createRole(_ id: String, _ name: String, color: String?) async throws -> String {
        ((json(try await call("POST", "/servers/\(id)/roles", body: ["name": name, "color": orNull(color)]))["role"] as? [String: Any])?["id"] as? String) ?? ""
    }
    func updateRole(_ id: String, _ role: String, _ fields: [String: Any]) async throws { _ = try await call("PATCH", "/servers/\(id)/roles/\(role)", body: fields) }
    func deleteRole(_ id: String, _ role: String) async throws { _ = try await call("DELETE", "/servers/\(id)/roles/\(role)") }
    func reorderRoles(_ id: String, _ order: [String]) async throws { _ = try await call("PUT", "/servers/\(id)/roles", body: ["order": order]) }
    func createChannel(_ id: String, _ name: String, kind: String) async throws {
        _ = try await call("POST", "/servers/\(id)/channels", body: ["name": name, "kind": kind])
    }
    func updateChannel(_ channel: String, _ fields: [String: Any]) async throws { _ = try await call("PATCH", "/channels/\(channel)", body: fields) }
    func deleteChannel(_ channel: String) async throws { _ = try await call("DELETE", "/channels/\(channel)") }
    func setOverride(_ channel: String, _ type: String, _ target: String, allow: Int, deny: Int) async throws {
        _ = try await call("PUT", "/channels/\(channel)/overrides", body: ["target_type": type, "target_id": target, "allow": allow, "deny": deny])
    }
    func removeOverride(_ channel: String, _ type: String, _ target: String) async throws {
        _ = try await call("DELETE", "/channels/\(channel)/overrides?target_type=\(type)&target_id=\(target)")
    }
    func finishOnboarding(_ id: String, answers: [[Int]], agreed: Bool) async throws {
        _ = try await call("POST", "/servers/\(id)/onboarding", body: ["answers": answers, "agreed": agreed])
    }

    // --- messages: pins, slash commands, files
    func pins(_ channel: String) async throws -> MessagesPage { try await get("/channels/\(channel)/pins") }
    func pin(_ id: Int, _ on: Bool) async throws { _ = try await call(on ? "PUT" : "DELETE", "/messages/\(id)/pin") }
    func commands(_ channel: String) async throws -> [Command] {
        struct D: Codable { var commands: [Command] = [] }
        return (try await get("/channels/\(channel)/commands") as D).commands
    }
    func runCommand(_ channel: String, _ c: Command, args: [String: String]) async throws {
        _ = try await call("POST", "/channels/\(channel)/commands", body: ["bot": c.bot, "name": c.name, "args": args])
    }
    /// Upload a file for a message straight to storage (not through the API, which has a size limit).
    func upload(name: String, type: String, data: Data, width: Int? = nil, height: Int? = nil) async throws -> Attachment {
        let slot = try decoder.decode(UploadSlot.self, from: try await call("POST", "/uploads", body: ["name": name, "type": type, "size": data.count]))
        var req = URLRequest(url: URL(string: slot.upload_url)!)
        req.httpMethod = "PUT"
        req.setValue(type, forHTTPHeaderField: "Content-Type")
        req.setValue("false", forHTTPHeaderField: "x-upsert")
        req.httpBody = data
        let (_, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw ApiError(status: code, message: "Couldn't upload \(name) (\(code))") }
        return Attachment(url: slot.url, name: name, type: type, size: data.count, width: width, height: height)
    }
    func send(_ t: ChatTarget, _ body: String, replyTo: Int?, attachments: [Attachment]) async throws -> Message {
        var fields: [String: Any] = ["body": body]
        if let r = replyTo { fields["reply_to"] = r }
        if !attachments.isEmpty {
            fields["attachments"] = attachments.map { a -> [String: Any] in
                var o: [String: Any] = ["url": a.url, "name": a.name, "type": a.type, "size": a.size ?? 0]
                if let w = a.width, let h = a.height { o["width"] = w; o["height"] = h }
                return o
            }
        }
        let path: String
        switch t {
        case .direct(let u): fields["to"] = u; path = "/messages"
        case .channel(let c): path = "/channels/\(c)/messages"
        }
        return try decoder.decode(SentMessage.self, from: try await call("POST", path, body: fields)).message
    }

    // --- bots
    func bots() async throws -> [Bot] {
        struct D: Codable { var bots: [Bot] = [] }
        return (try await get("/bots") as D).bots
    }
    func directory(_ q: String) async throws -> [Person] {
        struct D: Codable { var bots: [Person] = [] }
        return (try await get("/bots/directory?q=\(enc(q))") as D).bots
    }
    /// -> its token (only shown now)
    func createBot(_ name: String) async throws -> String { json(try await call("POST", "/bots", body: ["name": name]))["token"] as? String ?? "" }
    func updateBot(_ id: String, _ fields: [String: Any]) async throws { _ = try await call("PATCH", "/bots/\(id)", body: fields) }
    func deleteBot(_ id: String) async throws { _ = try await call("DELETE", "/bots/\(id)") }
    func botToken(_ id: String) async throws -> String { json(try await call("POST", "/bots/\(id)/token", body: [:]))["token"] as? String ?? "" }
    func botSession(_ id: String) async throws -> BotLink { try decoder.decode(BotLink.self, from: try await call("POST", "/bots/\(id)/session", body: [:])) }
    func setBotAvatar(_ id: String, _ d: Data, type: String) async throws { try await callRaw("/bots/\(id)/avatar", d, type: type) }
    func botCode(_ id: String) async throws -> String? { json(try await call("GET", "/bots/\(id)"))["code"] as? String }
    /// -> the slash commands it defines
    func saveBotCode(_ id: String, _ code: String?) async throws -> [String] {
        let o = json(try await call("PUT", "/bots/\(id)/code", body: ["code": orNull(code)]))
        return (o["commands"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
    }
    /// What the code would do for a pretend message or /command (raw JSON: actions, logs, storage, error).
    func tryBotCode(_ id: String, _ code: String, _ text: String) async throws -> [String: Any] {
        var body: [String: Any] = ["code": code, "text": text]
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("/") {
            let parts = t.dropFirst().split(separator: " ").map(String.init)
            body["text"] = parts.dropFirst().joined(separator: " ")
            body["command"] = ["name": parts.first ?? "", "args": ["text": parts.dropFirst().joined(separator: " ")]]
        }
        return json(try await call("POST", "/bots/\(id)/code", body: body))["result"] as? [String: Any] ?? [:]
    }
    func botActivity(_ id: String, server: String? = nil, before: Int? = nil) async throws -> BotActivityPage {
        let q = [server.map { "server=\($0)" }, before.map { "before=\($0)" }].compactMap { $0 }.joined(separator: "&")
        return try await get("/bots/\(id)/activity?\(q)")
    }

    // --- calls and voice rooms
    /// ICE servers as the website gets them: [{urls, username?, credential?}]
    func ice() async throws -> [[String: Any]] { json(try await call("GET", "/calls/ice"))["ice_servers"] as? [[String: Any]] ?? [] }
    func callSignal(to: String, callId: String, kind: String, sdp: String? = nil) async throws {
        var body: [String: Any] = ["to": to, "call_id": callId, "kind": kind]
        if let s = sdp { body["sdp"] = s }
        _ = try await call("POST", "/calls", body: body)
    }
    func readCallSignal(_ id: Int) async throws -> Signal { (try await get("/calls?id=\(id)") as SignalData).signal }
    func voiceJoin(_ channel: String) async throws -> VoiceJoin { try decoder.decode(VoiceJoin.self, from: try await call("POST", "/channels/\(channel)/voice", body: ["action": "join"])) }
    func voiceLeave(_ channel: String) async { _ = try? await call("POST", "/channels/\(channel)/voice", body: ["action": "leave"]) }
    func voiceState(_ channel: String, _ fields: [String: Any]) async throws {
        var body = fields
        body["action"] = "state"
        _ = try await call("POST", "/channels/\(channel)/voice", body: body)
    }
    func voiceRoom(_ channel: String) async throws -> [Participant] { (try await get("/channels/\(channel)/voice") as ParticipantsData).participants }
    func voiceSignal(_ channel: String, to: String, kind: String, sdp: String) async throws {
        _ = try await call("POST", "/voice/signal", body: ["channel_id": channel, "to": to, "kind": kind, "sdp": sdp])
    }
    func readVoiceSignal(_ id: Int) async throws -> Signal { (try await get("/voice/signal?id=\(id)") as SignalData).signal }

    // --- updates
    func latestRelease() async throws -> Release { try await get("/releases/mobile") }

    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }
}
