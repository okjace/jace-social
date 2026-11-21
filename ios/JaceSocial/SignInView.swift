import SafariServices
import SwiftUI

/// Sign in with Jace (in the browser) or with Minecraft (a code at microsoft.com/link).
struct SignInView: View {
    @EnvironmentObject var session: Session
    @State private var busy: String?
    @State private var error: String?
    @State private var code: DeviceCode?
    @State private var browser: URL?

    var body: some View {
        ZStack {
            JaceColor.bg.ignoresSafeArea()
            VStack(spacing: 14) {
                Text("Jace Social").font(.system(size: 30, weight: .heavy)).foregroundStyle(JaceColor.green)
                Text("Friends, chat and servers - with Minecraft built in.").foregroundStyle(JaceColor.muted).multilineTextAlignment(.center)
                if let dc = code {
                    Text("Go to \(dc.verification_uri) and enter this code:").multilineTextAlignment(.center)
                    Text(dc.user_code).font(.system(size: 30, weight: .bold, design: .monospaced)).textSelection(.enabled)
                    Button("Open microsoft.com/link") { browser = URL(string: dc.verification_uri) }.buttonStyle(.borderedProminent)
                }
                if let b = busy {
                    ProgressView()
                    Text(b).foregroundStyle(JaceColor.muted).multilineTextAlignment(.center)
                } else {
                    Button { Task { await signInWithJace() } } label: { Text("Sign in with Jace").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                    Button { Task { await signInWithMinecraft() } } label: { Text("⛏  Sign in with Minecraft").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).controlSize(.large)
                }
                if let e = error { Text(e).foregroundStyle(JaceColor.red).multilineTextAlignment(.center) }
                // (the links open the Terms and privacy page in the browser)
                Text("By making an account, you agree to the [Terms of Service](https://jace-social.vercel.app/legal#terms) and [Privacy Policy](https://jace-social.vercel.app/legal#privacy).")
                    .font(.footnote).foregroundStyle(JaceColor.muted).tint(JaceColor.green).multilineTextAlignment(.center)
            }
            .padding(28)
            .background(JaceColor.panel, in: RoundedRectangle(cornerRadius: 18))
            .frame(maxWidth: 420)
            .padding(24)
        }
        .sheet(item: $browser) { url in SafariView(url: url) }
    }

    func signInWithJace() async {
        error = nil
        busy = "Finish signing in in the browser…"
        defer { busy = nil }
        do {
            let start = try await session.api.startJace()
            browser = URL(string: start.url)
            for _ in 0..<150 {                          // up to ~5 minutes
                try await Task.sleep(nanoseconds: 2_000_000_000)
                if let s = try await session.api.pollJace(start) {
                    browser = nil
                    session.signedIn(s)
                    return
                }
            }
            error = "Sign-in took too long - try again"
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signInWithMinecraft() async {
        error = nil
        defer { busy = nil; code = nil }
        do {
            let dc = try await session.api.startMinecraft()
            code = dc
            busy = "Waiting for you to enter the code…"
            while true {
                try await Task.sleep(nanoseconds: UInt64(dc.interval ?? 5) * 1_000_000_000)
                if let s = try await session.api.pollMinecraft(dc.ticket) {
                    browser = nil
                    session.signedIn(s)
                    return
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
