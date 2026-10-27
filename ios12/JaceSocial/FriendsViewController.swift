import UIKit

/// The Friends tab: requests to answer, your friends (online first), and requests you sent.
/// + adds a friend by @handle or Minecraft name.
final class FriendsViewController: UITableViewController {
    private var incoming: [Person] = []
    private var friends: [Person] = []
    private var outgoing: [Person] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Friends"
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
        tableView.tableFooterView = UIView()
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(add))
        refreshControl = UIRefreshControl()
        refreshControl?.tintColor = Theme.muted
        refreshControl?.addTarget(self, action: #selector(load), for: .valueChanged)
        NotificationCenter.default.addObserver(self, selector: #selector(live(_:)), name: LiveEvent.notification, object: nil)
        load()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    @objc private func live(_ n: Notification) {
        guard let e = n.object as? LiveEvent, ["friends", "presence", "reconnected"].contains(e.event) else { return }
        load()
    }

    @objc private func load() {
        Session.shared.api.friends { [weak self] r in
            guard let self = self else { return }
            self.refreshControl?.endRefreshing()
            guard case .success(let f) = r else { return }
            self.incoming = f.incoming ?? []
            self.friends = (f.friends ?? []).sorted {
                ($0.online == true ? 0 : 1, $0.shownName.lowercased()) < ($1.online == true ? 0 : 1, $1.shownName.lowercased())
            }
            self.outgoing = f.outgoing ?? []
            self.navigationController?.tabBarItem.badgeValue = self.incoming.isEmpty ? nil : String(self.incoming.count)
            self.tableView.reloadData()
        }
    }

    @objc private func add() {
        ask("Add a friend", message: "Their @handle, or their Minecraft name", placeholder: "@handle", button: "Send request") { [weak self] name in
            Session.shared.api.addFriend(name) { r in
                switch r {
                case .success(let status): self?.alert(status == "accepted" ? "You're friends now!" : "Friend request sent")
                case .failure(let e): self?.showError(e)
                }
                self?.load()
            }
        }
    }

    private func list(_ section: Int) -> [Person] { [incoming, friends, outgoing][section] }

    override func numberOfSections(in tableView: UITableView) -> Int { 3 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { list(section).count }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        let n = list(section).count
        if n == 0 { return section == 1 && incoming.isEmpty && outgoing.isEmpty ? "No friends yet - tap + to add one" : nil }
        return ["Friend requests (\(n))", "Friends (\(n))", "Sent (\(n))"][section]
    }

    override func tableView(_ tableView: UITableView, willDisplayHeaderView view: UIView, forSection section: Int) {
        (view as? UITableViewHeaderFooterView)?.textLabel?.textColor = Theme.muted
        (view as? UITableViewHeaderFooterView)?.backgroundView?.backgroundColor = Theme.bg2
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
        let p = list(indexPath.section)[indexPath.row]
        let line = ["Wants to be friends - tap to answer", p.statusText, "Waiting for them to accept"][indexPath.section]
        cell.show(name: p.shownName, picture: p.avatar_url, line: line, status: indexPath.section == 1 ? (p.status ?? "offline") : nil)
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let p = list(indexPath.section)[indexPath.row]
        let api = Session.shared.api
        let sheet = UIAlertController(title: p.shownName, message: p.handle.map { "@\($0)" }, preferredStyle: .actionSheet)
        switch indexPath.section {
        case 0:
            sheet.addAction(UIAlertAction(title: "Accept", style: .default) { _ in api.respondFriend(p.uuid, accept: true) { [weak self] e in self?.showError(e); self?.load() } })
            sheet.addAction(UIAlertAction(title: "Decline", style: .destructive) { _ in api.respondFriend(p.uuid, accept: false) { [weak self] e in self?.showError(e); self?.load() } })
        case 1:
            sheet.addAction(UIAlertAction(title: "Message", style: .default) { [weak self] _ in
                self?.navigationController?.pushViewController(ChatViewController(.direct(p.uuid), title: p.shownName), animated: true)
            })
            sheet.addAction(UIAlertAction(title: "Remove friend", style: .destructive) { [weak self] _ in
                self?.confirm("Remove \(p.shownName) as a friend?") { api.removeFriend(p.uuid) { e in self?.showError(e); self?.load() } }
            })
        default:
            sheet.addAction(UIAlertAction(title: "Cancel request", style: .destructive) { _ in api.removeFriend(p.uuid) { [weak self] e in self?.showError(e); self?.load() } })
        }
        sheet.addAction(UIAlertAction(title: "Close", style: .cancel))
        sheet.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)
        present(sheet, animated: true)
    }
}

/// The You tab: your picture, name and status, and signing out.
final class YouViewController: UITableViewController {
    private let statuses = [("online", "Online"), ("idle", "Idle"), ("dnd", "Do not disturb"), ("invisible", "Invisible")]

    init() { super.init(style: .grouped) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "You"
        tableView.backgroundColor = Theme.bg
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
        NotificationCenter.default.addObserver(self, selector: #selector(reload), name: LiveEvent.notification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Session.shared.loadMe { [weak self] _ in self?.tableView.reloadData() }
    }

    @objc private func reload() { tableView.reloadData() }

    override func numberOfSections(in tableView: UITableView) -> Int { 3 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { [1, 2, 2][section] }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == 2 ? "Jace Social \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") for iOS 12. More (voice calls, servers' settings, bots) is on the website and the newer app." : nil
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let me = Session.shared.me
        if indexPath.section == 0 {
            let c = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
            c.show(name: me?.shownName ?? "…", picture: me?.avatar_url, line: me?.handle.map { "@\($0)" } ?? "", status: me?.status ?? "online")
            c.backgroundColor = Theme.panel
            c.selectionStyle = .none
            return c
        }
        let c = UITableViewCell(style: .value1, reuseIdentifier: nil)
        c.backgroundColor = Theme.panel
        c.textLabel?.textColor = Theme.text
        c.detailTextLabel?.textColor = Theme.muted
        switch (indexPath.section, indexPath.row) {
        case (1, 0):
            c.textLabel?.text = "Status"
            c.detailTextLabel?.text = statuses.first { $0.0 == (me?.status ?? "online") }?.1 ?? "Online"
            c.accessoryType = .disclosureIndicator
        case (1, 1):
            c.textLabel?.text = "Custom status"
            c.detailTextLabel?.text = [me?.status_emoji, me?.custom_status].compactMap { $0 }.joined(separator: " ")
            c.accessoryType = .disclosureIndicator
        case (2, 0):
            c.textLabel?.text = "Display name"
            c.detailTextLabel?.text = me?.shownName
            c.accessoryType = .disclosureIndicator
        default:
            c.textLabel?.text = "Sign out"
            c.textLabel?.textColor = Theme.red
        }
        return c
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let me = Session.shared.me
        switch (indexPath.section, indexPath.row) {
        case (1, 0):
            let sheet = UIAlertController(title: "Status", message: nil, preferredStyle: .actionSheet)
            for (value, name) in statuses {
                sheet.addAction(UIAlertAction(title: name, style: .default) { [weak self] _ in self?.save(["status": value]) })
            }
            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            sheet.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)
            present(sheet, animated: true)
        case (1, 1):
            let a = UIAlertController(title: "Custom status", message: "What you're up to (empty clears it)", preferredStyle: .alert)
            a.addTextField { $0.text = me?.custom_status; $0.placeholder = "Building a castle" }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            a.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
                let t = (a.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespaces)
                self?.save(["custom_status": t.isEmpty ? NSNull() as Any : t])
            })
            present(a, animated: true)
        case (2, 0):
            ask("Display name", message: "What friends see", text: me?.display_name ?? "", button: "Save") { [weak self] name in
                self?.save(["display_name": name])
            }
        case (2, 1):
            confirm("Sign out of Jace Social on this phone?", button: "Sign out") { Session.shared.signOut() }
        default: break
        }
    }

    private func save(_ fields: [String: Any]) {
        Session.shared.api.updateMe(fields) { [weak self] r in
            switch r {
            case .success(let me): Session.shared.setMe(me)
            case .failure(let e): self?.showError(e)
            }
            self?.tableView.reloadData()
        }
    }
}

extension UIViewController {
    /// "Are you sure?" with a red button.
    func confirm(_ title: String, button: String = "Remove", _ yes: @escaping () -> Void) {
        let a = UIAlertController(title: title, message: nil, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        a.addAction(UIAlertAction(title: button, style: .destructive) { _ in yes() })
        present(a, animated: true)
    }
}
