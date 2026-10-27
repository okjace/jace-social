import UIKit
import UserNotifications
import WebRTC

/// Calls and voice channels for the whole app: the live events for them, the call screen when a call
/// comes in, a notification when the app is in the background, and the "return to call" button.
final class Phone: NSObject {
    static let shared = Phone()
    let calls = Calls()
    let voice = Voice()
    private var pill: UIButton?

    private override init() {
        super.init()
        calls.onEnded = { Phone.toast($0) }
        voice.onError = { Phone.toast($0) }
        calls.onIncoming = { name in
            if UIApplication.shared.applicationState == .active { Phone.shared.showCall() }
            else { Notify.post(title: "\(name) is calling", body: "Open Jace Social to answer", id: "call") }
        }
        NotificationCenter.default.addObserver(forName: LiveEvent.notification, object: nil, queue: .main) { n in
            guard let e = n.object as? LiveEvent else { return }
            switch e.event {
            case "call": Phone.shared.calls.onSignal(e)
            case "voice_signal": Phone.shared.voice.onSignal(e)
            case "voice": Phone.shared.voice.refresh()
            default: break
            }
        }
        for name in [Calls.changed, Voice.changed] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in Phone.shared.updatePill() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            if Phone.shared.calls.info.state == "ringing" { Phone.shared.showCall() }
        }
    }

    /// (start listening; called once signed in)
    func start() {}

    static var top: UIViewController? {
        var v = UIApplication.shared.keyWindow?.rootViewController
        while let p = v?.presentedViewController { v = p }
        return v
    }

    static func toast(_ message: String) {
        guard let top = top else { return }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        top.present(a, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { a.dismiss(animated: true) }
    }

    func call(_ uuid: String, name: String) {
        calls.call(uuid, name: name)
        showCall()
    }

    func joinRoom(_ channel: String, name: String) {
        if calls.info.state != "idle" { Phone.toast("Hang up your call first"); return }
        voice.join(channel: channel, name: name)
        showRoom()
    }

    func showCall() {
        guard !(Phone.top is CallViewController) else { return }
        Phone.top?.present(CallViewController(), animated: true)
    }

    func showRoom() {
        guard !(Phone.top is UINavigationController && (Phone.top as? UINavigationController)?.topViewController is RoomViewController) else { return }
        let nav = UINavigationController(rootViewController: RoomViewController())
        Phone.top?.present(nav, animated: true)
    }

    /// A green "back to the call" button at the top while you're elsewhere in the app.
    func updatePill() {
        let inCall = calls.info.state != "idle"
        let inRoom = voice.state.channelId != nil
        let showing = Phone.top is CallViewController || (Phone.top as? UINavigationController)?.topViewController is RoomViewController
        guard (inCall || inRoom) && !showing, let window = UIApplication.shared.keyWindow else {
            pill?.removeFromSuperview(); pill = nil
            return
        }
        let b = pill ?? UIButton(type: .system)
        if pill == nil {
            b.backgroundColor = Theme.green
            b.setTitleColor(Theme.onGreen, for: .normal)
            b.titleLabel?.font = .boldSystemFont(ofSize: 14)
            b.layer.cornerRadius = 16
            b.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
            b.addTarget(self, action: #selector(tappedPill), for: .touchUpInside)
            window.addSubview(b)
            pill = b
        }
        b.setTitle(inCall ? "● \(calls.info.peerName) - back to the call" : "● \(voice.state.channelName) - back to voice", for: .normal)
        b.sizeToFit()
        b.center = CGPoint(x: window.bounds.midX, y: window.safeAreaInsets.top + 52 + b.bounds.height / 2)
        window.bringSubviewToFront(b)
    }

    @objc private func tappedPill() {
        if calls.info.state != "idle" { showCall() } else { showRoom() }
    }
}

/// Local notifications (messages and calls while the app isn't open).
enum Notify {
    static func ask() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    static func post(title: String, body: String, id: String = UUID().uuidString) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }
}

/// A round button for the call screens.
func callButton(_ title: String, red: Bool = false, _ target: Any, _ action: Selector) -> UIButton {
    let b = UIButton(type: .system)
    b.setTitle(title, for: .normal)
    b.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
    b.titleLabel?.numberOfLines = 2
    b.titleLabel?.textAlignment = .center
    b.setTitleColor(.white, for: .normal)
    b.backgroundColor = red ? Theme.red : UIColor(white: 1, alpha: 0.15)
    b.layer.cornerRadius = 32
    b.translatesAutoresizingMaskIntoConstraints = false
    b.widthAnchor.constraint(equalToConstant: 64).isActive = true
    b.heightAnchor.constraint(equalToConstant: 64).isActive = true
    b.addTarget(target, action: action, for: .touchUpInside)
    return b
}

/// A video track on screen (keeps itself attached to the right track).
final class VideoView: UIView {
    private let view = RTCMTLVideoView()
    private(set) var track: RTCVideoTrack?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        view.videoContentMode = .scaleAspectFill
        view.frame = bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(view)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ t: RTCVideoTrack?) {
        if t === track { return }
        track?.remove(view)
        track = t
        t?.add(view)
        isHidden = t == nil
    }

    deinit { track?.remove(view) }
}

// MARK: - a call with a friend

final class CallViewController: UIViewController {
    private let remote = VideoView()
    private let local = VideoView()
    private let name = UILabel()
    private let status = UILabel()
    private let buttons = UIStackView()
    private var clock: Timer?
    private var calls: Calls { Phone.shared.calls }

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        remote.frame = view.bounds
        remote.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        remote.isHidden = true
        view.addSubview(remote)
        local.isHidden = true
        local.layer.cornerRadius = 10
        name.font = .systemFont(ofSize: 28, weight: .bold)
        name.textColor = .white
        name.textAlignment = .center
        status.font = .systemFont(ofSize: 16)
        status.textColor = Theme.muted
        status.textAlignment = .center
        buttons.spacing = 16
        buttons.alignment = .center
        let minimize = UIButton(type: .system)
        minimize.setTitle("⌄ Back to chats", for: .normal)
        minimize.tintColor = .white
        minimize.addTarget(self, action: #selector(close), for: .touchUpInside)
        for v in [local, name, status, buttons, minimize] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            minimize.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            minimize.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            name.topAnchor.constraint(equalTo: g.topAnchor, constant: 60),
            name.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            name.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            status.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 6),
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            local.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            local.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            local.widthAnchor.constraint(equalToConstant: 100),
            local.heightAnchor.constraint(equalToConstant: 140),
            buttons.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -30),
            buttons.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(update), name: Calls.changed, object: nil)
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateStatus() }
        update()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        Phone.shared.updatePill()
    }

    @objc private func update() {
        let i = calls.info
        if i.state == "idle" { clock?.invalidate(); dismiss(animated: true); return }
        name.text = i.peerName
        remote.show(i.remoteScreen ?? i.remoteCamera)
        local.show(i.camera)
        updateStatus()
        buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if i.state == "ringing" {
            buttons.addArrangedSubview(callButton("Decline", red: true, self, #selector(hangUp)))
            let answer = callButton("Answer", self, #selector(answer))
            answer.backgroundColor = Theme.green
            buttons.addArrangedSubview(answer)
        } else {
            buttons.addArrangedSubview(callButton(i.muted ? "Unmute" : "Mute", self, #selector(mute)))
            buttons.addArrangedSubview(callButton(i.speaker ? "Speaker\non" : "Speaker", self, #selector(speaker)))
            if i.state == "in-call" { buttons.addArrangedSubview(callButton(i.camera != nil ? "Camera\noff" : "Camera", self, #selector(camera))) }
            buttons.addArrangedSubview(callButton("End", red: true, self, #selector(hangUp)))
        }
    }

    private func updateStatus() {
        let i = calls.info
        switch i.state {
        case "calling": status.text = "Calling…"
        case "ringing": status.text = "Calling you…"
        case "in-call":
            let s = Int(Date().timeIntervalSince(i.startedAt ?? Date()))
            status.text = String(format: "%d:%02d", s / 60, s % 60) + (i.noMic ? " · no microphone (allow it in Settings)" : "")
        default: status.text = nil
        }
    }

    @objc private func answer() { calls.answer() }
    @objc private func hangUp() { calls.hangUp() }
    @objc private func mute() { calls.toggleMute() }
    @objc private func speaker() { calls.toggleSpeaker() }
    @objc private func camera() { calls.toggleCamera() }
    @objc private func close() { dismiss(animated: true) }
}

// MARK: - a voice channel

final class RoomViewController: UITableViewController {
    private var voice: Voice { Phone.shared.voice }
    private let videos = UIStackView()
    private let controls = UIStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(PersonCell.self, forCellReuseIdentifier: PersonCell.id)
        tableView.tableFooterView = UIView()
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(close))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Leave", style: .done, target: self, action: #selector(leave))
        navigationItem.rightBarButtonItem?.tintColor = Theme.red
        videos.axis = .vertical
        videos.spacing = 6
        controls.spacing = 14
        videos.widthAnchor.constraint(equalToConstant: min(UIScreen.main.bounds.width - 24, 420)).isActive = true
        NotificationCenter.default.addObserver(self, selector: #selector(update), name: Voice.changed, object: nil)
        update()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        Phone.shared.updatePill()
    }

    @objc private func update() {
        let s = voice.state
        if s.channelId == nil { dismiss(animated: true); return }
        title = s.connecting ? "Connecting…" : s.channelName
        // everyone's video (cameras and screens), then the buttons
        videos.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (uuid, track) in s.screens.merging(s.cameras, uniquingKeysWith: { a, _ in a }) {
            let v = VideoView(frame: CGRect(x: 0, y: 0, width: 320, height: 200))
            v.heightAnchor.constraint(equalToConstant: 200).isActive = true
            v.show(track)
            v.accessibilityLabel = uuid
            videos.addArrangedSubview(v)
        }
        controls.arrangedSubviews.forEach { $0.removeFromSuperview() }
        controls.addArrangedSubview(callButton(s.muted ? "Unmute" : "Mute", self, #selector(mute)))
        controls.addArrangedSubview(callButton(s.deafened ? "Undeafen" : "Deafen", self, #selector(deafen)))
        controls.addArrangedSubview(callButton(s.speaker ? "Speaker\non" : "Speaker", self, #selector(speaker)))
        if s.canVideo { controls.addArrangedSubview(callButton(s.camera ? "Camera\noff" : "Camera", self, #selector(camera))) }
        let header = UIStackView(arrangedSubviews: [videos, controls])
        header.axis = .vertical
        header.spacing = 12
        header.alignment = .center
        header.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        header.isLayoutMarginsRelativeArrangement = true
        let size = header.systemLayoutSizeFitting(CGSize(width: view.bounds.width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        header.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: size.height)
        tableView.tableHeaderView = header
        tableView.reloadData()
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { voice.state.participants.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        voice.state.noMic ? "In voice - your microphone isn't allowed (Settings → Jace Social)" : "In voice"
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let c = tableView.dequeueReusableCell(withIdentifier: PersonCell.id, for: indexPath) as! PersonCell
        let p = voice.state.participants[indexPath.row]
        let line = p.deafened == true ? "🔇 Deafened" : p.muted == true ? "🎙 Muted" : nil
        c.show(name: p.person?.shownName ?? "Someone", picture: p.person?.avatar_url, line: line)
        c.selectionStyle = .none
        return c
    }

    @objc private func mute() { voice.toggleMute() }
    @objc private func deafen() { voice.toggleDeafen() }
    @objc private func speaker() { voice.toggleSpeaker() }
    @objc private func camera() { voice.toggleCamera() }
    @objc private func leave() { voice.leave() }
    @objc private func close() { dismiss(animated: true) }
}
