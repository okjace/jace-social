import Foundation

// Mirrors server/lib/client.ts (the parts this app uses). Anything the server might leave out is
// optional, and unknown fields are ignored.

struct Person: Codable {
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
               display_name: display_name, handle: handle)
    }
}

struct FriendsData: Codable {
    var friends: [Person]?
    var incoming: [Person]?
    var outgoing: [Person]?
    /// people you chat with who aren't friends (they let anyone message them)
    var others: [Person]?
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
}

struct ServerDetail: Codable {
    var server: ServerInfo
    var channels: [Channel]?
    var members: [Person]?
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
