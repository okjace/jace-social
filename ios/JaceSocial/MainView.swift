import SwiftUI

/// Signed in: tabs for chats, servers and you, with everything else opening on top. A call shows
/// over everything; a voice room keeps a bar at the bottom.
struct MainView: View {
    @EnvironmentObject var session: Session
    @StateObject private var store: Store
    @StateObject private var router = Router()
    @Environment(\.colorScheme) private var scheme
    @State private var callShown = true
    @State private var welcome = false
    let links: String?

    init(session: Session, links: String? = nil) {
        _store = StateObject(wrappedValue: Store(session: session))
        self.links = links
    }

    var body: some View {
        let lookKey = JaceColor.apply(store.me?.settings, systemDark: scheme == .dark)
        ZStack(alignment: .bottom) {
            TabView(selection: $router.tab) {
                NavigationStack(path: $router.paths[0]) { ChatsView().navigationDestination(for: Route.self) { screen($0) } }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }.tag(0)
                NavigationStack(path: $router.paths[1]) { ServersView().navigationDestination(for: Route.self) { screen($0) } }
                    .tabItem { Label("Servers", systemImage: "server.rack") }.tag(1)
                NavigationStack(path: $router.paths[2]) { YouView().navigationDestination(for: Route.self) { screen($0) } }
                    .tabItem { Label("You", systemImage: "person.crop.circle") }.tag(2)
            }
            VStack(spacing: 6) {
                if store.calls.info.state != "idle" && !callShown {
                    ActiveBar(text: "📞 \(store.calls.info.state == "in-call" ? "In a call with" : "Calling") \(store.calls.info.peerName)") { callShown = true }
                }
                if let room = store.voice.state.channelId, !room.isEmpty {
                    ActiveBar(text: "🔊 In \(store.voice.state.channelName)") { router.go(.voice) }
                }
                if let t = store.toast {
                    Text(t).font(.subheadline).padding(.horizontal, 14).padding(.vertical, 10)
                        .background(JaceColor.panel, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(JaceColor.text)
                        .shadow(radius: 6).onTapGesture { store.toast = nil }
                }
            }
            .padding(.bottom, 56)
        }
        .id(lookKey)
        .environmentObject(store)
        .environmentObject(router)
        .preferredColorScheme(JaceColor.light ? .light : .dark)
        .tint(JaceColor.green)
        .dynamicTypeSize(dynamicSize(store.me?.settings?.font_scale))
        .fullScreenCover(isPresented: Binding(get: { store.calls.info.state != "idle" && callShown }, set: { if !$0 { callShown = false } })) {
            CallView(minimize: { callShown = false }).environmentObject(store).environmentObject(router)
        }
        .onChange(of: store.calls.info.state) { s in if s == "ringing" || s == "calling" { callShown = true } }
        .sheet(isPresented: $welcome) { NavigationStack { WelcomeView() }.environmentObject(store).environmentObject(router) }
        .alert(store.askUpdate.map { "Update to Jace Social \($0.version)?" } ?? "", isPresented: Binding(get: { store.askUpdate != nil }, set: { if !$0 { store.askUpdate = nil } }),
               presenting: store.askUpdate) { r in
            Button("Update now") { store.openUpdater(page: r.page) }
            Button("Later", role: .cancel) {}
        } message: { r in Text("It updates in AltStore or SideStore: open Jace Social there and tap Update.\n\n\((r.notes ?? "").prefix(600))") }
        .alert("Leaving Jace Social", isPresented: Binding(get: { store.pendingLink.map { !trusted($0) } ?? false }, set: { if !$0 { store.pendingLink = nil } }),
               presenting: store.pendingLink) { url in
            Button("Open link") { UIApplication.shared.open(url) }
            Button("Trust \(url.host ?? "")") {
                let list = store.me?.prefs.trusted_domains ?? []
                store.saveSettings(["trusted_domains": Array(Set(list + [host(url)]))])
                UIApplication.shared.open(url)
            }
            Button("Cancel", role: .cancel) {}
        } message: { url in Text("This link goes to \(host(url))\n\n\(url.absoluteString.prefix(300))") }
        .onChange(of: store.pendingLink) { u in
            // trusted sites (and ours) open without asking
            if let u, trusted(u) { store.pendingLink = nil; UIApplication.shared.open(u) }
        }
        .task {
            await store.start()
            if store.me?.onboarded == false && store.me?.is_bot != true { welcome = true }
            if let l = links { openLink(l) }
            // test builds: -jaceOpen dm:<uuid>:<title>, ch:<id>:<title> or server:<id>:<name> opens that (CI screenshots)
            #if DEBUG
            if let open = UserDefaults.standard.string(forKey: "jaceOpen") {
                let parts = open.split(separator: ":", maxSplits: 2).map(String.init)
                if parts.count == 3 {
                    switch parts[0] {
                    case "server": router.open(tab: 1, .server(parts[1], parts[2]))
                    case "dm": router.go(.chat(.direct(parts[1]), parts[2]))
                    case "you": router.open(tab: 2, .settings(parts[1]))
                    case "profile": router.go(.profile(parts[1], nil))
                    case "serversettings": router.open(tab: 1, .serverSettings(parts[1]))
                    case "bots": router.open(tab: 2, .bots)
                    default: router.go(.chat(.channel(parts[1]), parts[2]))
                    }
                }
            }
            #endif
        }
        .onOpenURL { openLink($0.absoluteString) }
        .onDisappear { store.stop() }
    }

    private func host(_ u: URL) -> String { (u.host ?? "").lowercased().replacingOccurrences(of: "www.", with: "") }

    private func trusted(_ u: URL) -> Bool {
        let s = store.me?.prefs
        let h = host(u)
        return s?.link_warning == false || h == "jace-social.vercel.app" || (s?.trusted_domains ?? []).contains { h == $0 || h.hasSuffix("." + $0) }
    }

    /// jacesocial://invite/<code> or https://jace-social.vercel.app/invite/<code>
    private func openLink(_ l: String) {
        guard let r = l.range(of: "(?:jacesocial://invite/|https://jace-social\\.vercel\\.app/invite/)([A-Za-z0-9_-]+)", options: .regularExpression) else { return }
        router.open(tab: 1, .invite(inviteCode(String(l[r]))))
    }

    @ViewBuilder
    private func screen(_ r: Route) -> some View {
        switch r {
        case .chat(let t, let title): ChatView(target: t, title: title)
        case .server(let id, let name): ServerView(id: id, title: name)
        case .profile(let uuid, let server): ProfileView(uuid: uuid, serverId: server)
        case .serverSettings(let id): ServerSettingsView(id: id)
        case .channelSettings(let s, let c): ChannelSettingsView(serverId: s, channelId: c)
        case .group(let id): GroupSettingsView(id: id)
        case .newGroup: NewGroupView()
        case .addServer(let code): AddServerView(code: code)
        case .invite(let code): InviteView(code: code)
        case .settings(let tab): SettingsView(tab: tab)
        case .bots: BotsView()
        case .botCode(let id): BotCodeView(id: id)
        case .botBlocks(let id): BotBlocksView(id: id)
        case .botActivity(let id, let server): BotActivityView(id: id, server: server)
        case .voice: VoiceRoomView()
        case .welcome: WelcomeView()
        }
    }
}

/// A thin bar: an ongoing call or voice room.
struct ActiveBar: View {
    let text: String
    let tap: () -> Void
    var body: some View {
        Button(action: tap) {
            HStack { Text(text).bold().lineLimit(1); Spacer(); Text("Open") }
                .foregroundStyle(JaceColor.onGreen).padding(.horizontal, 16).padding(.vertical, 10)
                .background(JaceColor.green, in: RoundedRectangle(cornerRadius: 12))
        }
        .padding(.horizontal, 12)
    }
}

/// Your conversations: friend requests, group chats and friends (direct messages), unread first.
struct ChatsView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: Router
    @State private var adding = false
    @State private var removing: Person?

    var body: some View {
        let muted = store.me?.prefs.muted ?? []
        List {
            if let e = store.error { Text(e).foregroundStyle(JaceColor.red) }
            if let f = store.friends {
                if !f.incoming.isEmpty {
                    Section("Friend requests — \(f.incoming.count)") {
                        ForEach(f.incoming) { p in
                            HStack {
                                PersonRow(person: p, line: "Wants to be friends")
                                Button { store.friendAction { try await $0.respondFriend(p.uuid, accept: true) } } label: {
                                    Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(JaceColor.green)
                                }
                                .accessibilityLabel("Accept")
                                Button { store.friendAction { try await $0.respondFriend(p.uuid, accept: false) } } label: {
                                    Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(JaceColor.muted)
                                }
                                .accessibilityLabel("Decline")
                            }
                            .buttonStyle(.borderless)
                            .listRowBackground(JaceColor.bg)
                        }
                    }
                }
                if !f.outgoing.isEmpty {
                    Section("Sent requests — \(f.outgoing.count)") {
                        ForEach(f.outgoing) { p in
                            HStack {
                                PersonRow(person: p, line: "Waiting for them to accept")
                                Button("Cancel") { store.friendAction { try await $0.removeFriend(p.uuid) } }
                                    .foregroundStyle(JaceColor.muted)
                            }
                            .buttonStyle(.borderless)
                            .listRowBackground(JaceColor.bg)
                        }
                    }
                }
                if !store.groups.isEmpty {
                    Section("Group chats") {
                        ForEach(store.groups) { g in
                            NavigationLink(value: Route.chat(.channel(g.id), g.name)) { GroupRow(group: g, muted: muted.contains(g.id)) }
                                .listRowBackground(JaceColor.bg)
                                .contextMenu {
                                    Button { router.go(.group(g.id)) } label: { Label("Group settings", systemImage: "gear") }
                                    Button { toggleMute(g.id) } label: { Label(muted.contains(g.id) ? "Unmute" : "Mute", systemImage: "bell.slash") }
                                }
                        }
                    }
                }
                Section("Direct messages") {
                    if let j = f.jace {          // the official Jace bot: help, and a person when you ask for one
                        NavigationLink(value: Route.chat(.direct(j.uuid), "Jace")) {
                            PersonRow(person: j, line: (j.unread ?? 0) > 0 ? "New message" : "Ask me anything about Jace Social")
                        }
                        .listRowBackground(JaceColor.bg)
                    }
                    ForEach((f.others ?? []).sorted(by: dmOrder)) { p in
                        NavigationLink(value: Route.chat(.direct(p.uuid), p.shownName)) { PersonRow(person: p, line: "Not a friend") }
                            .listRowBackground(JaceColor.bg)
                    }
                    ForEach(f.friends.sorted(by: dmOrder)) { p in
                        NavigationLink(value: Route.chat(.direct(p.uuid), p.shownName)) {
                            PersonRow(person: p, line: p.online ? describe(p) : "Offline")
                        }
                        .listRowBackground(JaceColor.bg)
                        .contextMenu {
                            Button { router.go(.profile(p.uuid, nil)) } label: { Label("Profile", systemImage: "person") }
                            Button { store.calls.call(p.uuid, name: p.shownName) } label: { Label("Call", systemImage: "phone") }
                            Button { toggleMute(p.uuid) } label: { Label(muted.contains(p.uuid) ? "Unmute" : "Mute", systemImage: "bell.slash") }
                            Button(role: .destructive) { removing = p } label: { Label("Remove friend", systemImage: "person.badge.minus") }
                        }
                    }
                }
            } else {
                Text("Loading…").foregroundStyle(JaceColor.muted)
            }
        }
        .jaceList()
        .navigationTitle("Chats")
        .refreshable { await store.refreshAll() }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { router.go(.newGroup) } label: { Image(systemName: "person.3") }.accessibilityLabel("New group chat")
                Button { adding = true } label: { Image(systemName: "person.badge.plus") }.accessibilityLabel("Add friend")
            }
        }
        .sheet(isPresented: $adding) { AddFriendView().environmentObject(store) }
        .confirmationDialog("Remove \(removing?.shownName ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { p in
            Button("Remove friend", role: .destructive) { store.friendAction { try await $0.removeFriend(p.uuid) } }
        } message: { _ in Text("You won't be friends any more. Your messages stay.") }
    }

    func toggleMute(_ id: String) {
        let muted = store.me?.prefs.muted ?? []
        store.saveSettings(["muted": muted.contains(id) ? muted.filter { $0 != id } : muted + [id]])
    }

    func dmOrder(_ a: Person, _ b: Person) -> Bool {
        if (a.unread ?? 0) != (b.unread ?? 0) { return (a.unread ?? 0) > (b.unread ?? 0) }
        if a.online != b.online { return a.online }
        return a.shownName.lowercased() < b.shownName.lowercased()
    }
}

/// Send a friend request by Minecraft or Jace name.
struct AddFriendView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    @State private var result: String?
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $name)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focused).submitLabel(.send).onSubmit { Task { await send() } }
                        .onChange(of: name) { _ in result = nil }
                } footer: { Text("Their @handle, or their Minecraft username.") }
                if let r = result { Text(r).foregroundStyle(failed ? JaceColor.red : JaceColor.green) }
            }
            .scrollContentBackground(.hidden)
            .background(JaceColor.bg)
            .navigationTitle("Add a friend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }

    func send() async {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let status = try await store.session.api.addFriend(n)
            result = status == "accepted" ? "You're now friends with \(n)!" : "Friend request sent to \(n)."
            failed = false
            name = ""
            await store.refreshFriends()
        } catch {
            result = error.localizedDescription
            failed = true
        }
    }
}

struct GroupRow: View {
    let group: Group
    var muted = false
    var body: some View {
        HStack(spacing: 12) {
            IconPic(name: group.name, url: group.icon_url, size: 44, round: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(group.name).fontWeight(.semibold).lineLimit(1)
                Text("\(group.members.count) members").font(.footnote).foregroundStyle(JaceColor.muted)
            }
            Spacer()
            if muted { Image(systemName: "bell.slash").foregroundStyle(JaceColor.muted) }
            if group.unread > 0 { UnreadBadge(n: group.unread) }
        }
    }
}

struct UnreadBadge: View {
    let n: Int
    var body: some View {
        Text("\(n)").font(.caption2.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(JaceColor.red, in: Capsule())
    }
}

/// Your servers; tap one to open it, or add one.
struct ServersView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: Router
    var body: some View {
        List {
            if store.servers.isEmpty { Text("You're not in any servers yet. Tap Add to make one or join one with an invite.").foregroundStyle(JaceColor.muted) }
            ForEach(store.servers) { s in
                NavigationLink(value: Route.server(s.id, s.name)) {
                    HStack(spacing: 12) {
                        IconPic(name: s.name, url: s.icon_url)
                        Text(s.name).fontWeight(.semibold)
                        Spacer()
                        if s.unread > 0 { UnreadBadge(n: s.unread) }
                    }
                }
                .listRowBackground(JaceColor.bg)
            }
        }
        .jaceList()
        .navigationTitle("Servers")
        .refreshable { await store.refreshServers() }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Add") { router.go(.addServer("")) } } }
    }
}
