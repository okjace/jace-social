import UIKit

/// Updates for this app. It's sideloaded, so it can't replace itself: AltStore / SideStore do that.
/// Add Jace Social's source there once (the website's /altstore, which lists this app as
/// "Jace Social (iOS 12)") and they install new versions by themselves, in the background. Here: a
/// check on startup (at most once a day) that offers the update, and a check in You.
enum Updates {
    private static let autoKey = "jace.autoUpdate", askedKey = "jace.askedAbout", lastKey = "jace.lastUpdateCheck"

    static var auto: Bool {
        get { UserDefaults.standard.object(forKey: autoKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: autoKey) }
    }

    static var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

    /// The website's AltStore / SideStore source.
    static var source: String { Api.base.replacingOccurrences(of: "/api/v1", with: "") + "/altstore" }

    /// On startup and coming back to the app: look (once a day), and ask about each new version once.
    static func checkSoon(from vc: UIViewController) {
        guard auto else { return }
        let last = UserDefaults.standard.double(forKey: lastKey)
        guard Date().timeIntervalSince1970 - last > 20 * 3600 else { return }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastKey)
        check { r in
            guard case .success(let rel?) = r, UserDefaults.standard.string(forKey: askedKey) != rel.version else { return }
            UserDefaults.standard.set(rel.version, forKey: askedKey)
            offer(rel, from: vc)
        }
    }

    /// -> the newer release, nil if this is the newest
    static func check(_ done: @escaping (Result<Release?, ApiError>) -> Void) {
        Session.shared.api.latestRelease { r in
            done(r.map { newer($0.version, than: current) && ($0.downloads ?? []).contains { $0.id == "ios12" } ? $0 : nil })
        }
    }

    /// "Jace Social 2.1.0 is out": update in AltStore / SideStore, or get the download.
    static func offer(_ rel: Release, from vc: UIViewController) {
        let notes = (rel.notes ?? "").replacingOccurrences(of: "## ", with: "").prefix(500)
        let a = UIAlertController(title: "Jace Social \(rel.version) is out", message: "You have \(current).\n\n\(notes)", preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Update in AltStore / SideStore", style: .default) { _ in openUpdater(rel) })
        a.addAction(UIAlertAction(title: "Get the download", style: .default) { _ in
            if let u = URL(string: rel.page) { UIApplication.shared.open(u) }
        })
        a.addAction(UIAlertAction(title: "Later", style: .cancel))
        vc.present(a, animated: true)
    }

    /// Add the source in AltStore, else SideStore (they update the app from then on), else the release page.
    static func openUpdater(_ rel: Release? = nil) {
        let src = source.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? source
        let tries = ["altstore://source?url=\(src)", "sidestore://source?url=\(src)"].compactMap(URL.init(string:))
        func next(_ i: Int) {
            guard i < tries.count else {
                let page = rel?.page ?? "https://github.com/okjace/jace-social/releases"
                if let u = URL(string: page) { UIApplication.shared.open(u) }
                return
            }
            UIApplication.shared.open(tries[i], options: [:]) { ok in if !ok { next(i + 1) } }
        }
        next(0)
    }

    static func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<3 {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }
}
