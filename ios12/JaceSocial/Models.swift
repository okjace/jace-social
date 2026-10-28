import Foundation

// Mirrors server/lib/client.ts (the parts this app uses). Anything the server might leave out is
// optional, and unknown fields are ignored.

struct Person: Codable {
    /// the official Jace bot's id (server/lib/server.ts JACE_BOT)
    static let jaceBot = "00000000000000000000000000000ace"
    var uuid: String
    var name: String?
    var online: Bool?
    var status: String?
    var custom_status: String?
    var status_emoji: String?
    var avatar_url: String?
    var bio: String?
    var pronouns: String?
    var unread: Int?
    var is_bot: Bool?
    var nickname: String?
    var display_name: String?
    var handle: String?
    /// in a server's member list: their role ids
    var roles: [String]?

    var shownName: String {
        if let n = nickname, !n.isEmpty { return n }
        if let n = display_name, !n.isEmpty { return n }
        return name ?? "Someone"
    }
    var statusText: String {
        let custom = [status_emoji, custom_status].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        if !custom.isEmpty { return custom }
        switch status ?? "offline" {
        case "online": return "Online"
        case "idle": return "Idle"
        case "dnd": return "Do not disturb"
        default: return "Offline"
        }
    }
}

struct Realtime: Codable {
    var url: String = ""
    var key: String = ""
}

struct Me: Codable {
    var uuid: String
    var name: String?
    var display_name: String?
    var avatar_url: String?
    var status: String?
    var custom_status: String?
    var status_emoji: String?
    var bio: String?
    var handle: String?
    var minecraft_name: String?
    var jace_name: String?
    var inbox: String?
    var realtime: Realtime?
    var is_bot: Bool?

    var shownName: String { (display_name?.isEmpty == false ? display_name : nil) ?? name ?? "You" }
    var asPerson: Person {
        Person(uuid: uuid, name: name, online: true, status: status, custom_status: custom_status, status_emoji: status_emoji,
               avatar_url: avatar_url, bio: bio, pronouns: nil, unread: nil, is_bot: is_bot, nickname: nil,
               display_name: display_name, handle: handle, roles: nil)
    }
}

struct FriendsData: Codable {
    var friends: [Person]?
    var incoming: [Person]?
    var outgoing: [Person]?
    /// people you chat with who aren't friends (they let anyone message them)
    var others: [Person]?
    /// the official Jace bot (always there, first in Direct messages)
    var jace: Person?
}

struct SignedIn: Codable { var token: String }

struct JaceStart: Codable {
    var url: String
    var state: String
    var poll_key: String
}

struct DeviceCode: Codable {
    var user_code: String
    var verification_uri: String
    var interval: Int?
    var ticket: String
}

// --- chats

struct Attachment: Codable {
    var url: String
    var name: String?
    var type: String?
    var size: Int?
    var width: Int?
    var height: Int?
    var no_preview: Bool?

    var isImage: Bool {
        guard no_preview != true, let t = type, t.hasPrefix("image/") else { return false }
        return t != "image/webp" && t != "image/avif"        // (iOS 12 can't show these)
    }
}

struct Embed: Codable {
    var url: String
    var title: String?
    var description: String?
    var site: String?
}

struct Reaction: Codable {
    var emoji: String
    var count: Int?
    var me: Bool?
}

struct Message: Codable {
    var id: Int
    var sender: String?
    var body: String?
    var created_at: String?
    var edited_at: String?
    var kind: String?
    var reply_to: Int?
    var attachments: [Attachment]?
    var embeds: [Embed]?
    var reactions: [Reaction]?
}

struct ReplyPreview: Codable {
    var id: Int
    var sender: String?
    var body: String?
}

struct MessagesPage: Codable {
    var messages: [Message]?
    var replies: [String: ReplyPreview]?
    var people: [String: Person]?
}

struct SentMessage: Codable { var message: Message }

struct Group: Codable {
    var id: String
    var name: String?
    var owner: String?
    var icon_url: String?
    var members: [Person]?
    var unread: Int?
}

struct GroupsData: Codable { var groups: [Group]? }

struct ServerItem: Codable {
    var id: String
    var name: String?
    var icon_url: String?
    var unread: Int?
}

struct ServersData: Codable { var servers: [ServerItem]? }

struct Channel: Codable {
    var id: String
    var name: String?
    var topic: String?
    var kind: String?
    var parent_id: String?
    var position: Int?
    var unread: Int?
}

struct ServerInfo: Codable {
    var id: String
    var name: String?
    var icon_url: String?
    var description: String?
    var owner: String?
    var invite_code: String?
}

struct Role: Codable {
    var id: String
    var name: String?
    var color: String?
    var position: Int?
    var permissions: Int?
    var is_default: Bool?
}

/// Who's in a voice channel right now (for the channel list).
struct VoiceState: Codable {
    var channel_id: String
    var uuid: String
    var muted: Bool?
}

struct ServerDetail: Codable {
    var server: ServerInfo
    var perms: Int?
    var owner: Bool?
    var roles: [Role]?
    var channels: [Channel]?
    var members: [Person]?
    var voice: [VoiceState]?

    var can: Int { perms ?? 0 }
}

/// Permission bits (server/lib/permbits.ts).
enum P {
    static let VIEW = 1, SEND = 2, ATTACH = 4, REACT = 8, MENTION_EVERYONE = 16, MANAGE_MESSAGES = 32
    static let MANAGE_CHANNELS = 64, MANAGE_ROLES = 128, MANAGE_SERVER = 256, KICK = 512, BAN = 1024
    static let INVITE = 2048, CHANGE_NICK = 4096, MANAGE_NICKS = 8192, CONNECT = 16384, SPEAK = 32768
    static let STREAM = 65536, TIMEOUT = 131072, MANAGE_BOTS = 262144, ADMIN = 1073741824
    static func has(_ perms: Int, _ p: Int) -> Bool { perms & p == p || perms & ADMIN == ADMIN }

    /// For the role editor: (bit, name)
    static let named: [(Int, String)] = [
        (VIEW, "See channels"), (SEND, "Send messages"), (ATTACH, "Attach files"), (REACT, "Add reactions"),
        (MENTION_EVERYONE, "Mention @everyone"), (MANAGE_MESSAGES, "Manage messages"), (MANAGE_CHANNELS, "Manage channels"),
        (MANAGE_ROLES, "Manage roles"), (MANAGE_SERVER, "Manage server"), (MANAGE_BOTS, "Add bots"), (INVITE, "Create invites"),
        (CHANGE_NICK, "Change nickname"), (MANAGE_NICKS, "Manage nicknames"), (KICK, "Kick members"), (BAN, "Ban members"),
        (TIMEOUT, "Time out members"), (CONNECT, "Connect to voice"), (SPEAK, "Speak"), (STREAM, "Video"),
        (ADMIN, "Administrator (everything)"),
    ]
}

struct Ban: Codable {
    var uuid: String
    var reason: String?
    var person: Person?
}

// --- calls and voice channels

struct Signal: Codable { var id: Int?; var sdp: String?; var kind: String?; var sender: String?; var call_id: String?; var name: String? }
struct SignalData: Codable { var signal: Signal }

struct Participant: Codable {
    var uuid: String
    var muted: Bool?
    var deafened: Bool?
    var person: Person?
}

struct VoiceJoin: Codable { var participants: [Participant]?; var can_speak: Bool?; var can_stream: Bool? }
struct ParticipantsData: Codable { var participants: [Participant]? }

// --- bots

struct Bot: Codable {
    var uuid: String
    var name: String?
    var avatar_url: String?
    var bio: String?
    var bot_public: Bool?
    var bot_enabled: Bool?
    var has_code: Bool?
}

struct UploadSlot: Codable {
    var url: String
    var upload_url: String
    var headers: [String: String]?
}

/// Where messages go: a person (direct messages) or a channel (group chat or server channel).
enum ChatTarget: Equatable {
    case direct(String)
    case channel(String)
}

// --- updates

struct Download: Codable { var id: String; var url: String }

/// GET /releases/mobile: the newest phone apps (this one is the "ios12" download).
struct Release: Codable {
    var version: String
    var notes: String?
    var page: String
    var downloads: [Download]?
}
