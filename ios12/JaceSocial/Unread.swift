import UIKit

/// Notifications for new messages without push (a sideloaded app can't get push notifications):
/// iOS wakes the app every so often (background fetch, AppDelegate), and this compares the unread
/// counts of direct messages and group chats with the last ones seen, then notifies about what's
/// new. While the app is open (or was just left), live events notify right away.
enum Unread {
    private static let key = "jace_unread_seen"

    /// The unread counts now: "dm:<uuid>" / "group:<id>" -> (count, who / which chat).
    private static func fetch(_ done: @escaping ([String: (Int, String)]?) -> Void) {
        let api = Session.shared.api
        var out: [String: (Int, String)] = [:]
        var ok = true
        let wait = DispatchGroup()
        wait.enter()
        api.friends { r in
            switch r {
            case .success(let f): for p in (f.friends ?? []) + (f.others ?? []) { out["dm:\(p.uuid)"] = (p.unread ?? 0, p.shownName) }
            case .failure: ok = false
            }
            wait.leave()
        }
        wait.enter()
        api.groups { r in
            switch r {
            case .success(let gs): for g in gs { out["group:\(g.id)"] = (g.unread ?? 0, g.name ?? "a group chat") }
            case .failure: ok = false
            }
            wait.leave()
        }
        wait.notify(queue: .main) { done(ok ? out : nil) }
    }

    /// Look for new messages; notify (when asked) about chats with more unread than last time.
    /// -> whether there was anything new.
    static func check(notify: Bool, _ done: @escaping (Bool) -> Void = { _ in }) {
        guard Session.shared.token != nil else { done(false); return }
        fetch { now in
            guard let now = now else { done(false); return }
            let seen = UserDefaults.standard.dictionary(forKey: key) as? [String: Int] ?? [:]
            var new = false
            for (k, (count, name)) in now where count > (seen[k] ?? 0) {
                new = true
                guard notify else { continue }
                let more = count - (seen[k] ?? 0)
                let what = more == 1 ? "a new message" : "\(more) new messages"
                if k.hasPrefix("dm:") { Notify.post(title: name, body: "Sent you \(what)", id: k) }
                else { Notify.post(title: name, body: "\(what.prefix(1).uppercased())\(what.dropFirst()) in the group chat", id: k) }
            }
            UserDefaults.standard.set(now.mapValues { $0.0 }, forKey: key)
            UIApplication.shared.applicationIconBadgeNumber = now.values.reduce(0) { $0 + $1.0 }
            done(new)
        }
    }

    /// While the app is in the background but still running (just left, or in a call): a live message
    /// notifies straight away, then the counts are remembered so the next check doesn't repeat it.
    static func watchLive() {
        NotificationCenter.default.addObserver(forName: LiveEvent.notification, object: nil, queue: .main) { n in
            guard UIApplication.shared.applicationState != .active, let e = n.object as? LiveEvent else { return }
            if e.event == "message", e.str("from") != Session.shared.me?.uuid {
                Notify.post(title: e.str("name") ?? "New message", body: "Sent you a message", id: "dm:\(e.str("from") ?? "")")
            } else if e.event == "channel", e.str("server_id") == nil, e.payload["edited"] == nil, e.payload["deleted"] == nil,
                      e.payload["reacted"] == nil, let name = e.str("name"), e.str("from") != Session.shared.me?.uuid {
                Notify.post(title: name, body: "New message in a group chat", id: "group:\(e.str("channel_id") ?? "")")
            } else {
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { check(notify: false) }
        }
    }
}
