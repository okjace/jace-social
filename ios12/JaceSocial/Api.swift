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
    func presence() { send("POST", "/presence", body: ["activity": ["type": "app", "app": "jace-social-mobile"]]) }
}
