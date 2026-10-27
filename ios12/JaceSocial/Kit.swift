import UIKit

/// The website's dark theme (server/app/globals.css).
enum Theme {
    static let bg = hex(0x111317)
    static let bg2 = hex(0x16181d)
    static let panel = hex(0x1c1f26)
    static let line = hex(0x2a2e37)
    static let text = hex(0xe6e8ec)
    static let muted = hex(0x8b919c)
    static let green = hex(0x3ddc84)
    static let onGreen = hex(0x0c1410)
    static let red = hex(0xe0605a)
    static let yellow = hex(0xe0b44a)

    static func hex(_ n: Int) -> UIColor {
        UIColor(red: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1)
    }

    static func status(_ s: String?) -> UIColor {
        switch s ?? "offline" {
        case "online": return green
        case "idle": return yellow
        case "dnd": return red
        default: return hex(0x6b717c)
        }
    }

    /// Bars, lists and buttons app-wide.
    static func apply() {
        let nav = UINavigationBar.appearance()
        nav.barStyle = .black
        nav.barTintColor = bg2
        nav.isTranslucent = false
        nav.tintColor = green
        nav.titleTextAttributes = [.foregroundColor: text]
        nav.largeTitleTextAttributes = [.foregroundColor: text]
        let tab = UITabBar.appearance()
        tab.barStyle = .black
        tab.barTintColor = bg2
        tab.isTranslucent = false
        tab.tintColor = green
        UITableView.appearance().backgroundColor = bg
        UITableView.appearance().separatorColor = line
        UITableViewCell.appearance().backgroundColor = bg
        UISwitch.appearance().onTintColor = green
    }
}

// --- pictures (profile pictures, icons, photos in messages), kept in memory and on disk

final class Images {
    static let shared = Images()
    private let memory = NSCache<NSString, UIImage>()
    private var waiting: [String: [(UIImage?) -> Void]] = [:]
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 100 << 20, diskPath: "images")
        c.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: c)
    }()

    /// The picture at this address (on the main thread), or nil.
    func load(_ url: String, _ done: @escaping (UIImage?) -> Void) {
        if let i = memory.object(forKey: url as NSString) { done(i); return }
        if waiting[url] != nil { waiting[url]!.append(done); return }
        waiting[url] = [done]
        guard let u = URL(string: url) else { finish(url, nil); return }
        session.dataTask(with: u) { data, _, _ in
            let image = data.flatMap { UIImage(data: $0) }
            DispatchQueue.main.async {
                if let i = image { self.memory.setObject(i, forKey: url as NSString) }
                self.finish(url, image)
            }
        }.resume()
    }

    private func finish(_ url: String, _ image: UIImage?) {
        let list = waiting.removeValue(forKey: url) ?? []
        list.forEach { $0(image) }
    }
}

/// A round picture with the person's (or server's) first letter until it loads.
final class AvatarView: UIView {
    private let label = UILabel()
    private let image = UIImageView()
    private var url: String?
    private let dot = UIView()

    init(size: CGFloat) {
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
        backgroundColor = Theme.panel
        layer.cornerRadius = size / 2
        label.textAlignment = .center
        label.textColor = Theme.text
        label.font = .boldSystemFont(ofSize: size * 0.42)
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        image.layer.cornerRadius = size / 2
        for v in [label, image] {
            v.frame = bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(v)
        }
        let d = size * 0.3
        dot.frame = CGRect(x: size - d + 1, y: size - d + 1, width: d, height: d)
        dot.layer.cornerRadius = d / 2
        dot.layer.borderWidth = 2
        dot.layer.borderColor = Theme.bg.cgColor
        dot.isHidden = true
        addSubview(dot)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(name: String, url: String?, status: String? = nil) {
        label.text = name.first.map { String($0).uppercased() } ?? "?"
        image.image = nil
        self.url = url
        if let u = url, !u.isEmpty {
            Images.shared.load(u) { [weak self] img in
                guard let self = self, self.url == u else { return }
                self.image.image = img
            }
        }
        dot.isHidden = status == nil
        dot.backgroundColor = Theme.status(status)
    }
}

// --- small helpers

extension UIViewController {
    func alert(_ title: String, _ message: String? = nil) {
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a, animated: true)
    }

    func showError(_ e: ApiError?) {
        if let e = e { alert("Something went wrong", e.message) }
    }

    /// Ask for one line of text.
    func ask(_ title: String, message: String? = nil, placeholder: String = "", text: String = "", button: String = "OK",
             _ done: @escaping (String) -> Void) {
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addTextField { f in
            f.placeholder = placeholder
            f.text = text
            f.autocapitalizationType = .none
            f.autocorrectionType = .no
        }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        a.addAction(UIAlertAction(title: button, style: .default) { _ in
            let t = (a.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { done(t) }
        })
        present(a, animated: true)
    }
}

enum Time {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func date(_ s: String?) -> Date? {
        guard let s = s else { return nil }
        return iso.date(from: s) ?? isoPlain.date(from: s)
    }

    /// "3:41 PM", "Yesterday 3:41 PM" or "Oct 12, 3:41 PM"
    static func label(_ s: String?) -> String {
        guard let d = date(s) else { return "" }
        let time = DateFormatter.localizedString(from: d, dateStyle: .none, timeStyle: .short)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return time }
        if cal.isDateInYesterday(d) { return "Yesterday \(time)" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return "\(f.string(from: d)), \(time)"
    }
}

/// A list row: picture, name, a line under it, and an unread count.
final class PersonCell: UITableViewCell {
    static let id = "person"
    let avatar = AvatarView(size: 40)
    let title = UILabel()
    let subtitle = UILabel()
    let badge = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = Theme.bg
        let selected = UIView()
        selected.backgroundColor = Theme.panel
        selectedBackgroundView = selected
        title.textColor = Theme.text
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        subtitle.textColor = Theme.muted
        subtitle.font = .systemFont(ofSize: 13)
        badge.textColor = Theme.onGreen
        badge.backgroundColor = Theme.red
        badge.font = .boldSystemFont(ofSize: 12)
        badge.textAlignment = .center
        badge.layer.cornerRadius = 10
        badge.clipsToBounds = true
        let text = UIStackView(arrangedSubviews: [title, subtitle])
        text.axis = .vertical
        text.spacing = 2
        let row = UIStackView(arrangedSubviews: [avatar, text, badge])
        row.alignment = .center
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(row)
        badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 20).isActive = true
        badge.heightAnchor.constraint(equalToConstant: 20).isActive = true
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(name: String, picture: String?, line: String?, unread: Int = 0, status: String? = nil) {
        avatar.show(name: name, url: picture, status: status)
        title.text = name
        subtitle.text = line
        subtitle.isHidden = (line ?? "").isEmpty
        badge.text = unread > 99 ? " 99+ " : " \(unread) "
        badge.isHidden = unread == 0
        badge.textColor = .white
    }
}

/// A bar button that runs a closure (target-action without a selector for each one).
final class BarButton: UIBarButtonItem {
    private var run: () -> Void = {}
    convenience init(_ title: String, _ run: @escaping () -> Void) {
        self.init(title: title, style: .plain, target: nil, action: nil)
        self.run = run
        target = self
        action = #selector(tapped)
    }
    @objc private func tapped() { run() }
}
