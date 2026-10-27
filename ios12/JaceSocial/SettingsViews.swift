import UIKit

/// A settings row: a title, a value on the right, and what tapping it does.
struct Row {
    var title: String
    var value: String? = nil
    var red = false
    var picture: (name: String, url: String?)? = nil
    var tap: (() -> Void)? = nil
}

/// A grouped list of rows (the settings screens are made of these).
class RowsViewController: UITableViewController {
    var sections: [(title: String?, rows: [Row])] = []

    init() { super.init(style: .grouped) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = Theme.bg
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].rows.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].title }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = sections[indexPath.section].rows[indexPath.row]
        if let pic = row.picture {
            let c = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
            c.show(name: pic.name, picture: pic.url, line: row.value)
            c.backgroundColor = Theme.panel
            c.selectionStyle = row.tap == nil ? .none : .default
            return c
        }
        let c = UITableViewCell(style: .value1, reuseIdentifier: nil)
        c.backgroundColor = Theme.panel
        c.textLabel?.text = row.title
        c.textLabel?.textColor = row.red ? Theme.red : Theme.text
        c.textLabel?.numberOfLines = 0
        c.detailTextLabel?.text = row.value
        c.detailTextLabel?.textColor = Theme.muted
        c.accessoryType = row.tap != nil && !row.red ? .disclosureIndicator : .none
        c.selectionStyle = row.tap == nil ? .none : .default
        return c
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        sections[indexPath.section].rows[indexPath.row].tap?()
    }

    /// Save, then reload (or show what went wrong).
    func saved(_ reload: @escaping () -> Void) -> (ApiError?) -> Void {
        return { [weak self] e in
            if let e = e { self?.showError(e) }
            reload()
        }
    }

    /// Pick a photo (for an icon or picture) -> JPEG data.
    func pickPicture(_ done: @escaping (Data) -> Void) {
        let p = ImagePicker.shared
        p.done = { image in if let d = image.fitting(512).jpegData(compressionQuality: 0.85) { done(d) } }
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.delegate = p
        present(picker, animated: true)
    }
}

final class ImagePicker: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    static let shared = ImagePicker()
    var done: (UIImage) -> Void = { _ in }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        if let i = info[.originalImage] as? UIImage { done(i) }
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { picker.dismiss(animated: true) }
}

// MARK: - picking friends

/// Tick friends, then the button (new group chat, adding people to one).
final class PickPeopleViewController: UITableViewController {
    private var people: [Person] = []
    private var picked = Set<String>()
    private let done: ([Person]) -> Void
    private let leaveOut: Set<String>

    init(title: String, button: String, leaveOut: Set<String> = [], _ done: @escaping ([Person]) -> Void) {
        self.done = done
        self.leaveOut = leaveOut
        super.init(style: .plain)
        self.title = title
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: button, style: .done, target: nil, action: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem?.target = self
        navigationItem.rightBarButtonItem?.action = #selector(finish)
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
        tableView.tableFooterView = UIView()
        Session.shared.api.friends { [weak self] r in
            guard let self = self, case .success(let f) = r else { return }
            self.people = (f.friends ?? []).filter { !self.leaveOut.contains($0.uuid) }.sorted { $0.shownName.lowercased() < $1.shownName.lowercased() }
            self.tableView.reloadData()
        }
    }

    @objc private func finish() {
        let list = people.filter { picked.contains($0.uuid) }
        if list.isEmpty { alert("Pick at least one friend"); return }
        done(list)
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { people.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let c = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
        let p = people[indexPath.row]
        c.show(name: p.shownName, picture: p.avatar_url, line: p.handle.map { "@\($0)" })
        c.accessoryType = picked.contains(p.uuid) ? .checkmark : .none
        c.tintColor = Theme.green
        return c
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let id = people[indexPath.row].uuid
        if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
        tableView.reloadRows(at: [indexPath], with: .none)
    }
}

// MARK: - a group chat's settings

final class GroupSettingsViewController: RowsViewController {
    private let id: String
    private var group: Group?

    init(id: String) {
        self.id = id
        super.init()
        title = "Group chat"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func load() {
        Session.shared.api.groups { [weak self] r in
            guard let self = self, case .success(let all) = r else { return }
            guard let g = all.first(where: { $0.id == self.id }) else { self.navigationController?.popToRootViewController(animated: true); return }
            self.group = g
            self.build()
        }
    }

    private func build() {
        guard let g = group else { return }
        let api = Session.shared.api
        let me = Session.shared.me?.uuid
        let owner = g.owner == me
        let reload: () -> Void = { [weak self] in self?.load() }
        var about = [
            Row(title: "Name", value: g.name, tap: { [weak self] in
                self?.ask("Rename the group", text: g.name ?? "", button: "Save") { name in api.renameGroup(g.id, name, self?.saved(reload) ?? { _ in }) }
            }),
            Row(title: "Picture", value: "Change", tap: { [weak self] in
                self?.pickPicture { d in api.raw("/groups/\(g.id)/icon", d, self?.saved(reload) ?? { _ in }) }
            }),
        ]
        about.append(Row(title: "Add people", tap: { [weak self] in
            let inside = Set((g.members ?? []).map { $0.uuid })
            self?.navigationController?.pushViewController(PickPeopleViewController(title: "Add people", button: "Add", leaveOut: inside) { picked in
                let wait = DispatchGroup()
                var error: ApiError?
                for p in picked {
                    wait.enter()
                    api.addToGroup(g.id, p.uuid) { e in if e != nil { error = e }; wait.leave() }
                }
                wait.notify(queue: .main) {
                    self?.navigationController?.popViewController(animated: true)
                    self?.showError(error)
                    reload()
                }
            }, animated: true)
        }))
        let members = (g.members ?? []).map { p -> Row in
            var tap: (() -> Void)?
            if owner && p.uuid != me {
                tap = { [weak self] in
                    self?.confirm("Remove \(p.shownName) from the group?") { api.removeFromGroup(g.id, p.uuid, self?.saved(reload) ?? { _ in }) }
                }
            }
            return Row(title: p.shownName, value: p.uuid == g.owner ? "Owner" : nil, picture: (p.shownName, p.avatar_url), tap: tap)
        }
        sections = [
            (nil, about),
            ("Members (\(members.count))", members),
            (nil, [Row(title: "Leave the group", red: true, tap: { [weak self] in
                guard let me = me else { return }
                self?.confirm("Leave \(g.name ?? "this group")?", button: "Leave") {
                    api.removeFromGroup(g.id, me) { e in
                        if let e = e { self?.showError(e) } else { self?.navigationController?.popToRootViewController(animated: true) }
                    }
                }
            })]),
        ]
        tableView.reloadData()
    }
}

// MARK: - a server's settings

final class ServerSettingsViewController: RowsViewController {
    private let id: String
    private var detail: ServerDetail?

    init(id: String) {
        self.id = id
        super.init()
        title = "Server settings"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func load() {
        Session.shared.api.server(id) { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .success(let d): self.detail = d; self.build()
            case .failure(let e): self.showError(e)
            }
        }
    }

    private func build() {
        guard let d = detail else { return }
        let api = Session.shared.api
        let s = d.server
        let can = { (bit: Int) in d.owner == true || P.has(d.can, bit) }
        let reload: () -> Void = { [weak self] in self?.load() }
        sections = []
        if can(P.MANAGE_SERVER) {
            sections.append(("Overview", [
                Row(title: "Name", value: s.name, tap: { [weak self] in
                    self?.ask("Server name", text: s.name ?? "", button: "Save") { name in api.updateServer(s.id, ["name": name], self?.saved(reload) ?? { _ in }) }
                }),
                Row(title: "Description", value: (s.description ?? "").isEmpty ? "Add one" : s.description, tap: { [weak self] in
                    self?.ask("Description", text: s.description ?? "", button: "Save") { text in api.updateServer(s.id, ["description": text], self?.saved(reload) ?? { _ in }) }
                }),
                Row(title: "Icon", value: "Change", tap: { [weak self] in
                    self?.pickPicture { data in api.raw("/servers/\(s.id)/icon", data, self?.saved(reload) ?? { _ in }) }
                }),
            ]))
        }
        var manage: [Row] = []
        if can(P.MANAGE_CHANNELS) {
            manage.append(Row(title: "Channels", value: "\((d.channels ?? []).count)", tap: { [weak self] in
                guard let self = self else { return }
                self.navigationController?.pushViewController(ChannelsViewController(id: self.id), animated: true)
            }))
        }
        if can(P.MANAGE_ROLES) {
            manage.append(Row(title: "Roles", value: "\((d.roles ?? []).count)", tap: { [weak self] in
                guard let self = self else { return }
                self.navigationController?.pushViewController(RolesViewController(id: self.id), animated: true)
            }))
        }
        manage.append(Row(title: "Members", value: "\((d.members ?? []).count)", tap: { [weak self] in
            guard let self = self else { return }
            self.navigationController?.pushViewController(MembersViewController(id: self.id), animated: true)
        }))
        if can(P.BAN) {
            manage.append(Row(title: "Bans", tap: { [weak self] in
                guard let self = self else { return }
                self.navigationController?.pushViewController(BansViewController(id: self.id), animated: true)
            }))
        }
        if can(P.MANAGE_BOTS) {
            manage.append(Row(title: "Add one of your bots", tap: { [weak self] in
                api.bots { r in
                    guard let self = self, case .success(let bots) = r else { return }
                    if bots.isEmpty { self.alert("You have no bots yet", "Make one in You → Bots"); return }
                    let sheet = UIAlertController(title: "Add a bot", message: nil, preferredStyle: .actionSheet)
                    for b in bots {
                        sheet.addAction(UIAlertAction(title: b.name ?? "Bot", style: .default) { _ in
                            api.addBot(s.id, b.uuid) { e in if let e = e { self.showError(e) } else { self.alert("Added \(b.name ?? "the bot")") } }
                        })
                    }
                    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
                    sheet.popoverPresentationController?.sourceView = self.view
                    self.present(sheet, animated: true)
                }
            }))
        }
        sections.append(("Manage", manage))
        if d.owner == true {
            sections.append((nil, [Row(title: "Delete server", red: true, tap: { [weak self] in
                self?.confirm("Delete \(s.name ?? "this server") for everyone? This can't be undone.", button: "Delete") {
                    api.deleteServer(s.id) { e in
                        if let e = e { self?.showError(e) } else { self?.navigationController?.popToRootViewController(animated: true) }
                    }
                }
            })]))
        }
        tableView.reloadData()
    }
}

/// A server's channels: tap one to rename it, change its topic or delete it; + makes one.
final class ChannelsViewController: RowsViewController {
    private let id: String

    init(id: String) {
        self.id = id
        super.init()
        title = "Channels"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(add))
        load()
    }

    @objc private func add() {
        let sheet = UIAlertController(title: "New channel", message: nil, preferredStyle: .actionSheet)
        for (kind, name) in [("text", "Text channel"), ("voice", "Voice channel"), ("announcement", "Announcement channel"), ("category", "Category")] {
            sheet.addAction(UIAlertAction(title: name, style: .default) { [weak self] _ in
                guard let self = self else { return }
                self.ask(name, placeholder: "name", button: "Create") { n in
                    Session.shared.api.createChannel(self.id, n, kind: kind, self.saved { self.load() })
                }
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(sheet, animated: true)
    }

    private func load() {
        Session.shared.api.server(id) { [weak self] r in
            guard let self = self, case .success(let d) = r else { return }
            let api = Session.shared.api
            let reload: () -> Void = { [weak self] in self?.load() }
            let all = (d.channels ?? []).sorted { ($0.position ?? 0) < ($1.position ?? 0) }
            let rows = all.map { ch -> Row in
                let icon = ["voice": "🔊", "announcement": "📢", "category": "📁"][ch.kind ?? "text"] ?? "#"
                return Row(title: "\(icon) \(ch.name ?? "")", value: ch.topic, tap: { [weak self] in
                    let sheet = UIAlertController(title: ch.name, message: nil, preferredStyle: .actionSheet)
                    sheet.addAction(UIAlertAction(title: "Rename", style: .default) { _ in
                        self?.ask("Rename", text: ch.name ?? "", button: "Save") { n in api.updateChannel(ch.id, ["name": n], self?.saved(reload) ?? { _ in }) }
                    })
                    if ch.kind != "category" && ch.kind != "voice" {
                        sheet.addAction(UIAlertAction(title: "Topic", style: .default) { _ in
                            self?.ask("Topic", text: ch.topic ?? "", button: "Save") { t in api.updateChannel(ch.id, ["topic": t], self?.saved(reload) ?? { _ in }) }
                        })
                    }
                    sheet.addAction(UIAlertAction(title: "Delete", style: .destructive) { _ in
                        self?.confirm("Delete \(ch.name ?? "this channel")?", button: "Delete") { api.deleteChannel(ch.id, self?.saved(reload) ?? { _ in }) }
                    })
                    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
                    sheet.popoverPresentationController?.sourceView = self?.view
                    self?.present(sheet, animated: true)
                })
            }
            self.sections = [(nil, rows)]
            self.tableView.reloadData()
        }
    }
}

/// A server's roles, top first; + makes one.
final class RolesViewController: RowsViewController {
    private let id: String

    init(id: String) {
        self.id = id
        super.init()
        title = "Roles"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(add))
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    @objc private func add() {
        ask("New role", placeholder: "name", button: "Create") { [weak self] name in
            guard let self = self else { return }
            Session.shared.api.createRole(self.id, name, self.saved { self.load() })
        }
    }

    private func load() {
        Session.shared.api.server(id) { [weak self] r in
            guard let self = self, case .success(let d) = r else { return }
            let roles = (d.roles ?? []).sorted { ($0.position ?? 0) > ($1.position ?? 0) }
            self.sections = [(nil, roles.map { role in
                Row(title: role.is_default == true ? "@everyone" : (role.name ?? "role"), value: role.color, tap: { [weak self] in
                    guard let self = self else { return }
                    self.navigationController?.pushViewController(RoleViewController(server: self.id, role: role), animated: true)
                })
            })]
            self.tableView.reloadData()
        }
    }
}

/// One role: its name, color and permissions (switches).
final class RoleViewController: UITableViewController {
    private let server: String
    private var role: Role

    init(server: String, role: Role) {
        self.server = server
        self.role = role
        super.init(style: .grouped)
        title = role.is_default == true ? "@everyone" : role.name
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = Theme.bg
    }

    private var editable: Bool { role.is_default != true }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? (editable ? 3 : 0) : P.named.count
    }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 1 ? "Permissions" : nil }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let c = UITableViewCell(style: .value1, reuseIdentifier: nil)
        c.backgroundColor = Theme.panel
        c.textLabel?.textColor = Theme.text
        c.detailTextLabel?.textColor = Theme.muted
        if indexPath.section == 0 {
            c.textLabel?.text = ["Name", "Color", "Delete role"][indexPath.row]
            c.detailTextLabel?.text = [role.name, role.color ?? "None", nil][indexPath.row]
            if indexPath.row == 2 { c.textLabel?.textColor = Theme.red }
            return c
        }
        let (bit, name) = P.named[indexPath.row]
        c.textLabel?.text = name
        c.selectionStyle = .none
        let s = UISwitch()
        s.isOn = (role.permissions ?? 0) & bit == bit
        s.tag = bit
        s.addTarget(self, action: #selector(flip(_:)), for: .valueChanged)
        c.accessoryView = s
        return c
    }

    @objc private func flip(_ s: UISwitch) {
        var perms = role.permissions ?? 0
        if s.isOn { perms |= s.tag } else { perms &= ~s.tag }
        save(["permissions": perms]) { [weak self] in self?.role.permissions = perms }
    }

    private func save(_ fields: [String: Any], _ then: @escaping () -> Void) {
        Session.shared.api.updateRole(server, role.id, fields) { [weak self] e in
            if let e = e { self?.showError(e) } else { then() }
            self?.tableView.reloadData()
        }
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard indexPath.section == 0 else { return }
        switch indexPath.row {
        case 0:
            ask("Role name", text: role.name ?? "", button: "Save") { [weak self] n in self?.save(["name": n]) { self?.role.name = n; self?.title = n } }
        case 1:
            ask("Color", message: "Like #3ddc84 (empty: none)", placeholder: "#3ddc84", text: role.color ?? "", button: "Save") { [weak self] c in
                self?.save(["color": c]) { self?.role.color = c }
            }
        default:
            confirm("Delete \(role.name ?? "this role")?", button: "Delete") { [weak self] in
                guard let self = self else { return }
                Session.shared.api.deleteRole(self.server, self.role.id) { e in
                    if let e = e { self.showError(e) } else { self.navigationController?.popViewController(animated: true) }
                }
            }
        }
    }
}

/// A server's members: tap one to give them roles, kick or ban them.
final class MembersViewController: RowsViewController {
    private let id: String

    init(id: String) {
        self.id = id
        super.init()
        title = "Members"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func load() {
        Session.shared.api.server(id) { [weak self] r in
            guard let self = self, case .success(let d) = r else { return }
            let api = Session.shared.api
            let reload: () -> Void = { [weak self] in self?.load() }
            let roles = (d.roles ?? []).filter { $0.is_default != true }.sorted { ($0.position ?? 0) > ($1.position ?? 0) }
            let can = { (bit: Int) in d.owner == true || P.has(d.can, bit) }
            let me = Session.shared.me?.uuid
            let rows = (d.members ?? []).sorted { $0.shownName.lowercased() < $1.shownName.lowercased() }.map { m -> Row in
                let names = roles.filter { (m.roles ?? []).contains($0.id) }.compactMap { $0.name }.joined(separator: ", ")
                var tap: (() -> Void)?
                if m.uuid != me { tap = { [weak self] in
                    let sheet = UIAlertController(title: m.shownName, message: nil, preferredStyle: .actionSheet)
                    if can(P.MANAGE_ROLES) {
                        for role in roles {
                            let has = (m.roles ?? []).contains(role.id)
                            sheet.addAction(UIAlertAction(title: has ? "✓ \(role.name ?? "role") (take away)" : "Give \(role.name ?? "role")", style: .default) { _ in
                                let now = has ? (m.roles ?? []).filter { $0 != role.id } : (m.roles ?? []) + [role.id]
                                api.updateMember(d.server.id, ["uuid": m.uuid, "roles": now], self?.saved(reload) ?? { _ in })
                            })
                        }
                    }
                    if can(P.KICK) {
                        sheet.addAction(UIAlertAction(title: "Kick", style: .destructive) { _ in
                            self?.confirm("Kick \(m.shownName)? They can join again with an invite.", button: "Kick") {
                                api.removeMember(d.server.id, m.uuid, self?.saved(reload) ?? { _ in })
                            }
                        })
                    }
                    if can(P.BAN) {
                        sheet.addAction(UIAlertAction(title: "Ban", style: .destructive) { _ in
                            self?.ask("Ban \(m.shownName)", message: "Why? (they can't join again)", placeholder: "reason", button: "Ban") { reason in
                                api.ban(d.server.id, m.uuid, reason: reason, self?.saved(reload) ?? { _ in })
                            }
                        })
                    }
                    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
                    sheet.popoverPresentationController?.sourceView = self?.view
                    self?.present(sheet, animated: true)
                } }
                return Row(title: m.shownName, value: names.isEmpty ? m.handle.map { "@\($0)" } : names, picture: (m.shownName, m.avatar_url), tap: tap)
            }
            self.sections = [("\(rows.count) members", rows)]
            self.tableView.reloadData()
        }
    }
}

/// People banned from a server: tap to unban.
final class BansViewController: RowsViewController {
    private let id: String

    init(id: String) {
        self.id = id
        super.init()
        title = "Bans"
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    private func load() {
        Session.shared.api.bans(id) { [weak self] r in
            guard let self = self, case .success(let bans) = r else { return }
            let rows = bans.map { b -> Row in
                let name = b.person?.shownName ?? "Someone"
                return Row(title: name, value: b.reason, picture: (name, b.person?.avatar_url), tap: { [weak self] in
                    guard let self = self else { return }
                    self.confirm("Unban \(name)?", button: "Unban") { Session.shared.api.unban(self.id, b.uuid, self.saved { self.load() }) }
                })
            }
            self.sections = [(rows.isEmpty ? "Nobody is banned" : nil, rows)]
            self.tableView.reloadData()
        }
    }
}
