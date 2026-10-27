import UIKit

/// Jace Social for iOS 12+: sign in, then three tabs - Chats (direct messages, group chats and
/// servers), Friends and You.
@UIApplicationMain
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Theme.apply()
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = Theme.bg
        window = w
        showRoot()
        w.makeKeyAndVisible()
        NotificationCenter.default.addObserver(forName: Session.changed, object: nil, queue: .main) { [weak self] _ in self?.showRoot() }
        // notifications while the app is closed: iOS wakes it now and then to look (Unread.swift)
        application.setMinimumBackgroundFetchInterval(UIApplication.backgroundFetchIntervalMinimum)
        Unread.watchLive()
        return true
    }

    func application(_ application: UIApplication, performFetchWithCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        Unread.check(notify: true) { new in completionHandler(new ? .newData : .noData) }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        Unread.check(notify: false)          // (what you've seen doesn't notify later)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        if Session.shared.token != nil { Session.shared.api.presence() }
    }

    private func showRoot() {
        let root: UIViewController = Session.shared.token == nil ? SignInViewController() : MainTabs()
        guard let w = window else { return }
        if w.rootViewController == nil {
            w.rootViewController = root
        } else {
            UIView.transition(with: w, duration: 0.25, options: .transitionCrossDissolve, animations: { w.rootViewController = root })
        }
    }
}

final class MainTabs: UITabBarController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let chats = UINavigationController(rootViewController: ChatsViewController())
        chats.tabBarItem = UITabBarItem(title: "Chats", image: TabIcon.chats, tag: 0)
        let friends = UINavigationController(rootViewController: FriendsViewController())
        friends.tabBarItem = UITabBarItem(title: "Friends", image: TabIcon.friends, tag: 1)
        let you = UINavigationController(rootViewController: YouViewController())
        you.tabBarItem = UITabBarItem(title: "You", image: TabIcon.you, tag: 2)
        viewControllers = [chats, friends, you]
        _ = Phone.shared                         // calls ring from here on
        Notify.ask()
        Session.shared.loadMe { [weak self] e in
            if let e = e, e.status != 401 { self?.alert("Couldn't load your account", e.message) }
        }
        #if DEBUG
        DebugOpen.run(self)
        #endif
    }
}

/// Tab bar icons, drawn here (SF Symbols need iOS 13).
enum TabIcon {
    static let chats = draw { r in
        let p = UIBezierPath(roundedRect: CGRect(x: 3, y: 4, width: 20, height: 15), cornerRadius: 5)
        p.move(to: CGPoint(x: 8, y: 19)); p.addLine(to: CGPoint(x: 7, y: 24)); p.addLine(to: CGPoint(x: 13, y: 19))
        p.lineWidth = 2; p.stroke()
    }
    static let friends = draw { _ in
        let head = UIBezierPath(ovalIn: CGRect(x: 9, y: 3, width: 9, height: 9)); head.lineWidth = 2; head.stroke()
        let body = UIBezierPath()
        body.addArc(withCenter: CGPoint(x: 13.5, y: 24), radius: 9, startAngle: .pi, endAngle: 0, clockwise: true)
        body.lineWidth = 2; body.stroke()
    }
    static let you = draw { _ in
        let ring = UIBezierPath(ovalIn: CGRect(x: 3, y: 3, width: 21, height: 21)); ring.lineWidth = 2; ring.stroke()
        let head = UIBezierPath(ovalIn: CGRect(x: 10, y: 8, width: 7, height: 7)); head.lineWidth = 2; head.stroke()
    }

    private static func draw(_ paint: (CGRect) -> Void) -> UIImage? {
        let size = CGSize(width: 27, height: 27)
        UIGraphicsBeginImageContextWithOptions(size, false, 0)
        defer { UIGraphicsEndImageContext() }
        UIColor.black.setStroke()
        paint(CGRect(origin: .zero, size: size))
        return UIGraphicsGetImageFromCurrentImageContext()?.withRenderingMode(.alwaysTemplate)
    }
}

#if DEBUG
/// Test builds: -jaceOpen dm:<uuid>:<name> | server:<id>:<name> opens that screen (CI screenshots).
enum DebugOpen {
    static func run(_ tabs: UITabBarController) {
        guard let open = UserDefaults.standard.string(forKey: "jaceOpen") else { return }
        let parts = open.split(separator: ":", maxSplits: 2).map(String.init)
        guard parts.count == 3, let nav = tabs.viewControllers?.first as? UINavigationController else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if parts[0] == "dm" { nav.pushViewController(ChatViewController(.direct(parts[1]), title: parts[2]), animated: false) }
            if parts[0] == "server" { nav.pushViewController(ServerViewController(id: parts[1], name: parts[2]), animated: false) }
        }
    }
}
#endif
