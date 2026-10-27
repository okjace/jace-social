import Foundation
import Security

/// The signed-in account: its token (in the Keychain), the API that uses it, and you (/me).
final class Session {
    static let shared = Session()
    static let changed = Notification.Name("JaceSessionChanged")    // signed in or out

    private(set) var token: String?
    private(set) var me: Me?
    private(set) lazy var api: Api = {
        let a = Api { [weak self] in self?.token }
        a.onExpired = { [weak self] in self?.use(nil) }
        return a
    }()
    let live = Live()

    private init() {
        token = Keychain.read()
        // test builds: -jaceToken <t> signs in with that token (CI screenshots with native-test/mock_api.py)
        #if DEBUG
        if let t = UserDefaults.standard.string(forKey: "jaceToken") { token = t }
        #endif
    }

    func signedIn(_ s: SignedIn) { use(s.token) }

    func signOut() {
        live.stop()
        api.signOut { [weak self] in self?.use(nil) }
    }

    private func use(_ t: String?) {
        Keychain.write(t)
        token = t
        me = nil
        if t == nil { live.stop() }
        NotificationCenter.default.post(name: Session.changed, object: nil)
    }

    /// Load /me and start live updates.
    func loadMe(_ done: @escaping (ApiError?) -> Void) {
        api.me { [weak self] r in
            switch r {
            case .success(let me):
                self?.setMe(me)
                done(nil)
            case .failure(let e): done(e)
            }
        }
    }

    func setMe(_ m: Me) {
        me = m
        if let rt = m.realtime, let inbox = m.inbox, !live.running { live.start(rt, inbox: inbox) }
    }
}

enum Keychain {
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.jacedeb.jacesocial.ios12", kSecAttrAccount as String: account]
    }

    static func read(account: String = "session") -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func write(_ value: String?, account: String = "session") {
        SecItemDelete(query(account) as CFDictionary)
        guard let v = value else { return }
        var q = query(account)
        q[kSecValueData as String] = Data(v.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
}
