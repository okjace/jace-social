import UIKit

/// You → Bots: your bots; + makes one.
final class BotsViewController: RowsViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Bots"
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(add))
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    @objc private func add() {
        ask("New bot", message: "Its name (you can change it later)", placeholder: "My bot", button: "Create") { [weak self] name in
            Session.shared.api.createBot(name) { r in
                switch r {
                case .success(let token):
                    self?.showToken(token, intro: "Your bot is made. This is its token - copy it now, it's only shown once. Bot programs sign in with it.")
                case .failure(let e): self?.showError(e)
                }
                self?.load()
            }
        }
    }

    private func load() {
        Session.shared.api.bots { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): self.showError(e)
            case .success(let bots):
                let rows = bots.map { b -> Row in
                    let what = b.has_code == true ? "Runs its code on Jace Social" : "Uses the API (or nothing yet)"
                    return Row(title: b.name ?? "Bot", value: b.bot_enabled == false ? "Off" : what, picture: (b.name ?? "Bot", b.avatar_url), tap: { [weak self] in
                        self?.navigationController?.pushViewController(BotViewController(bot: b), animated: true)
                    })
                }
                self.sections = [(rows.isEmpty ? "No bots yet - tap + to make one" : nil, rows)]
                self.tableView.reloadData()
            }
        }
    }
}

extension UIViewController {
    func showToken(_ token: String, intro: String) {
        let a = UIAlertController(title: "Bot token", message: "\(intro)\n\n\(token)", preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Copy", style: .default) { _ in UIPasteboard.general.string = token })
        a.addAction(UIAlertAction(title: "Done", style: .cancel))
        present(a, animated: true)
    }
}

/// One bot: name, bio, picture, public / on, its token, its code, deleting it.
final class BotViewController: RowsViewController {
    private var bot: Bot

    init(bot: Bot) {
        self.bot = bot
        super.init()
        title = bot.name
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        build()
    }

    private func reload() {
        Session.shared.api.bots { [weak self] r in
            guard let self = self, case .success(let all) = r, let b = all.first(where: { $0.uuid == self.bot.uuid }) else { return }
            self.bot = b
            self.title = b.name
            self.build()
        }
    }

    private func patch(_ fields: [String: Any]) {
        Session.shared.api.updateBot(bot.uuid, fields, saved { [weak self] in self?.reload() })
    }

    private func build() {
        let b = bot
        let api = Session.shared.api
        sections = [
            (nil, [
                Row(title: b.name ?? "Bot", value: "Change picture", picture: (b.name ?? "Bot", b.avatar_url), tap: { [weak self] in
                    self?.pickPicture { d in api.raw("/bots/\(b.uuid)/avatar", d, self?.saved { self?.reload() } ?? { _ in }) }
                }),
                Row(title: "Name", value: b.name, tap: { [weak self] in
                    self?.ask("Bot name", text: b.name ?? "", button: "Save") { n in self?.patch(["name": n]) }
                }),
                Row(title: "About", value: (b.bio ?? "").isEmpty ? "Add a bio" : b.bio, tap: { [weak self] in
                    self?.ask("About this bot", text: b.bio ?? "", button: "Save") { t in self?.patch(["bio": t]) }
                }),
            ]),
            ("Who can use it", [
                Row(title: "Public", value: b.bot_public == true ? "Anyone can add it" : "Only you can add it", tap: { [weak self] in
                    self?.patch(["bot_public": b.bot_public != true])
                }),
                Row(title: "On", value: b.bot_enabled == false ? "Off - it doesn't answer" : "On", tap: { [weak self] in
                    self?.patch(["bot_enabled": b.bot_enabled == false])
                }),
            ]),
            ("Making it work", [
                Row(title: "Code", value: b.has_code == true ? "Edit" : "Write some", tap: { [weak self] in
                    self?.navigationController?.pushViewController(BotCodeViewController(bot: b), animated: true)
                }),
                Row(title: "New token", value: "For bot programs", tap: { [weak self] in
                    self?.confirm("Make a new token? The old one stops working.", button: "New token") {
                        api.botToken(b.uuid) { r in
                            switch r {
                            case .success(let t): self?.showToken(t, intro: "Copy it now - it's only shown once.")
                            case .failure(let e): self?.showError(e)
                            }
                        }
                    }
                }),
            ]),
            (nil, [Row(title: "Delete bot", red: true, tap: { [weak self] in
                self?.confirm("Delete \(b.name ?? "this bot")? It leaves every server.", button: "Delete") {
                    api.deleteBot(b.uuid) { e in
                        if let e = e { self?.showError(e) } else { self?.navigationController?.popViewController(animated: true) }
                    }
                }
            })]),
        ]
        tableView.reloadData()
    }
}

/// A bot's code (JavaScript, run on Jace Social - docs/bots.md), with Save and Try.
final class BotCodeViewController: UIViewController {
    private let bot: Bot
    private let editor = UITextView()
    private var bottom: NSLayoutConstraint!

    init(bot: Bot) {
        self.bot = bot
        super.init(nibName: nil, bundle: nil)
        title = "Code"
        hidesBottomBarWhenPushed = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        editor.backgroundColor = Theme.bg2
        editor.textColor = Theme.text
        editor.font = UIFont(name: "Menlo", size: 14) ?? .systemFont(ofSize: 14)
        editor.autocapitalizationType = .none
        editor.autocorrectionType = .no
        editor.smartQuotesType = .no
        editor.smartDashesType = .no
        editor.keyboardAppearance = .dark
        editor.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(editor)
        bottom = editor.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        NSLayoutConstraint.activate([
            editor.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            editor.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom,
        ])
        navigationItem.rightBarButtonItems = [BarButton("Save") { [weak self] in self?.save() }, BarButton("Try") { [weak self] in self?.tryIt() }]
        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        Session.shared.api.botCode(bot.uuid) { [weak self] r in
            guard let self = self, case .success(let code) = r else { return }
            self.editor.text = code.isEmpty ? BotCodeViewController.starter : code
        }
    }

    @objc private func keyboard(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY - view.safeAreaInsets.bottom)
        bottom.constant = -overlap
        view.layoutIfNeeded()
    }

    static func describe(_ a: [String: Any]) -> String {
        let s = { (k: String) in a[k] as? String ?? "" }
        switch s("t") {
        case "reply": return "💬 Reply: \(s("text"))"
        case "send": return "💬 Send in #\(s("channel")): \(s("text"))"
        case "react": return "😀 React with \(s("emoji"))"
        case "give_role": return "🏷️ Give the role \(s("role"))"
        case "take_role": return "🏷️ Take the role \(s("role"))"
        case "delete_message": return "🗑️ Delete the message"
        default: return s("t")
        }
    }

    static let starter = """
    // This runs on Jace Social's server whenever something happens where your bot is.
    // It can reply, send messages, react, give roles and remember things (storage).

    bot.on("message", (msg) => {
      if (msg.text.toLowerCase() === "hi bot") msg.reply("Hi " + msg.author.name + "! 👋");
    });

    bot.command("count", "Count up by one", (cmd) => {
      const n = (storage.get("count") || 0) + 1;
      storage.set("count", n);
      cmd.reply("The count is now " + n);
    });
    """

    private func save() {
        Session.shared.api.saveBotCode(bot.uuid, editor.text.isEmpty ? nil : editor.text) { [weak self] r in
            switch r {
            case .success(let commands): self?.alert("Saved", commands.isEmpty ? nil : "Slash commands: " + commands.map { "/\($0)" }.joined(separator: ", "))
            case .failure(let e): self?.showError(e)
            }
        }
    }

    private func tryIt() {
        ask("Try it", message: "A pretend message, or a /command", placeholder: "hi", button: "Run") { [weak self] text in
            guard let self = self else { return }
            Session.shared.api.tryBotCode(self.bot.uuid, self.editor.text, text) { r in
                switch r {
                case .failure(let e): self.showError(e)
                case .success(let result):
                    var lines: [String] = []
                    if let err = result["error"] as? String { lines.append("Error: \(err)") }
                    for a in result["actions"] as? [[String: Any]] ?? [] { lines.append(BotCodeViewController.describe(a)) }
                    for (k, v) in ((result["storage"] as? [String: Any]) ?? [:]).sorted(by: { $0.key < $1.key }) {
                        lines.append("💾 " + (v is NSNull ? "Forget \"\(k)\"" : "Save \"\(k)\" = \(v)"))
                    }
                    for l in result["logs"] as? [String] ?? [] { lines.append("› \(l)") }
                    self.alert("What it would do", lines.isEmpty ? "Nothing" : lines.joined(separator: "\n"))
                }
            }
        }
    }
}
