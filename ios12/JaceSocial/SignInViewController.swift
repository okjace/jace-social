import SafariServices
import UIKit

/// Sign in with Jace (in a browser sheet) or with Minecraft (a code at microsoft.com/link).
final class SignInViewController: UIViewController {
    private let status = UILabel()
    private let code = UILabel()
    private let spinner = UIActivityIndicatorView(style: .white)
    private let jace = UIButton(type: .system)
    private let minecraft = UIButton(type: .system)
    private let openLink = UIButton(type: .system)
    private var polling: Timer?
    private var browser: SFSafariViewController?
    private var device: DeviceCode?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let title = UILabel()
        title.text = "Jace Social"
        title.font = .systemFont(ofSize: 32, weight: .heavy)
        title.textColor = Theme.green
        let tagline = UILabel()
        tagline.text = "Friends, chat and servers - with Minecraft built in."
        tagline.textColor = Theme.muted
        tagline.numberOfLines = 0
        tagline.textAlignment = .center
        for (b, text, primary) in [(jace, "Sign in with Jace", true), (minecraft, "⛏  Sign in with Minecraft", false), (openLink, "Open microsoft.com/link", true)] {
            b.setTitle(text, for: .normal)
            b.titleLabel?.font = .boldSystemFont(ofSize: 17)
            b.setTitleColor(primary ? Theme.onGreen : Theme.text, for: .normal)
            b.backgroundColor = primary ? Theme.green : Theme.panel
            b.layer.cornerRadius = 10
            b.heightAnchor.constraint(equalToConstant: 48).isActive = true
        }
        jace.addTarget(self, action: #selector(signInWithJace), for: .touchUpInside)
        minecraft.addTarget(self, action: #selector(signInWithMinecraft), for: .touchUpInside)
        openLink.addTarget(self, action: #selector(openMicrosoft), for: .touchUpInside)
        openLink.isHidden = true
        code.font = UIFont(name: "Menlo-Bold", size: 30) ?? .boldSystemFont(ofSize: 30)
        code.textColor = Theme.text
        code.textAlignment = .center
        code.isHidden = true
        status.textColor = Theme.muted
        status.numberOfLines = 0
        status.textAlignment = .center
        spinner.hidesWhenStopped = true
        let stack = UIStackView(arrangedSubviews: [title, tagline, code, openLink, spinner, status, jace, minecraft])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .fill
        title.textAlignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor, constant: -12),
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.widthAnchor.constraint(equalToConstant: 340).withPriority(.defaultHigh),
        ])
    }

    private func busy(_ text: String?) {
        status.text = text
        status.textColor = Theme.muted
        jace.isHidden = text != nil
        minecraft.isHidden = text != nil
        if text != nil { spinner.startAnimating() } else { spinner.stopAnimating() }
    }

    private func failed(_ e: ApiError) {
        stop()
        busy(nil)
        status.text = e.message
        status.textColor = Theme.red
    }

    private func stop() {
        polling?.invalidate()
        polling = nil
        code.isHidden = true
        openLink.isHidden = true
        device = nil
    }

    private func done(_ s: SignedIn) {
        stop()
        browser?.dismiss(animated: true)
        Session.shared.signedIn(s)
    }

    @objc private func signInWithJace() {
        busy("Finish signing in in the browser…")
        Session.shared.api.startJace { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): self.failed(e)
            case .success(let start):
                if let u = URL(string: start.url) {
                    let b = SFSafariViewController(url: u)
                    self.browser = b
                    self.present(b, animated: true)
                }
                var tries = 0
                self.polling = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
                    tries += 1
                    if tries > 150 { self?.failed(ApiError(status: 0, message: "Sign-in took too long - try again")); return }
                    Session.shared.api.pollJace(start) { r in
                        switch r {
                        case .success(let s?): self?.done(s)
                        case .success(nil): break
                        case .failure(let e): if e.status != 0 { self?.failed(e) }      // (a dropped connection: try again)
                        }
                    }
                }
            }
        }
    }

    @objc private func signInWithMinecraft() {
        busy("Getting a code…")
        Session.shared.api.startMinecraft { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): self.failed(e)
            case .success(let dc):
                self.device = dc
                self.busy("Go to \(dc.verification_uri) and enter this code:")
                self.spinner.stopAnimating()
                self.code.text = dc.user_code
                self.code.isHidden = false
                self.openLink.isHidden = false
                UIPasteboard.general.string = dc.user_code
                self.polling = Timer.scheduledTimer(withTimeInterval: TimeInterval(max(dc.interval ?? 5, 2)), repeats: true) { [weak self] _ in
                    Session.shared.api.pollMinecraft(dc.ticket) { r in
                        switch r {
                        case .success(let s?): self?.done(s)
                        case .success(nil): break
                        case .failure(let e): if e.status != 0 { self?.failed(e) }
                        }
                    }
                }
            }
        }
    }

    @objc private func openMicrosoft() {
        guard let dc = device, let u = URL(string: dc.verification_uri) else { return }
        let b = SFSafariViewController(url: u)
        browser = b
        present(b, animated: true)
    }
}

extension NSLayoutConstraint {
    func withPriority(_ p: UILayoutPriority) -> NSLayoutConstraint { priority = p; return self }
}
