import UIKit

/// The Chats tab: direct messages (friends and people who message you), group chats and servers,
/// each with its unread count. Live events reload it.
final class ChatsViewController: UITableViewController {
    private enum Section: Int, CaseIterable { case direct, groups, servers }
    private var people: [Person] = []
    private var groups: [Group] = []
    private var servers: [ServerItem] = []
    private var reloadTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Chats"
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
        tableView.tableFooterView = UIView()
        refreshControl = UIRefreshControl()
        refreshControl?.tintColor = Theme.muted
        refreshControl?.addTarget(self, action: #selector(load), for: .valueChanged)
        NotificationCenter.default.addObserver(self, selector: #selector(live(_:)), name: LiveEvent.notification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(load), name: UIApplication.didBecomeActiveNotification, object: nil)
        load()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()                                   // (unread counts after reading a chat)
    }

    @objc private func live(_ n: Notification) {
        guard let e = n.object as? LiveEvent,
              ["message", "channel", "friends", "groups", "servers", "presence", "reconnected"].contains(e.event) else { return }
        reloadTimer?.invalidate()                // a burst of events: one reload
        reloadTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in self?.load() }
    }

    @objc private func load() {
        let api = Session.shared.api
        let wait = DispatchGroup()
        var error: ApiError?
        wait.enter()
        api.friends { [weak self] r in
            switch r {
            case .success(let f):
                let all = (f.friends ?? []) + (f.others ?? [])
                self?.people = all.sorted { ($0.unread ?? 0, $0.online == true ? 1 : 0) > ($1.unread ?? 0, $1.online == true ? 1 : 0) }
            case .failure(let e): error = e
            }
            wait.leave()
        }
        wait.enter()
        api.groups { [weak self] r in
            if case .success(let g) = r { self?.groups = g }
            wait.leave()
        }
        wait.enter()
        api.servers { [weak self] r in
            if case .success(let s) = r { self?.servers = s }
            wait.leave()
        }
        wait.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            self.refreshControl?.endRefreshing()
            self.tableView.reloadData()
            let unread = self.people.reduce(0) { $0 + ($1.unread ?? 0) } + self.groups.reduce(0) { $0 + ($1.unread ?? 0) }
            self.navigationController?.tabBarItem.badgeValue = unread > 0 ? String(unread) : nil
            UIApplication.shared.applicationIconBadgeNumber = unread
            if let e = error, self.people.isEmpty, e.status != 401 { self.alert("Couldn't load your chats", e.message) }
        }
    }

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch Section(rawValue: section)! {
        case .direct: return people.count
        case .groups: return groups.count
        case .servers: return servers.count
        }
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .direct: return people.isEmpty ? nil : "Direct messages"
        case .groups: return groups.isEmpty ? nil : "Group chats"
        case .servers: return servers.isEmpty ? nil : "Servers"
        }
    }

    override func tableView(_ tableView: UITableView, willDisplayHeaderView view: UIView, forSection section: Int) {
        (view as? UITableViewHeaderFooterView)?.textLabel?.textColor = Theme.muted
        (view as? UITableViewHeaderFooterView)?.backgroundView?.backgroundColor = Theme.bg2
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
        switch Section(rawValue: indexPath.section)! {
        case .direct:
            let p = people[indexPath.row]
            cell.show(name: p.shownName, picture: p.avatar_url, line: p.statusText, unread: p.unread ?? 0, status: p.status ?? "offline")
        case .groups:
            let g = groups[indexPath.row]
            cell.show(name: g.name ?? "Group chat", picture: g.icon_url, line: "\((g.members ?? []).count) members", unread: g.unread ?? 0)
        case .servers:
            let s = servers[indexPath.row]
            cell.show(name: s.name ?? "Server", picture: s.icon_url, line: nil, unread: s.unread ?? 0)
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let next: UIViewController
        switch Section(rawValue: indexPath.section)! {
        case .direct:
            let p = people[indexPath.row]
            next = ChatViewController(.direct(p.uuid), title: p.shownName)
        case .groups:
            let g = groups[indexPath.row]
            next = ChatViewController(.channel(g.id), title: g.name ?? "Group chat")
        case .servers:
            let s = servers[indexPath.row]
            next = ServerViewController(id: s.id, name: s.name ?? "Server")
        }
        navigationController?.pushViewController(next, animated: true)
    }
}

/// A server: its text channels, by category. Tap one to chat in it.
final class ServerViewController: UITableViewController {
    private let id: String
    private var sections: [(name: String?, channels: [Channel])] = []

    init(id: String, name: String) {
        self.id = id
        super.init(style: .plain)
        title = name
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.tableFooterView = UIView()
        refreshControl = UIRefreshControl()
        refreshControl?.tintColor = Theme.muted
        refreshControl?.addTarget(self, action: #selector(load), for: .valueChanged)
        NotificationCenter.default.addObserver(self, selector: #selector(live(_:)), name: LiveEvent.notification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    @objc private func live(_ n: Notification) {
        guard let e = n.object as? LiveEvent, e.event == "servers" || e.event == "reconnected" || (e.event == "channel" && e.str("server_id") == id) else { return }
        load()
    }

    @objc private func load() {
        Session.shared.api.server(id) { [weak self] r in
            guard let self = self else { return }
            self.refreshControl?.endRefreshing()
            switch r {
            case .failure(let e): self.showError(e)
            case .success(let d):
                self.title = d.server.name ?? self.title
                let all = (d.channels ?? []).sorted { ($0.position ?? 0) < ($1.position ?? 0) }
                let text = all.filter { ["text", "announcement", nil].contains($0.kind) }
                var out: [(name: String?, channels: [Channel])] = [(nil, text.filter { $0.parent_id == nil })]
                for cat in all where cat.kind == "category" {
                    out.append((cat.name, text.filter { $0.parent_id == cat.id }))
                }
                self.sections = out.filter { !$0.channels.isEmpty }
                self.tableView.reloadData()
            }
        }
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].channels.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].name?.uppercased() }

    override func tableView(_ tableView: UITableView, willDisplayHeaderView view: UIView, forSection section: Int) {
        (view as? UITableViewHeaderFooterView)?.textLabel?.textColor = Theme.muted
        (view as? UITableViewHeaderFooterView)?.backgroundView?.backgroundColor = Theme.bg2
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let c = tableView.dequeueReusableCell(withIdentifier: "channel") ?? UITableViewCell(style: .value1, reuseIdentifier: "channel")
        let ch = sections[indexPath.section].channels[indexPath.row]
        let unread = ch.unread ?? 0
        c.backgroundColor = Theme.bg
        c.textLabel?.text = (ch.kind == "announcement" ? "📢 " : "# ") + (ch.name ?? "channel")
        c.textLabel?.textColor = unread > 0 ? Theme.text : Theme.muted
        c.textLabel?.font = unread > 0 ? .boldSystemFont(ofSize: 16) : .systemFont(ofSize: 16)
        c.detailTextLabel?.text = unread > 0 ? String(unread) : nil
        c.detailTextLabel?.textColor = Theme.red
        let selected = UIView()
        selected.backgroundColor = Theme.panel
        c.selectedBackgroundView = selected
        return c
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let ch = sections[indexPath.section].channels[indexPath.row]
        navigationController?.pushViewController(ChatViewController(.channel(ch.id), title: "#" + (ch.name ?? "channel")), animated: true)
    }
}
