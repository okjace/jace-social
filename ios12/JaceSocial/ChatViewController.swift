import UIKit

/// One chat: a direct message, a group chat or a server channel. Messages (with photos, replies and
/// reactions), older ones as you scroll up, live updates, and the box to write in. Tap a message for
/// reply, react, copy, open its link, and (yours) edit or delete.
final class ChatViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextViewDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let target: ChatTarget
    private var messages: [Message] = []
    private var people: [String: Person] = [:]
    private var replies: [String: ReplyPreview] = [:]
    private var reachedStart = false
    private var loadingOlder = false
    private var replyTo: Message?
    private var lastTyping = Date.distantPast
    private var typing: [String: Date] = [:]
    private var typingTimer: Timer?

    private let table = UITableView(frame: .zero, style: .plain)
    private let bar = UIView()
    private let input = UITextView()
    private let placeholder = UILabel()
    private let sendButton = UIButton(type: .system)
    private let photoButton = UIButton(type: .system)
    private let replyBar = UIButton(type: .system)
    private let typingLabel = UILabel()
    private var barBottom: NSLayoutConstraint!
    private var inputHeight: NSLayoutConstraint!

    init(_ target: ChatTarget, title: String) {
        self.target = target
        super.init(nibName: nil, bundle: nil)
        self.title = title
        hidesBottomBarWhenPushed = true
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: - layout

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        table.dataSource = self
        table.delegate = self
        table.backgroundColor = Theme.bg
        table.separatorStyle = .none
        table.rowHeight = UITableView.automaticDimension
        table.estimatedRowHeight = 70
        table.keyboardDismissMode = .interactive
        table.register(MessageCell.self, forCellReuseIdentifier: MessageCell.id)
        table.tableFooterView = UIView()

        bar.backgroundColor = Theme.bg2
        input.backgroundColor = Theme.panel
        input.textColor = Theme.text
        input.font = .systemFont(ofSize: 16)
        input.layer.cornerRadius = 18
        input.textContainerInset = UIEdgeInsets(top: 9, left: 10, bottom: 9, right: 10)
        input.keyboardAppearance = .dark
        input.delegate = self
        placeholder.text = "Message \(title ?? "")"
        placeholder.textColor = Theme.muted
        placeholder.font = .systemFont(ofSize: 16)
        sendButton.setTitle("Send", for: .normal)
        sendButton.titleLabel?.font = .boldSystemFont(ofSize: 16)
        sendButton.tintColor = Theme.green
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)
        photoButton.setTitle("＋", for: .normal)
        photoButton.titleLabel?.font = .systemFont(ofSize: 26)
        photoButton.tintColor = Theme.muted
        photoButton.addTarget(self, action: #selector(pickPhoto), for: .touchUpInside)
        replyBar.contentHorizontalAlignment = .left
        replyBar.titleLabel?.font = .systemFont(ofSize: 13)
        replyBar.tintColor = Theme.muted
        replyBar.isHidden = true
        replyBar.addTarget(self, action: #selector(cancelReply), for: .touchUpInside)
        typingLabel.font = .systemFont(ofSize: 12)
        typingLabel.textColor = Theme.muted
        typingLabel.isHidden = true

        for v in [table, bar] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        for v in [input, placeholder, sendButton, photoButton, replyBar, typingLabel] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            bar.addSubview(v)
        }
        barBottom = bar.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        inputHeight = input.heightAnchor.constraint(equalToConstant: 38)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            table.topAnchor.constraint(equalTo: g.topAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: bar.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            barBottom,
            typingLabel.topAnchor.constraint(equalTo: bar.topAnchor, constant: 4),
            typingLabel.leadingAnchor.constraint(equalTo: bar.layoutMarginsGuide.leadingAnchor),
            replyBar.topAnchor.constraint(equalTo: typingLabel.bottomAnchor),
            replyBar.leadingAnchor.constraint(equalTo: bar.layoutMarginsGuide.leadingAnchor),
            replyBar.trailingAnchor.constraint(equalTo: bar.layoutMarginsGuide.trailingAnchor),
            input.topAnchor.constraint(equalTo: replyBar.bottomAnchor, constant: 2),
            input.leadingAnchor.constraint(equalTo: photoButton.trailingAnchor, constant: 6),
            input.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            input.bottomAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            inputHeight,
            placeholder.leadingAnchor.constraint(equalTo: input.leadingAnchor, constant: 14),
            placeholder.centerYAnchor.constraint(equalTo: input.centerYAnchor),
            placeholder.trailingAnchor.constraint(lessThanOrEqualTo: input.trailingAnchor, constant: -8),
            photoButton.leadingAnchor.constraint(equalTo: bar.layoutMarginsGuide.leadingAnchor),
            photoButton.centerYAnchor.constraint(equalTo: input.centerYAnchor),
            photoButton.widthAnchor.constraint(equalToConstant: 30),
            sendButton.trailingAnchor.constraint(equalTo: bar.layoutMarginsGuide.trailingAnchor),
            sendButton.centerYAnchor.constraint(equalTo: input.centerYAnchor),
        ])
        replyBarHeight = replyBar.heightAnchor.constraint(equalToConstant: 0)
        replyBarHeight.isActive = true
        typingHeight = typingLabel.heightAnchor.constraint(equalToConstant: 0)
        typingHeight.isActive = true

        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(live(_:)), name: LiveEvent.notification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(loadLatest), name: UIApplication.didBecomeActiveNotification, object: nil)
        knownPeople()
        loadLatest()
    }
    private var replyBarHeight: NSLayoutConstraint!
    private var typingHeight: NSLayoutConstraint!

    @objc private func keyboard(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        let nearBottom = isNearBottom
        barBottom.constant = -overlap
        let duration = n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        UIView.animate(withDuration: duration, animations: { self.view.layoutIfNeeded() }) { _ in
            if nearBottom { self.scrollToBottom(animated: true) }
        }
    }

    // MARK: - loading

    /// Names and pictures we already know: you, your friends.
    private func knownPeople() {
        if let me = Session.shared.me { people[me.uuid] = me.asPerson }
        Session.shared.api.friends { [weak self] r in
            guard let self = self, case .success(let f) = r else { return }
            for p in (f.friends ?? []) + (f.others ?? []) + (f.incoming ?? []) + (f.outgoing ?? []) where self.people[p.uuid] == nil {
                self.people[p.uuid] = p
            }
            self.table.reloadData()
        }
    }

    private func absorb(_ page: MessagesPage) {
        for (k, p) in page.people ?? [:] { people[k] = p }
        for (k, r) in page.replies ?? [:] { replies[k] = r }
    }

    /// The newest messages (merged with what's shown), then scroll down if you were at the bottom.
    @objc private func loadLatest() {
        Session.shared.api.messages(target) { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): if self.messages.isEmpty { self.showError(e) }
            case .success(let page):
                let wasEmpty = self.messages.isEmpty
                let nearBottom = self.isNearBottom
                self.absorb(page)
                let fresh = page.messages ?? []
                if wasEmpty && fresh.count < 50 { self.reachedStart = true }
                let oldest = fresh.map { $0.id }.min() ?? Int.max
                var byId: [Int: Message] = [:]
                for m in self.messages where m.id < oldest { byId[m.id] = m }   // older ones we'd loaded
                for m in fresh { byId[m.id] = m }                              // the page replaces the rest (edits, deletes)
                self.messages = byId.values.sorted { $0.id < $1.id }
                self.table.reloadData()
                if wasEmpty || nearBottom { self.scrollToBottom(animated: !wasEmpty) }
                Session.shared.api.markRead(self.target)
            }
        }
    }

    private func loadOlder() {
        guard !reachedStart, !loadingOlder, let first = messages.first else { return }
        loadingOlder = true
        Session.shared.api.messages(target, before: first.id) { [weak self] r in
            guard let self = self else { return }
            self.loadingOlder = false
            guard case .success(let page) = r else { return }
            self.absorb(page)
            let older = (page.messages ?? []).filter { $0.id < first.id }.sorted { $0.id < $1.id }
            if older.isEmpty { self.reachedStart = true; return }
            let before = self.table.contentSize.height
            self.messages = older + self.messages
            self.table.reloadData()
            self.table.layoutIfNeeded()
            self.table.contentOffset.y += self.table.contentSize.height - before      // stay where you were
        }
    }

    private var isNearBottom: Bool {
        table.contentOffset.y + table.bounds.height >= table.contentSize.height - 120
    }

    private func scrollToBottom(animated: Bool) {
        guard !messages.isEmpty else { return }
        table.layoutIfNeeded()
        table.scrollToRow(at: IndexPath(row: messages.count - 1, section: 0), at: .bottom, animated: animated)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset.y < 300 && scrollView.isDragging { loadOlder() }
    }

    // MARK: - live

    private func isOurs(_ e: LiveEvent) -> Bool {
        switch target {
        case .direct(let u): return e.str("from") == u || e.str("with") == u
        case .channel(let c): return e.str("channel_id") == c
        }
    }

    @objc private func live(_ n: Notification) {
        guard let e = n.object as? LiveEvent else { return }
        switch e.event {
        case "reconnected": loadLatest()
        case "message", "dm_update", "channel":
            if isOurs(e) {
                if let from = e.str("from") { typing[from] = nil; showTyping() }
                loadLatest()
            }
        case "typing":
            let here: Bool
            switch target {
            case .direct(let u): here = e.payload["dm"] != nil && e.str("from") == u
            case .channel(let c): here = e.str("channel_id") == c
            }
            if here, let from = e.str("from"), from != Session.shared.me?.uuid {
                typing[from] = Date().addingTimeInterval(8)
                if people[from] == nil, let name = e.str("name") { people[from] = Person(uuid: from, name: name) }
                showTyping()
            }
        default: break
        }
    }

    private func showTyping() {
        typing = typing.filter { $0.value > Date() }
        let names = typing.keys.map { people[$0]?.shownName ?? "Someone" }
        typingLabel.text = names.isEmpty ? nil : names.count == 1 ? "\(names[0]) is typing…" : "\(names.count) people are typing…"
        typingLabel.isHidden = names.isEmpty
        typingHeight.constant = names.isEmpty ? 0 : 16
        typingTimer?.invalidate()
        if !names.isEmpty { typingTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.showTyping() } }
    }

    // MARK: - writing

    func textViewDidChange(_ textView: UITextView) {
        placeholder.isHidden = !textView.text.isEmpty
        let fit = textView.sizeThatFits(CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)).height
        inputHeight.constant = min(max(38, fit), 120)
        if !textView.text.isEmpty && Date().timeIntervalSince(lastTyping) > 4 {
            lastTyping = Date()
            Session.shared.api.typing(target)
        }
    }

    @objc private func send() {
        let text = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input.text = ""
        textViewDidChange(input)
        let reply = replyTo?.id
        cancelReply()
        sendButton.isEnabled = false
        Session.shared.api.send(target, text, replyTo: reply, attachments: []) { [weak self] r in
            guard let self = self else { return }
            self.sendButton.isEnabled = true
            switch r {
            case .success: self.loadLatest(); self.scrollSoon()
            case .failure(let e):
                if self.input.text.isEmpty { self.input.text = text; self.textViewDidChange(self.input) }
                self.showError(e)
            }
        }
    }

    private func scrollSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.scrollToBottom(animated: true) }
    }

    private func reply(to m: Message) {
        replyTo = m
        replyBar.setTitle("Replying to \(people[m.sender ?? ""]?.shownName ?? "a message") - tap to cancel", for: .normal)
        replyBar.isHidden = false
        replyBarHeight.constant = 22
        input.becomeFirstResponder()
    }

    @objc private func cancelReply() {
        replyTo = nil
        replyBar.isHidden = true
        replyBarHeight.constant = 0
    }

    // MARK: - photos

    @objc private func pickPhoto() {
        let sheet = UIAlertController(title: "Send a photo", message: nil, preferredStyle: .actionSheet)
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Take a photo", style: .default) { [weak self] _ in self?.picker(.camera) })
        }
        sheet.addAction(UIAlertAction(title: "Choose a photo", style: .default) { [weak self] _ in self?.picker(.photoLibrary) })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = photoButton
        present(sheet, animated: true)
    }

    private func picker(_ source: UIImagePickerController.SourceType) {
        let p = UIImagePickerController()
        p.sourceType = source
        p.delegate = self
        present(p, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else { return }
        let small = image.fitting(2048)
        guard let data = small.jpegData(compressionQuality: 0.8) else { return }
        let caption = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = replyTo?.id
        title = "Sending photo…"
        let api = Session.shared.api
        let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
        api.upload(name: name, type: "image/jpeg", data: data, width: Int(small.size.width), height: Int(small.size.height)) { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): self.restoreTitle(); self.showError(e)
            case .success(let a):
                api.send(self.target, caption, replyTo: reply, attachments: [a]) { r in
                    self.restoreTitle()
                    switch r {
                    case .success:
                        if !caption.isEmpty { self.input.text = ""; self.textViewDidChange(self.input) }
                        self.cancelReply()
                        self.loadLatest()
                        self.scrollSoon()
                    case .failure(let e): self.showError(e)
                    }
                }
            }
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { picker.dismiss(animated: true) }

    private func restoreTitle() { title = placeholder.text?.replacingOccurrences(of: "Message ", with: "") }

    // MARK: - the list

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { messages.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: MessageCell.id, for: indexPath) as! MessageCell
        let m = messages[indexPath.row]
        let prev = indexPath.row > 0 ? messages[indexPath.row - 1] : nil
        // the name and picture only when the sender changes (or after a pause, or for a reply)
        var grouped = false
        if let p = prev, p.sender == m.sender, p.kind != "system", m.reply_to == nil,
           let now = Time.date(m.created_at), let then = Time.date(p.created_at) {
            grouped = now.timeIntervalSince(then) < 300
        }
        let replied = m.reply_to.flatMap { replies[String($0)] }
        cell.show(m, sender: people[m.sender ?? ""], grouped: grouped, reply: replied,
                  replySender: replied.flatMap { people[$0.sender ?? ""] }, render: render)
        cell.onImage = { [weak self] url in self?.present(PhotoViewController(url: url), animated: true) }
        return cell
    }

    /// Message text as it reads: <@uuid> mentions become @names.
    private func render(_ text: String) -> String {
        var out = text.replacingOccurrences(of: "[[delete-account-now]]", with: "").replacingOccurrences(of: "[[delete-account]]", with: "")
        while let r = out.range(of: "<@[0-9a-f]{32}>", options: .regularExpression) {
            let id = String(out[r].dropFirst(2).dropLast())
            out.replaceSubrange(r, with: "@" + (people[id]?.shownName ?? "someone"))
        }
        return out.replacingOccurrences(of: "<@&[0-9a-f-]{36}>", with: "@role", options: .regularExpression)
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        let m = messages[indexPath.row]
        guard m.kind != "system" else { return }
        let mine = m.sender == Session.shared.me?.uuid
        let api = Session.shared.api
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Reply", style: .default) { [weak self] _ in self?.reply(to: m) })
        sheet.addAction(UIAlertAction(title: "React…", style: .default) { [weak self] _ in self?.react(m, from: indexPath) })
        let links = Links.find(m.body ?? "")
        for l in links.prefix(3) {
            sheet.addAction(UIAlertAction(title: "Open \(l.host ?? "link")", style: .default) { _ in UIApplication.shared.open(l) })
        }
        if !(m.body ?? "").isEmpty {
            sheet.addAction(UIAlertAction(title: "Copy text", style: .default) { [weak self] _ in UIPasteboard.general.string = self?.render(m.body ?? "") })
        }
        if !mine, let sender = m.sender, sender != Person.jaceBot {
            sheet.addAction(UIAlertAction(title: "Report…", style: .destructive) { [weak self] _ in
                guard let self = self else { return }
                let scope: String
                if case .direct = self.target { scope = "d" } else { scope = "c" }
                self.report(name: self.people[sender]?.shownName ?? "someone", scope: scope, messageId: m.id)
            })
        }
        if mine {
            sheet.addAction(UIAlertAction(title: "Edit", style: .default) { [weak self] _ in
                guard let self = self else { return }
                self.ask("Edit message", text: m.body ?? "", button: "Save") { text in
                    api.edit(self.target, m.id, text) { e in self.showError(e); self.loadLatest() }
                }
            })
            sheet.addAction(UIAlertAction(title: "Delete", style: .destructive) { [weak self] _ in
                guard let self = self else { return }
                self.confirm("Delete this message?", button: "Delete") {
                    api.delete(self.target, m.id) { e in self.showError(e); self.messages.removeAll { $0.id == m.id }; self.table.reloadData() }
                }
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = table.cellForRow(at: indexPath)
        present(sheet, animated: true)
    }

    private func react(_ m: Message, from indexPath: IndexPath) {
        let sheet = UIAlertController(title: "React", message: nil, preferredStyle: .actionSheet)
        var emojis = ["👍", "❤️", "😂", "😮", "😢", "🔥"]
        for r in m.reactions ?? [] where !emojis.contains(r.emoji) { emojis.append(r.emoji) }
        for e in emojis {
            let on = (m.reactions ?? []).contains { $0.emoji == e && $0.me == true }
            sheet.addAction(UIAlertAction(title: on ? "\(e)  (remove yours)" : e, style: .default) { [weak self] _ in
                guard let self = self else { return }
                Session.shared.api.react(self.target, m.id, e, on: !on) { err in self.showError(err); self.loadLatest() }
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = table.cellForRow(at: indexPath)
        present(sheet, animated: true)
    }
}

/// The common bits of the website's message formatting: **bold**, *italic*, __underline__,
/// ~~strikethrough~~ and `code`.
enum Markdown {
    static func styled(_ text: String) -> NSMutableAttributedString {
        let base: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 16), .foregroundColor: Theme.text]
        let out = NSMutableAttributedString(string: text, attributes: base)
        let rules: [(String, [NSAttributedString.Key: Any])] = [
            ("`([^`\\n]+)`", [.font: UIFont(name: "Menlo", size: 14) ?? UIFont.systemFont(ofSize: 14), .backgroundColor: Theme.panel]),
            ("\\*\\*([^*\\n]+)\\*\\*", [.font: UIFont.boldSystemFont(ofSize: 16)]),
            ("__([^_\\n]+)__", [.underlineStyle: NSUnderlineStyle.single.rawValue]),
            ("~~([^~\\n]+)~~", [.strikethroughStyle: NSUnderlineStyle.single.rawValue]),
            ("(?<![*\\w])\\*([^*\\n]+)\\*(?![*\\w])", [.font: UIFont.italicSystemFont(ofSize: 16)]),
        ]
        for (pattern, attrs) in rules {
            guard let re = try? NSRegularExpression(pattern: pattern) else { continue }
            // last match first, so earlier ranges stay right while the marks come out
            for m in re.matches(in: out.string, range: NSRange(location: 0, length: (out.string as NSString).length)).reversed() {
                let inner = out.attributedSubstring(from: m.range(at: 1)).mutableCopy() as! NSMutableAttributedString
                inner.addAttributes(attrs, range: NSRange(location: 0, length: inner.length))
                out.replaceCharacters(in: m.range, with: inner)
            }
        }
        return out
    }
}

enum Links {
    static func find(_ text: String) -> [URL] {
        guard let d = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        return d.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { $0.url }.filter { ["http", "https"].contains($0.scheme ?? "") }
    }
}

extension UIImage {
    /// At most this many pixels on its longest side (photos are sent smaller).
    func fitting(_ longest: CGFloat) -> UIImage {
        let scale = min(1, longest / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        UIGraphicsBeginImageContextWithOptions(target, true, 1)
        defer { UIGraphicsEndImageContext() }
        draw(in: CGRect(origin: .zero, size: target))
        return UIGraphicsGetImageFromCurrentImageContext() ?? self
    }
}

// MARK: - one message

final class MessageCell: UITableViewCell {
    static let id = "message"
    private let avatar = AvatarView(size: 36)
    private let name = UILabel()
    private let time = UILabel()
    private let replyLine = UILabel()
    private let body = UILabel()
    private let media = UIStackView()
    private let files = UILabel()
    private let reactions = UILabel()
    private let header = UIStackView()
    private var topGap: NSLayoutConstraint!
    var onImage: ((String) -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = Theme.bg
        selectionStyle = .none
        name.font = .boldSystemFont(ofSize: 15)
        name.textColor = Theme.text
        time.font = .systemFont(ofSize: 12)
        time.textColor = Theme.muted
        time.setContentHuggingPriority(.required, for: .horizontal)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        header.addArrangedSubview(name)
        header.addArrangedSubview(time)
        header.spacing = 8
        header.alignment = .firstBaseline
        replyLine.font = .systemFont(ofSize: 13)
        replyLine.textColor = Theme.muted
        replyLine.numberOfLines = 1
        body.font = .systemFont(ofSize: 16)
        body.textColor = Theme.text
        body.numberOfLines = 0
        media.axis = .vertical
        media.spacing = 6
        media.alignment = .leading
        files.font = .systemFont(ofSize: 14)
        files.textColor = Theme.green
        files.numberOfLines = 0
        reactions.font = .systemFont(ofSize: 15)
        reactions.textColor = Theme.text
        reactions.numberOfLines = 0
        let column = UIStackView(arrangedSubviews: [header, replyLine, body, media, files, reactions])
        column.axis = .vertical
        column.spacing = 3
        for v in [avatar, column] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; contentView.addSubview(v) }
        topGap = column.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10)
        NSLayoutConstraint.activate([
            avatar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            avatar.topAnchor.constraint(equalTo: column.topAnchor),
            avatar.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -2),
            column.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            topGap,
            column.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -2),
            contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 24),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ m: Message, sender: Person?, grouped: Bool, reply: ReplyPreview?, replySender: Person?, render: (String) -> String) {
        let system = m.kind == "system"
        avatar.isHidden = grouped || system
        header.isHidden = grouped || system
        topGap.constant = grouped ? 0 : 10
        if !grouped && !system { avatar.show(name: sender?.shownName ?? "?", url: sender?.avatar_url) }
        name.text = sender?.shownName ?? "Someone"
        time.text = Time.label(m.created_at)
        if let r = reply {
            replyLine.text = "↪ \(replySender?.shownName ?? "Someone"): \(render(r.body ?? "").replacingOccurrences(of: "\n", with: " "))"
            replyLine.isHidden = false
        } else {
            replyLine.text = m.reply_to != nil ? "↪ The original message was deleted" : nil
            replyLine.isHidden = m.reply_to == nil
        }
        let text = render(m.body ?? "")
        let shown = system ? NSMutableAttributedString(string: text, attributes: [.font: UIFont.italicSystemFont(ofSize: 14), .foregroundColor: Theme.muted])
                           : Markdown.styled(text)
        if m.edited_at != nil && !text.isEmpty {
            shown.append(NSAttributedString(string: "  (edited)", attributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: Theme.muted]))
        }
        body.attributedText = shown
        body.isHidden = text.isEmpty

        media.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let atts = m.attachments ?? []
        for a in atts where a.isImage {
            let w = CGFloat(a.width ?? 400), h = CGFloat(a.height ?? 300)
            let shown = min(240, w)
            let v = UIImageView()
            v.backgroundColor = Theme.panel
            v.contentMode = .scaleAspectFill
            v.clipsToBounds = true
            v.layer.cornerRadius = 8
            v.isUserInteractionEnabled = true
            v.translatesAutoresizingMaskIntoConstraints = false
            v.widthAnchor.constraint(equalToConstant: shown).isActive = true
            v.heightAnchor.constraint(equalToConstant: min(320, shown * h / max(w, 1))).isActive = true
            v.addGestureRecognizer(ImageTap(target: self, action: #selector(tappedImage(_:)), url: a.url))
            media.addArrangedSubview(v)
            Images.shared.load(a.url) { [weak v] img in v?.image = img }
        }
        media.isHidden = media.arrangedSubviews.isEmpty
        let others = atts.filter { !$0.isImage }
        files.text = others.map { "📎 \($0.name ?? "file")" }.joined(separator: "\n")
        files.isHidden = others.isEmpty
        let embeds = (m.embeds ?? []).compactMap { $0.title }.prefix(2)
        if !embeds.isEmpty {
            files.text = ([files.text ?? ""].filter { !$0.isEmpty } + embeds.map { "🔗 \($0)" }).joined(separator: "\n")
            files.isHidden = false
        }
        let rs = m.reactions ?? []
        reactions.text = rs.map { "\($0.emoji) \($0.count ?? 1)" + ($0.me == true ? "•" : "") }.joined(separator: "   ")
        reactions.isHidden = rs.isEmpty
    }

    @objc private func tappedImage(_ g: ImageTap) { onImage?(g.url) }
}

final class ImageTap: UITapGestureRecognizer {
    let url: String
    init(target: Any?, action: Selector?, url: String) {
        self.url = url
        super.init(target: target, action: action)
    }
}

/// A photo full screen: pinch to zoom, tap to close.
final class PhotoViewController: UIViewController, UIScrollViewDelegate {
    private let url: String
    private let scroll = UIScrollView()
    private let image = UIImageView()

    init(url: String) {
        self.url = url
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalTransitionStyle = .crossDissolve
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.delegate = self
        scroll.maximumZoomScale = 4
        image.frame = scroll.bounds
        image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        image.contentMode = .scaleAspectFit
        scroll.addSubview(image)
        view.addSubview(scroll)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(close)))
        Images.shared.load(url) { [weak self] img in self?.image.image = img }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
    @objc private func close() { dismiss(animated: true) }
}
