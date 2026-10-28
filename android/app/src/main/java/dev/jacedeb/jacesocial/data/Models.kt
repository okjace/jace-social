package dev.jacedeb.jacesocial.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Mirrors server/lib/client.ts. Unknown fields are ignored, so the server can add more.

@Serializable
data class Activity(
    val type: String = "",
    val version: String? = null,
    val loader: String? = null,
    val server: String? = null,
    val world: String? = null,
    val modpack: String? = null,
    val started_at: String? = null,
)

@Serializable
data class Link(val label: String = "", val url: String = "")

@Serializable
data class Person(
    val uuid: String,
    val name: String = "",
    val online: Boolean = false,
    val status: String = "offline",
    val uses_jace: Boolean = false,
    val activity: Activity? = null,
    val last_seen: String? = null,
    val custom_status: String? = null,
    val status_emoji: String? = null,
    val minecraft_name: String? = null,
    val jace_name: String? = null,
    val avatar_url: String? = null,
    val bio: String? = null,
    val pronouns: String? = null,
    val accent_color: String? = null,
    val links: List<Link> = emptyList(),
    val unread: Int = 0,
    val role: String? = null,
    val banner_url: String? = null,
    val is_bot: Boolean = false,
    val bot_owner: String? = null,
    val nickname: String? = null,
    val roles: List<String> = emptyList(),
    val display_name: String? = null,
    val handle: String? = null,
    val joined_at: String? = null,
    val timeout_until: String? = null,
) {
    val shownName: String get() = nickname?.takeIf { it.isNotBlank() } ?: display_name?.takeIf { it.isNotBlank() } ?: name
}

@Serializable
data class Realtime(val url: String = "", val key: String = "")

@Serializable
data class Me(
    val uuid: String,
    val name: String = "",
    val display_name: String? = null,
    val avatar_url: String? = null,
    val banner_url: String? = null,
    val status: String = "online",
    val custom_status: String? = null,
    val status_emoji: String? = null,
    val bio: String? = null,
    val pronouns: String? = null,
    val accent_color: String? = null,
    val links: List<Link> = emptyList(),
    val minecraft_name: String? = null,
    val jace_name: String? = null,
    val handle: String? = null,
    /** when the handle can change again (null: now) */
    val handle_change_at: String? = null,
    val minecraft_linked: Boolean = false,
    val jace_linked: Boolean = false,
    val inbox: String = "",
    val realtime: Realtime = Realtime(),
    val settings: Settings = Settings(),
    val onboarded: Boolean = true,
    val is_bot: Boolean = false,
) {
    val shownName: String get() = display_name?.takeIf { it.isNotBlank() } ?: name
    fun asPerson() = Person(uuid, name, online = status != "invisible", status = status, avatar_url = avatar_url,
        custom_status = custom_status, status_emoji = status_emoji, display_name = display_name, is_bot = is_bot,
        bio = bio, pronouns = pronouns, accent_color = accent_color, links = links, banner_url = banner_url,
        minecraft_name = minecraft_name, jace_name = jace_name, handle = handle)
}

/** Settings that follow you to every device (Settings -> Appearance, Notifications, Links, Advanced). */
@Serializable
data class Settings(
    val theme: String? = null,              // dark | light | midnight | forest | system
    val accent: String? = null,
    val font_scale: Double? = null,
    val compact: Boolean? = null,
    val reduce_motion: Boolean? = null,
    val show_embeds: Boolean? = null,
    val show_avatars: Boolean? = null,
    val sounds: Boolean? = null,
    val desktop_notifications: Boolean? = null,
    val notify: String? = null,             // all | mentions | none
    val link_warning: Boolean? = null,
    val trusted_domains: List<String>? = null,
    val muted: List<String>? = null,
    val time_format: String? = null,        // 12h | 24h
    val send_on_enter: Boolean? = null,
    val developer: Boolean? = null,
)

@Serializable
data class FriendsData(
    val friends: List<Person> = emptyList(),
    val incoming: List<Person> = emptyList(),
    val outgoing: List<Person> = emptyList(),
    /** the official Jace bot (always there, first in Direct messages) */
    val jace: Person? = null,
    /** people you chat with who aren't friends (they let anyone message them) */
    val others: List<Person> = emptyList(),
)

/** The Jace bot's "delete my account" answers carry a marker the website turns into a button
 *  (server/lib/deleteMark.ts); the apps show the words without it. */
fun withoutBotMarks(text: String) =
    text.replace("[[delete-account-now]]", "").replace("[[delete-account]]", "").trim()

/** What signing in gives: the session token and where live events come from. */
@Serializable
data class SignedIn(
    val token: String,
    val uuid: String = "",
    val name: String = "",
    val inbox: String = "",
    val realtime: Realtime = Realtime(),
)

@Serializable
data class JaceStart(val url: String, val state: String, val poll_key: String)

@Serializable
data class DeviceCode(
    val user_code: String,
    val verification_uri: String,
    val interval: Int = 5,
    val expires_at: String? = null,
    val ticket: String,
)

// --- chats

@Serializable
data class Attachment(val url: String = "", val name: String = "", val type: String = "", val size: Long = 0,
                      val width: Int? = null, val height: Int? = null)

@Serializable
data class Embed(val url: String = "", val title: String? = null, val description: String? = null, val image: String? = null,
                 val site: String? = null, val color: String? = null, val type: String = "link")

@Serializable
data class Reaction(val emoji: String, val count: Int = 1, val me: Boolean = false)

@Serializable
data class Message(
    val id: Long,
    val sender: String? = null,
    val body: String = "",
    val created_at: String = "",
    val edited_at: String? = null,
    val kind: String? = null,
    val read_at: String? = null,
    val recipient: String? = null,
    val channel_id: String? = null,
    val reply_to: Long? = null,
    val attachments: List<Attachment> = emptyList(),
    val embeds: List<Embed> = emptyList(),
    val reactions: List<Reaction> = emptyList(),
    val mentions: List<String> = emptyList(),
    val pinned_at: String? = null,
)

@Serializable
data class ReplyPreview(val id: Long, val sender: String? = null, val body: String = "", val attachments: Int = 0)

@Serializable
data class MessagesPage(
    val messages: List<Message> = emptyList(),
    val replies: Map<String, ReplyPreview> = emptyMap(),
    val people: Map<String, Person> = emptyMap(),
    val perms: Long? = null,
)

@Serializable
data class SentMessage(val message: Message)

@Serializable
data class Group(val id: String, val name: String = "", val icon_url: String? = null, val owner: String = "",
                 val members: List<Person> = emptyList(), val unread: Int = 0, val last_message_at: String? = null)

@Serializable
data class GroupsData(val groups: List<Group> = emptyList())

@Serializable
data class ServerItem(val id: String, val name: String = "", val icon_url: String? = null, val role: String = "", val unread: Int = 0)

@Serializable
data class ServersData(val servers: List<ServerItem> = emptyList())

/** Where messages go: a friend (direct messages) or a channel (group chat or server channel). */
sealed class ChatTarget {
    abstract val key: String
    data class Direct(val uuid: String) : ChatTarget() { override val key = "dm:$uuid" }
    data class Channel(val id: String) : ChatTarget() { override val key = "ch:$id" }
}

@Serializable
data class WelcomeChannel(val id: String = "", val description: String? = null, val emoji: String? = null)

@Serializable
data class Welcome(val message: String? = null, val channels: List<WelcomeChannel> = emptyList())

@Serializable
data class OnboardingOption(val label: String = "", val emoji: String? = null, val role_ids: List<String> = emptyList())

/** A question new members answer; each answer gives roles. */
@Serializable
data class OnboardingQuestion(val question: String = "", val multiple: Boolean = false, val options: List<OnboardingOption> = emptyList())

@Serializable
data class ServerInfo(val id: String, val name: String = "", val icon_url: String? = null, val description: String? = null,
                      val owner: String = "", val banner_url: String? = null, val accent_color: String? = null,
                      val invite_code: String? = null, val vanity: String? = null, val rules: String? = null,
                      val welcome: Welcome? = null, val onboarding: List<OnboardingQuestion> = emptyList(),
                      val system_channel: String? = null, val invites_paused: Boolean = false)

/** A channel in a server: text, announcement, voice, or a category that holds others (parent_id). */
@Serializable
data class Channel(val id: String, val name: String = "", val topic: String? = null, val kind: String = "text",
                   val parent_id: String? = null, val position: Int = 0, val unread: Int = 0, val perms: Long? = null,
                   val slowmode: Int = 0, val user_limit: Int = 0)

@Serializable
data class Role(val id: String, val name: String = "", val color: String? = null, val icon: String? = null,
                val position: Int = 0, val permissions: Long = 0, val hoist: Boolean = false, val mentionable: Boolean = false,
                val is_default: Boolean = false)

/** A channel's permission change for one role or member: allowed and denied bits. */
@Serializable
data class Override(val channel_id: String, val target_type: String, val target_id: String, val allow: Long = 0, val deny: Long = 0)

/** Someone in a voice channel right now. */
@Serializable
data class VoiceState(val channel_id: String, val uuid: String, val muted: Boolean = false, val deafened: Boolean = false,
                      val streaming: Boolean = false)

/** GET /servers/{id}: the server, the channels you can see, roles, members, who's in voice. */
@Serializable
data class ServerDetail(val server: ServerInfo, val perms: Long = 0, val owner: Boolean = false, val top: Double = 0.0,
                        val roles: List<Role> = emptyList(), val channels: List<Channel> = emptyList(),
                        val members: List<Person> = emptyList(), val overrides: List<Override> = emptyList(),
                        val voice: List<VoiceState> = emptyList(), val onboarded: Boolean = true)

/** Permission bits (server/lib/permbits.ts). */
object P {
    const val VIEW = 1L; const val SEND = 2L; const val ATTACH = 4L; const val REACT = 8L; const val MENTION_EVERYONE = 16L
    const val MANAGE_MESSAGES = 32L; const val MANAGE_CHANNELS = 64L; const val MANAGE_ROLES = 128L; const val MANAGE_SERVER = 256L
    const val KICK = 512L; const val BAN = 1024L; const val INVITE = 2048L; const val CHANGE_NICK = 4096L; const val MANAGE_NICKS = 8192L
    const val CONNECT = 16384L; const val SPEAK = 32768L; const val STREAM = 65536L; const val TIMEOUT = 131072L
    const val MANAGE_BOTS = 262144L; const val ADMIN = 1073741824L
    const val ALL = VIEW or SEND or ATTACH or REACT or MENTION_EVERYONE or MANAGE_MESSAGES or MANAGE_CHANNELS or MANAGE_ROLES or
        MANAGE_SERVER or KICK or BAN or INVITE or CHANGE_NICK or MANAGE_NICKS or CONNECT or SPEAK or STREAM or TIMEOUT or MANAGE_BOTS or ADMIN
    fun has(perms: Long, p: Long) = (perms and p) == p || (perms and ADMIN) == ADMIN

    /** For settings screens: bit, name, description, also settable per channel. */
    data class Info(val bit: Long, val name: String, val desc: String, val channel: Boolean)
    val GROUPS: List<Pair<String, List<Info>>> = listOf(
        "General" to listOf(Info(VIEW, "See channels", "Read messages and see who's in voice", true),
            Info(MANAGE_CHANNELS, "Manage channels", "Create, edit and delete channels", true),
            Info(MANAGE_ROLES, "Manage roles", "Create roles and give them to people below their own", true),
            Info(MANAGE_SERVER, "Manage server", "Name, icon, links, onboarding and other settings", false),
            Info(MANAGE_BOTS, "Add bots", "Add bots to the server", false),
            Info(INVITE, "Create invites", "See and share the invite link", false)),
        "Members" to listOf(Info(CHANGE_NICK, "Change nickname", "Set their own nickname here", false),
            Info(MANAGE_NICKS, "Manage nicknames", "Change other people's nicknames", false),
            Info(KICK, "Kick members", "Remove people (they can join again)", false),
            Info(BAN, "Ban members", "Remove people for good", false),
            Info(TIMEOUT, "Time out members", "Stop people talking for a while", false)),
        "Text" to listOf(Info(SEND, "Send messages", "", true), Info(ATTACH, "Attach files", "Send pictures and files", true),
            Info(REACT, "Add reactions", "", true), Info(MENTION_EVERYONE, "Mention @everyone", "And roles that can't normally be mentioned", true),
            Info(MANAGE_MESSAGES, "Manage messages", "Delete anyone's messages, pin messages, skip slowmode", true)),
        "Voice" to listOf(Info(CONNECT, "Connect", "Join voice channels", true), Info(SPEAK, "Speak", "", true),
            Info(STREAM, "Video", "Turn on their camera and share their screen", true)),
        "Advanced" to listOf(Info(ADMIN, "Administrator", "Every permission, everywhere. Give this carefully.", false)),
    )
}

// --- profiles, invites, bots, calls

@Serializable
data class MutualServer(val id: String = "", val name: String = "", val icon_url: String? = null)

/** GET /users/{id}: someone's profile, whether you're friends, servers you share. */
@Serializable
data class FullProfile(
    val uuid: String, val name: String = "", val online: Boolean = false, val status: String = "offline",
    val activity: Activity? = null, val last_seen: String? = null, val custom_status: String? = null, val status_emoji: String? = null,
    val minecraft_name: String? = null, val jace_name: String? = null, val avatar_url: String? = null, val banner_url: String? = null,
    val bio: String? = null, val pronouns: String? = null, val accent_color: String? = null, val links: List<Link> = emptyList(),
    val is_bot: Boolean = false, val bot_owner: String? = null, val display_name: String? = null, val handle: String? = null,
    val is_friend: Boolean = false, val is_you: Boolean = false, val mutual_servers: List<MutualServer> = emptyList(),
) {
    fun asPerson() = Person(uuid, name, online, status, activity = activity, avatar_url = avatar_url, custom_status = custom_status,
        status_emoji = status_emoji, is_bot = is_bot, display_name = display_name)
}

@Serializable
data class InviteServer(val id: String, val name: String = "", val icon_url: String? = null, val description: String? = null,
                        val banner_url: String? = null, val members: Int = 0, val online: Int = 0)

@Serializable
data class InvitePreview(val server: InviteServer, val joined: Boolean = false)

@Serializable
data class JoinedServer(val server: InviteServer, val already: Boolean = false, val onboarding: Boolean = false)

@Serializable
data class CommandOption(val name: String = "", val description: String? = null, val required: Boolean = false)

/** A bot's slash command in a chat. */
@Serializable
data class Command(val bot: String = "", val bot_name: String = "", val avatar_url: String? = null, val name: String = "",
                   val description: String = "", val options: List<CommandOption> = emptyList())

/** One of your bots. */
@Serializable
data class Bot(val uuid: String, val name: String = "", val avatar_url: String? = null, val bio: String? = null,
               val bot_public: Boolean = false, val bot_enabled: Boolean = true, val has_program: Boolean = false,
               val has_code: Boolean = false) {
    fun asPerson() = Person(uuid, name, avatar_url = avatar_url, is_bot = true, online = true, status = "online")
}

@Serializable
data class BotLog(val id: Long, val at: String = "", val server_id: String? = null, val channel_id: String? = null,
                  val kind: String = "", val detail: String = "")

@Serializable
data class BotActivityPage(val entries: List<BotLog> = emptyList(), val channels: Map<String, String> = emptyMap(),
                           val servers: Map<String, String> = emptyMap())

/** POST /bots/{id}/code with a pretend message: what the code would do. */
@Serializable
data class TryAction(val t: String = "", val text: String? = null, val channel: String? = null, val emoji: String? = null, val role: String? = null)

@Serializable
data class TryResult(val actions: List<TryAction> = emptyList(), val logs: List<String> = emptyList(),
                     val storage: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(), val error: String? = null)

@Serializable
data class Ban(val uuid: String, val reason: String? = null, val created_at: String = "", val person: Person? = null)

@Serializable
data class BotLink(val token: String, val uuid: String = "", val name: String = "", val avatar_url: String? = null)

@Serializable
data class UploadSlot(val path: String = "", val token: String = "", val upload_url: String = "", val url: String = "")

@Serializable
data class IceServer(val urls: kotlinx.serialization.json.JsonElement, val username: String? = null, val credential: String? = null)

@Serializable
data class IceServers(val ice_servers: List<IceServer> = emptyList())

@Serializable
data class Signal(val id: Long = 0, val sdp: String = "", val kind: String = "", val sender: String = "", val call_id: String = "",
                  val name: String = "")

@Serializable
data class SignalData(val signal: Signal)

@Serializable
data class Participant(val uuid: String, val muted: Boolean = false, val deafened: Boolean = false, val streaming: Boolean = false,
                       val person: Person? = null)

@Serializable
data class VoiceJoin(val participants: List<Participant> = emptyList(), val can_speak: Boolean = true, val can_stream: Boolean = true)

@Serializable
data class Download(val id: String = "", val url: String = "")

/** GET /releases/mobile: the newest phone app. */
@Serializable
data class Release(val version: String = "", val notes: String = "", val page: String = "", val downloads: List<Download> = emptyList())

/** An account signed in on this phone (the account switcher). */
@Serializable
data class SavedAccount(val uuid: String, val name: String = "", val avatar_url: String? = null, val token: String, val is_bot: Boolean = false)
