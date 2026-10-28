import Foundation

// Mirrors server/lib/client.ts. Anything the server might leave out is optional (Swift's decoding
// doesn't fill in defaults), and unknown fields are ignored.

struct Activity: Codable, Hashable {
    var type: String = ""
    var version: String?
    var loader: String?
    var server: String?
    var world: String?
    var modpack: String?
    var started_at: String?
}

struct Link: Codable, Hashable {
    var label: String = ""
    var url: String = ""
}

struct Person: Codable, Hashable, Identifiable {
    var uuid: String
    var name: String = ""
    var online: Bool = false
    var status: String = "offline"
    var activity: Activity?
    var last_seen: String?
    var custom_status: String?
    var status_emoji: String?
    var minecraft_name: String?
    var jace_name: String?
    var avatar_url: String?
    var banner_url: String?
    var bio: String?
    var pronouns: String?
    var accent_color: String?
    var links: [Link]?
    var unread: Int?
    var is_bot: Bool?
    var bot_owner: String?
    var nickname: String?
    var display_name: String?
    var handle: String?
    var roles: [String]?
    var joined_at: String?
    var timeout_until: String?

    var id: String { uuid }
    var shownName: String {
        if let n = nickname, !n.isEmpty { return n }
        if let n = display_name, !n.isEmpty { return n }
        return name
    }
    var bot: Bool { is_bot == true }
}

struct Realtime: Codable, Hashable {
    var url: String = ""
    var key: String = ""
}

/// Settings that follow you to every device (Settings -> Appearance, Notifications, Links, Advanced).
struct Settings: Codable, Hashable {
    var theme: String?                 // dark | light | midnight | forest | system
    var accent: String?
    var font_scale: Double?
    var compact: Bool?
    var reduce_motion: Bool?
    var show_embeds: Bool?
    var show_avatars: Bool?
    var sounds: Bool?
    var desktop_notifications: Bool?
    var notify: String?                // all | mentions | none
    var link_warning: Bool?
    var trusted_domains: [String]?
    var muted: [String]?
    var time_format: String?           // 12h | 24h
    var send_on_enter: Bool?
    var developer: Bool?
}

struct Me: Codable {
    var uuid: String
    var name: String = ""
    var display_name: String?
    var avatar_url: String?
    var banner_url: String?
    var status: String = "online"
    var custom_status: String?
    var status_emoji: String?
    var bio: String?
    var pronouns: String?
    var accent_color: String?
    var links: [Link]?
    var minecraft_name: String?
    var jace_name: String?
    var handle: String?
    /// when the handle can change again (nil: now)
    var handle_change_at: String?
    var minecraft_linked: Bool?
    var jace_linked: Bool?
    var inbox: String = ""
    var realtime: Realtime = Realtime()
    var settings: Settings?
    var onboarded: Bool?
    var is_bot: Bool?

    var shownName: String { (display_name?.isEmpty == false ? display_name : nil) ?? name }
    var prefs: Settings { settings ?? Settings() }
    var asPerson: Person {
        Person(uuid: uuid, name: name, online: status != "invisible", status: status, custom_status: custom_status,
               status_emoji: status_emoji, minecraft_name: minecraft_name, jace_name: jace_name, avatar_url: avatar_url,
               banner_url: banner_url, bio: bio, pronouns: pronouns, accent_color: accent_color, links: links, is_bot: is_bot,
               display_name: display_name, handle: handle)
    }
}

struct FriendsData: Codable {
    var friends: [Person] = []
    var incoming: [Person] = []
    var outgoing: [Person] = []
    /// the official Jace bot (always there, first in Direct messages)
    var jace: Person?
    /// people you chat with who aren't friends (they let anyone message them)
    var others: [Person]?
}

/// The Jace bot's "delete my account" answers carry a marker the website turns into a button
/// (server/lib/deleteMark.ts); the apps show the words without it.
func withoutBotMarks(_ text: String) -> String {
    text.replacingOccurrences(of: "[[delete-account-now]]", with: "").replacingOccurrences(of: "[[delete-account]]", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// What signing in gives: the session token and where live events come from.
struct SignedIn: Codable {
    var token: String
    var uuid: String?
    var name: String?
    var inbox: String?
}

struct JaceStart: Codable {
    var url: String
    var state: String
    var poll_key: String
}

struct DeviceCode: Codable, Equatable {
    var user_code: String
    var verification_uri: String
    var interval: Int?
    var ticket: String
}

// --- chats

struct Attachment: Codable, Hashable {
    var url: String = ""
    var name: String = ""
    var type: String = ""
    var size: Int?
    var width: Int?
    var height: Int?
}

struct Embed: Codable, Hashable {
    var url: String = ""
    var title: String?
    var description: String?
    var image: String?
    var site: String?
}

struct Reaction: Codable, Hashable {
    var emoji: String
    var count: Int = 1
    var me: Bool = false
}

struct Message: Codable, Hashable, Identifiable {
    var id: Int
    var sender: String?
    var body: String = ""
    var created_at: String = ""
    var edited_at: String?
    var kind: String?
    var reply_to: Int?
    var attachments: [Attachment]?
    var embeds: [Embed]?
    var reactions: [Reaction]?
    var mentions: [String]?
    var pinned_at: String?
}

struct ReplyPreview: Codable, Hashable {
    var id: Int
    var sender: String?
    var body: String = ""
}

struct MessagesPage: Codable {
    var messages: [Message] = []
    var replies: [String: ReplyPreview]?
    var people: [String: Person]?
    var perms: Int?
}

struct SentMessage: Codable { var message: Message }

struct Group: Codable, Hashable, Identifiable {
    var id: String
    var name: String = ""
    var icon_url: String?
    var owner: String?
    var members: [Person] = []
    var unread: Int = 0
}

struct GroupsData: Codable { var groups: [Group] = [] }

struct ServerItem: Codable, Hashable, Identifiable {
    var id: String
    var name: String = ""
    var icon_url: String?
    var unread: Int = 0
}

struct ServersData: Codable { var servers: [ServerItem] = [] }

/// Where messages go: a friend (direct messages) or a channel (group chat or server channel).
enum ChatTarget: Hashable {
    case direct(String)
    case channel(String)

    var key: String {
        switch self {
        case .direct(let u): return "dm:\(u)"
        case .channel(let c): return "ch:\(c)"
        }
    }
}

// --- servers

struct WelcomeChannel: Codable, Hashable {
    var id: String = ""
    var description: String?
    var emoji: String?
}

struct Welcome: Codable, Hashable {
    var message: String?
    var channels: [WelcomeChannel]?
}

struct OnboardingOption: Codable, Hashable {
    var label: String = ""
    var emoji: String?
    var role_ids: [String] = []
}

/// A question new members answer; each answer gives roles.
struct OnboardingQuestion: Codable, Hashable {
    var question: String = ""
    var multiple: Bool = false
    var options: [OnboardingOption] = []
}

struct ServerInfo: Codable, Hashable {
    var id: String
    var name: String = ""
    var icon_url: String?
    var description: String?
    var owner: String?
    var banner_url: String?
    var accent_color: String?
    var invite_code: String?
    var vanity: String?
    var rules: String?
    var welcome: Welcome?
    var onboarding: [OnboardingQuestion]?
    var system_channel: String?
    var invites_paused: Bool?
}

/// A channel in a server: text, announcement, voice, or a category that holds others (parent_id).
struct Channel: Codable, Hashable, Identifiable {
    var id: String
    var name: String = ""
    var topic: String?
    var kind: String?
    var parent_id: String?
    var position: Int?
    var unread: Int?
    var slowmode: Int?
    var user_limit: Int?

    var type: String { kind ?? "text" }
    var order: Int { position ?? 0 }
}

struct Role: Codable, Hashable, Identifiable {
    var id: String
    var name: String = ""
    var color: String?
    var icon: String?
    var position: Int = 0
    var permissions: Int?
    var hoist: Bool?
    var mentionable: Bool?
    var is_default: Bool?

    var everyone: Bool { is_default == true }
    var perms: Int { permissions ?? 0 }
}

/// A channel's permission change for one role or member: allowed and denied bits.
struct Override: Codable, Hashable {
    var channel_id: String
    var target_type: String
    var target_id: String
    var allow: Int = 0
    var deny: Int = 0
}

/// Someone in a voice channel right now.
struct VoiceState: Codable, Hashable {
    var channel_id: String
    var uuid: String
    var muted: Bool?
    var deafened: Bool?
    var streaming: Bool?
}

/// GET /servers/{id}: the server, the channels you can see, roles, members, who's in voice.
struct ServerDetail: Codable {
    var server: ServerInfo
    var perms: Int?
    var owner: Bool?
    var top: Double?
    var roles: [Role]?
    var channels: [Channel] = []
    var members: [Person] = []
    var overrides: [Override]?
    var voice: [VoiceState]?
    var onboarded: Bool?

    var can: Int { perms ?? 0 }
    var isOwner: Bool { owner == true }
    var topRole: Double { top ?? 0 }
    var allRoles: [Role] { roles ?? [] }
}

/// Permission bits (server/lib/permbits.ts).
enum P {
    static let VIEW = 1, SEND = 2, ATTACH = 4, REACT = 8, MENTION_EVERYONE = 16, MANAGE_MESSAGES = 32
    static let MANAGE_CHANNELS = 64, MANAGE_ROLES = 128, MANAGE_SERVER = 256, KICK = 512, BAN = 1024
    static let INVITE = 2048, CHANGE_NICK = 4096, MANAGE_NICKS = 8192, CONNECT = 16384, SPEAK = 32768
    static let STREAM = 65536, TIMEOUT = 131072, MANAGE_BOTS = 262144, ADMIN = 1073741824
    static let ALL = [VIEW, SEND, ATTACH, REACT, MENTION_EVERYONE, MANAGE_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_SERVER,
                      KICK, BAN, INVITE, CHANGE_NICK, MANAGE_NICKS, CONNECT, SPEAK, STREAM, TIMEOUT, MANAGE_BOTS, ADMIN].reduce(0, |)
    static func has(_ perms: Int, _ p: Int) -> Bool { perms & p == p || perms & ADMIN == ADMIN }

    struct Info: Hashable { let bit: Int; let name: String; let desc: String; let channel: Bool }
    static let groups: [(String, [Info])] = [
        ("General", [Info(bit: VIEW, name: "See channels", desc: "Read messages and see who's in voice", channel: true),
                     Info(bit: MANAGE_CHANNELS, name: "Manage channels", desc: "Create, edit and delete channels", channel: true),
                     Info(bit: MANAGE_ROLES, name: "Manage roles", desc: "Create roles and give them to people below their own", channel: true),
                     Info(bit: MANAGE_SERVER, name: "Manage server", desc: "Name, icon, links, onboarding and other settings", channel: false),
                     Info(bit: MANAGE_BOTS, name: "Add bots", desc: "Add bots to the server", channel: false),
                     Info(bit: INVITE, name: "Create invites", desc: "See and share the invite link", channel: false)]),
        ("Members", [Info(bit: CHANGE_NICK, name: "Change nickname", desc: "Set their own nickname here", channel: false),
                     Info(bit: MANAGE_NICKS, name: "Manage nicknames", desc: "Change other people's nicknames", channel: false),
                     Info(bit: KICK, name: "Kick members", desc: "Remove people (they can join again)", channel: false),
                     Info(bit: BAN, name: "Ban members", desc: "Remove people for good", channel: false),
                     Info(bit: TIMEOUT, name: "Time out members", desc: "Stop people talking for a while", channel: false)]),
        ("Text", [Info(bit: SEND, name: "Send messages", desc: "", channel: true),
                  Info(bit: ATTACH, name: "Attach files", desc: "Send pictures and files", channel: true),
                  Info(bit: REACT, name: "Add reactions", desc: "", channel: true),
                  Info(bit: MENTION_EVERYONE, name: "Mention @everyone", desc: "And roles that can't normally be mentioned", channel: true),
                  Info(bit: MANAGE_MESSAGES, name: "Manage messages", desc: "Delete anyone's messages, pin messages, skip slowmode", channel: true)]),
        ("Voice", [Info(bit: CONNECT, name: "Connect", desc: "Join voice channels", channel: true),
                   Info(bit: SPEAK, name: "Speak", desc: "", channel: true),
                   Info(bit: STREAM, name: "Video", desc: "Turn on their camera and share their screen", channel: true)]),
        ("Advanced", [Info(bit: ADMIN, name: "Administrator", desc: "Every permission, everywhere. Give this carefully.", channel: false)]),
    ]
}

// --- profiles, invites, bots, calls

struct MutualServer: Codable, Hashable { var id: String?; var name: String?; var icon_url: String? }

/// GET /users/{id}: someone's profile, whether you're friends, servers you share.
struct FullProfile: Codable {
    var uuid: String
    var name: String = ""
    var online: Bool?
    var status: String?
    var activity: Activity?
    var last_seen: String?
    var custom_status: String?
    var status_emoji: String?
    var minecraft_name: String?
    var jace_name: String?
    var avatar_url: String?
    var banner_url: String?
    var bio: String?
    var pronouns: String?
    var accent_color: String?
    var links: [Link]?
    var is_bot: Bool?
    var bot_owner: String?
    var display_name: String?
    var handle: String?
    var is_friend: Bool?
    var is_you: Bool?
    var mutual_servers: [MutualServer]?

    var asPerson: Person {
        Person(uuid: uuid, name: name, online: online == true, status: status ?? "offline", activity: activity, custom_status: custom_status,
               status_emoji: status_emoji, avatar_url: avatar_url, is_bot: is_bot, display_name: display_name)
    }
}

struct InviteServer: Codable { var id: String; var name: String = ""; var icon_url: String?; var description: String?; var members: Int?; var online: Int? }
struct InvitePreview: Codable { var server: InviteServer; var joined: Bool? }
struct JoinedServer: Codable { var server: InviteServer; var already: Bool?; var onboarding: Bool? }

struct CommandOption: Codable, Hashable { var name: String = ""; var description: String?; var required: Bool? }

/// A bot's slash command in a chat.
struct Command: Codable, Hashable {
    var bot: String = ""
    var bot_name: String?
    var name: String = ""
    var description: String?
    var options: [CommandOption]?
}

/// One of your bots.
struct Bot: Codable, Hashable, Identifiable {
    var uuid: String
    var name: String = ""
    var avatar_url: String?
    var bio: String?
    var bot_public: Bool?
    var bot_enabled: Bool?
    var has_program: Bool?
    var has_code: Bool?
    var id: String { uuid }
    var asPerson: Person { Person(uuid: uuid, name: name, online: true, status: "online", avatar_url: avatar_url, bio: bio, is_bot: true) }
}

struct BotLog: Codable, Identifiable { var id: Int; var at: String = ""; var server_id: String?; var channel_id: String?; var kind: String = ""; var detail: String = "" }
struct BotActivityPage: Codable { var entries: [BotLog] = []; var channels: [String: String]?; var servers: [String: String]? }

struct Ban: Codable, Identifiable { var uuid: String; var reason: String?; var created_at: String?; var person: Person?; var id: String { uuid } }

struct BotLink: Codable { var token: String; var uuid: String; var name: String = ""; var avatar_url: String? }

struct UploadSlot: Codable { var path: String; var token: String; var upload_url: String; var url: String }

struct Signal: Codable { var id: Int?; var sdp: String?; var kind: String?; var sender: String?; var call_id: String?; var name: String? }
struct SignalData: Codable { var signal: Signal }

struct Participant: Codable, Hashable, Identifiable {
    var uuid: String
    var muted: Bool?
    var deafened: Bool?
    var streaming: Bool?
    var person: Person?
    var id: String { uuid }
}

struct VoiceJoin: Codable { var participants: [Participant] = []; var can_speak: Bool?; var can_stream: Bool? }
struct ParticipantsData: Codable { var participants: [Participant] = [] }

struct Download: Codable { var id: String; var url: String }

/// GET /releases/mobile: the newest phone app.
struct Release: Codable, Identifiable { var version: String; var notes: String?; var page: String; var downloads: [Download]?; var id: String { version } }

/// An account signed in on this phone (the account switcher).
struct SavedAccount: Codable, Hashable, Identifiable { var uuid: String; var name: String; var avatar_url: String?; var token: String; var is_bot: Bool?; var id: String { uuid } }
