package dev.jacedeb.jacesocial.data

import dev.jacedeb.jacesocial.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** An error the server explained (its "error" field), or a network problem. */
class ApiError(val status: Int, message: String) : Exception(message)

/** The Jace Social API (docs/api.md). One instance per signed-in account. */
class Api(private val token: () -> String?) {
    val base = BuildConfig.API_BASE
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    /** method + path ("/me") -> the answer's JSON text. Throws ApiError. */
    suspend fun call(method: String, path: String, body: String? = null): String =
        request(method, path, body?.toRequestBody("application/json".toMediaType())
            ?: if (method == "GET" || method == "DELETE") null else "{}".toRequestBody("application/json".toMediaType()))

    /** A picture or file as the whole body (avatars, icons, banners). */
    suspend fun callRaw(path: String, bytes: ByteArray, type: String): String = request("POST", path, bytes.toRequestBody(type.toMediaType()))

    private suspend fun request(method: String, path: String, reqBody: okhttp3.RequestBody?): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$base/api/v1$path").method(method, reqBody)
            .header("User-Agent", "JaceSocialAndroid/${BuildConfig.VERSION_NAME}")
        token()?.let { req.header("Authorization", "Bearer $it") }
        val res = try {
            http.newCall(req.build()).execute()
        } catch (e: IOException) {
            throw ApiError(0, "Can't reach Jace Social - check your internet connection")
        }
        res.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val msg = runCatching { json.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                throw ApiError(it.code, msg ?: "Jace Social error (${it.code})")
            }
            text
        }
    }

    suspend inline fun <reified T> get(path: String): T = json.decodeFromString(call("GET", path))
    suspend inline fun <reified T> post(path: String, body: JsonObject = JsonObject(emptyMap())): T =
        json.decodeFromString(call("POST", path, body.toString()))

    // --- the endpoints so far (more as screens are added)
    suspend fun me(): Me = get("/me")
    suspend fun friends(): FriendsData = get("/friends")
    suspend fun startJace(): JaceStart = post("/auth/jace")
    /** null while the browser part isn't done yet */
    suspend fun pollJace(start: JaceStart): SignedIn? {
        val text = call("GET", "/auth/jace/poll?state=${start.state}&key=${start.poll_key}")
        if (json.parseToJsonElement(text).jsonObject.containsKey("pending")) return null
        return json.decodeFromString(text)
    }
    suspend fun startMinecraft(): DeviceCode = post("/auth/minecraft")
    suspend fun pollMinecraft(ticket: String): SignedIn? {
        val text = call("POST", "/auth/minecraft/poll", """{"ticket":${kotlinx.serialization.json.JsonPrimitive(ticket)}}""")
        if (json.parseToJsonElement(text).jsonObject.containsKey("pending")) return null
        return json.decodeFromString(text)
    }
    suspend fun signOut() { runCatching { call("POST", "/auth/signout") } }

    // --- chats (direct messages, group chats and server channels share these)
    suspend fun groups(): GroupsData = get("/groups")
    suspend fun servers(): ServersData = get("/servers")
    suspend fun server(id: String): ServerDetail = get("/servers/$id")

    suspend fun messages(t: ChatTarget, before: Long? = null): MessagesPage {
        val page: MessagesPage = when (t) {
            is ChatTarget.Direct -> get("/messages?with=${t.uuid}" + (before?.let { "&before=$it" } ?: ""))
            is ChatTarget.Channel -> get("/channels/${t.id}/messages" + (before?.let { "?before=$it" } ?: ""))
        }
        return page.copy(messages = page.messages.map { if (it.body.contains("[[delete-account")) it.copy(body = withoutBotMarks(it.body)) else it })
    }

    suspend fun send(t: ChatTarget, body: String, replyTo: Long? = null): Message {
        val fields = buildMap<String, kotlinx.serialization.json.JsonElement> {
            put("body", JsonPrimitive(body))
            replyTo?.let { put("reply_to", JsonPrimitive(it)) }
            if (t is ChatTarget.Direct) put("to", JsonPrimitive(t.uuid))
        }
        val path = if (t is ChatTarget.Channel) "/channels/${t.id}/messages" else "/messages"
        return json.decodeFromString<SentMessage>(call("POST", path, JsonObject(fields).toString())).message
    }

    suspend fun edit(t: ChatTarget, id: Long, body: String) {
        call("PATCH", if (t is ChatTarget.Direct) "/messages/direct/$id" else "/messages/$id",
             JsonObject(mapOf("body" to JsonPrimitive(body))).toString())
    }

    suspend fun delete(t: ChatTarget, id: Long) {
        call("DELETE", if (t is ChatTarget.Direct) "/messages/direct/$id" else "/messages/$id")
    }

    suspend fun react(t: ChatTarget, id: Long, emoji: String, on: Boolean) {
        val body = JsonObject(mapOf("scope" to JsonPrimitive(if (t is ChatTarget.Direct) "d" else "c"),
                                    "message_id" to JsonPrimitive(id), "emoji" to JsonPrimitive(emoji)))
        call(if (on) "POST" else "DELETE", "/reactions", body.toString())
    }

    suspend fun typing(t: ChatTarget) {
        runCatching {
            if (t is ChatTarget.Direct) call("POST", "/messages/typing", JsonObject(mapOf("to" to JsonPrimitive(t.uuid))).toString())
            else call("POST", "/channels/${(t as ChatTarget.Channel).id}/typing")
        }
    }

    suspend fun markRead(t: ChatTarget) {
        runCatching {
            if (t is ChatTarget.Direct) call("POST", "/messages/read", JsonObject(mapOf("with" to JsonPrimitive(t.uuid))).toString())
            else call("POST", "/channels/${(t as ChatTarget.Channel).id}/read")
        }
    }

    // friends
    /** Send a friend request by Minecraft or Jace name (@name: Jace only). "accepted" if they'd already asked you. */
    suspend fun addFriend(name: String): String {
        val res = call("POST", "/friends", JsonObject(mapOf("name" to JsonPrimitive(name))).toString())
        return json.parseToJsonElement(res).jsonObject["status"]?.jsonPrimitive?.contentOrNull ?: "pending"
    }
    suspend fun respondFriend(uuid: String, accept: Boolean) {
        call("POST", "/friends/respond", JsonObject(mapOf("uuid" to JsonPrimitive(uuid), "accept" to JsonPrimitive(accept))).toString())
    }
    /** Remove a friend, or cancel / decline a request. */
    suspend fun removeFriend(uuid: String) { call("DELETE", "/friends?uuid=$uuid") }

    // --- you
    suspend fun updateMe(fields: JsonObject): Me = json.decodeFromString(call("PATCH", "/me", fields.toString()))
    suspend fun setAvatar(bytes: ByteArray, type: String) { callRaw("/me/avatar", bytes, type) }
    suspend fun removeAvatar() { call("DELETE", "/me/avatar") }
    suspend fun setBanner(bytes: ByteArray, type: String) { callRaw("/me/banner", bytes, type) }
    suspend fun removeBanner() { call("DELETE", "/me/banner") }
    suspend fun presence() { runCatching { call("POST", "/presence", jo("activity" to jo("type" to "app", "app" to "jace-social-mobile")).toString()) } }
    suspend fun offline() { runCatching { call("POST", "/presence", jo("activity" to null, "offline" to true, "app" to true).toString()) } }
    suspend fun linkJace(): JaceStart = post("/link/jace")
    suspend fun unlinkJace() { call("DELETE", "/link/jace") }
    suspend fun startLinkMinecraft(): DeviceCode = post("/link/minecraft/device")
    /** true once linked; false while the code hasn't been entered yet */
    suspend fun pollLinkMinecraft(ticket: String): Boolean =
        !json.parseToJsonElement(call("POST", "/link/minecraft/device/poll", jo("ticket" to ticket).toString())).jsonObject.containsKey("pending")
    suspend fun pollLinkJace(start: JaceStart): Boolean =
        !json.parseToJsonElement(call("GET", "/auth/jace/poll?state=${start.state}&key=${start.poll_key}")).jsonObject.containsKey("pending")

    // --- people
    suspend fun profile(uuid: String): FullProfile = get("/users/$uuid")

    // --- group chats
    suspend fun createGroup(name: String, members: List<String>): String =
        json.parseToJsonElement(call("POST", "/groups", jo("name" to name, "members" to members).toString()))
            .jsonObject["group"]!!.jsonObject["id"]!!.jsonPrimitive.content
    suspend fun renameGroup(id: String, name: String) { call("PATCH", "/groups/$id", jo("name" to name).toString()) }
    suspend fun setGroupIcon(id: String, bytes: ByteArray, type: String) { callRaw("/groups/$id/icon", bytes, type) }
    suspend fun addToGroup(id: String, uuid: String) { call("POST", "/groups/$id/members", jo("uuid" to uuid).toString()) }
    /** your own uuid: leave; someone else (owner only): remove them */
    suspend fun removeFromGroup(id: String, uuid: String) { call("DELETE", "/groups/$id/members?uuid=$uuid") }

    // --- servers
    suspend fun createServer(name: String): String =
        json.parseToJsonElement(call("POST", "/servers", jo("name" to name).toString())).jsonObject["server"]!!.jsonObject["id"]!!.jsonPrimitive.content
    suspend fun invite(code: String): InvitePreview = get("/invites/${enc(code)}")
    suspend fun joinInvite(code: String): JoinedServer = json.decodeFromString(call("POST", "/invites/${enc(code)}", "{}"))
    suspend fun updateServer(id: String, fields: JsonObject) { call("PATCH", "/servers/$id", fields.toString()) }
    suspend fun deleteServer(id: String) { call("DELETE", "/servers/$id") }
    suspend fun setServerIcon(id: String, bytes: ByteArray, type: String) { callRaw("/servers/$id/icon", bytes, type) }
    suspend fun setServerBanner(id: String, bytes: ByteArray, type: String) { callRaw("/servers/$id/banner", bytes, type) }
    suspend fun removeServerBanner(id: String) { call("DELETE", "/servers/$id/banner") }
    suspend fun newInvite(id: String): String =
        json.parseToJsonElement(call("POST", "/servers/$id/invite", "{}")).jsonObject["invite_code"]!!.jsonPrimitive.content
    /** your own uuid: leave; someone else: kick */
    suspend fun removeMember(id: String, uuid: String) { call("DELETE", "/servers/$id/members?uuid=$uuid") }
    suspend fun updateMember(id: String, fields: JsonObject) { call("PATCH", "/servers/$id/members", fields.toString()) }
    suspend fun bans(id: String): List<Ban> = json.decodeFromString<BansData>(call("GET", "/servers/$id/bans")).bans
    suspend fun ban(id: String, uuid: String, reason: String, deleteMessages: Boolean) {
        call("POST", "/servers/$id/bans", jo("uuid" to uuid, "reason" to reason, "delete_messages" to deleteMessages).toString())
    }
    suspend fun unban(id: String, uuid: String) { call("DELETE", "/servers/$id/bans?uuid=$uuid") }
    suspend fun addBot(id: String, bot: String) { call("POST", "/servers/$id/bots", jo("bot" to bot).toString()) }
    suspend fun createRole(id: String, name: String, color: String?): Role =
        json.decodeFromString<RoleData>(call("POST", "/servers/$id/roles", jo("name" to name, "color" to color).toString())).role
    suspend fun updateRole(id: String, role: String, fields: JsonObject) { call("PATCH", "/servers/$id/roles/$role", fields.toString()) }
    suspend fun deleteRole(id: String, role: String) { call("DELETE", "/servers/$id/roles/$role") }
    suspend fun reorderRoles(id: String, order: List<String>) { call("PUT", "/servers/$id/roles", jo("order" to order).toString()) }
    suspend fun createChannel(id: String, name: String, kind: String, parent: String?, private: Boolean) {
        call("POST", "/servers/$id/channels", jo("name" to name, "kind" to kind, "parent_id" to parent, "private" to private).toString())
    }
    suspend fun updateChannel(channel: String, fields: JsonObject) { call("PATCH", "/channels/$channel", fields.toString()) }
    suspend fun deleteChannel(channel: String) { call("DELETE", "/channels/$channel") }
    suspend fun setOverride(channel: String, type: String, target: String, allow: Long, deny: Long) {
        call("PUT", "/channels/$channel/overrides", jo("target_type" to type, "target_id" to target, "allow" to allow, "deny" to deny).toString())
    }
    suspend fun removeOverride(channel: String, type: String, target: String) {
        call("DELETE", "/channels/$channel/overrides?target_type=$type&target_id=$target")
    }
    suspend fun finishOnboarding(id: String, answers: List<List<Int>>, agreed: Boolean) {
        call("POST", "/servers/$id/onboarding", jo("answers" to answers, "agreed" to agreed).toString())
    }

    // --- messages: pins, slash commands, files
    suspend fun pins(channel: String): MessagesPage = get("/channels/$channel/pins")
    suspend fun pin(id: Long, on: Boolean) { call(if (on) "PUT" else "DELETE", "/messages/$id/pin") }
    suspend fun commands(channel: String): List<Command> = json.decodeFromString<CommandsData>(call("GET", "/channels/$channel/commands")).commands
    suspend fun runCommand(channel: String, c: Command, args: Map<String, String>) {
        call("POST", "/channels/$channel/commands", jo("bot" to c.bot, "name" to c.name, "args" to JsonObject(args.mapValues { JsonPrimitive(it.value) })).toString())
    }
    /** Upload a file for a message straight to storage (not through the API, which has a size limit). */
    suspend fun upload(name: String, type: String, bytes: ByteArray, width: Int? = null, height: Int? = null): Attachment {
        val slot: UploadSlot = json.decodeFromString(call("POST", "/uploads", jo("name" to name, "type" to type, "size" to bytes.size).toString()))
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(slot.upload_url).put(bytes.toRequestBody(type.toMediaType()))
                .header("x-upsert", "false").build()
            http.newCall(req).execute().use { if (!it.isSuccessful) throw ApiError(it.code, "Couldn't upload $name (${it.code})") }
        }
        return Attachment(slot.url, name, type, bytes.size.toLong(), width, height)
    }
    suspend fun sendWith(t: ChatTarget, body: String, replyTo: Long?, attachments: List<Attachment>): Message {
        val fields = jo("body" to body, "reply_to" to replyTo, "to" to (t as? ChatTarget.Direct)?.uuid,
            "attachments" to json.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(Attachment.serializer()), attachments))
        val path = if (t is ChatTarget.Channel) "/channels/${t.id}/messages" else "/messages"
        return json.decodeFromString<SentMessage>(call("POST", path, fields.toString())).message
    }

    // --- bots
    suspend fun bots(): List<Bot> = json.decodeFromString<BotsData>(call("GET", "/bots")).bots
    suspend fun directory(q: String): List<Person> = json.decodeFromString<PeopleData>(call("GET", "/bots/directory?q=${enc(q)}")).bots
    /** -> the bot and its token (only shown now) */
    suspend fun createBot(name: String): Pair<Bot, String> {
        val o = json.parseToJsonElement(call("POST", "/bots", jo("name" to name).toString())).jsonObject
        return json.decodeFromJsonElement(Bot.serializer(), o["bot"]!!) to o["token"]!!.jsonPrimitive.content
    }
    suspend fun updateBot(id: String, fields: JsonObject) { call("PATCH", "/bots/$id", fields.toString()) }
    suspend fun deleteBot(id: String) { call("DELETE", "/bots/$id") }
    suspend fun botToken(id: String): String = json.parseToJsonElement(call("POST", "/bots/$id/token", "{}")).jsonObject["token"]!!.jsonPrimitive.content
    suspend fun botSession(id: String): BotLink = json.decodeFromString(call("POST", "/bots/$id/session", "{}"))
    suspend fun setBotAvatar(id: String, bytes: ByteArray, type: String) { callRaw("/bots/$id/avatar", bytes, type) }
    suspend fun botCode(id: String): String? =
        json.parseToJsonElement(call("GET", "/bots/$id")).jsonObject["code"]?.let { if (it is JsonPrimitive && it.isString) it.content else null }
    /** -> the slash commands it defines */
    suspend fun saveBotCode(id: String, code: String?): List<String> =
        json.parseToJsonElement(call("PUT", "/bots/$id/code", jo("code" to code).toString())).jsonObject["commands"]
            ?.let { (it as? kotlinx.serialization.json.JsonArray)?.mapNotNull { c -> c.jsonObject["name"]?.jsonPrimitive?.content } } ?: emptyList()
    suspend fun tryBotCode(id: String, code: String, text: String): TryResult {
        val cmd = text.trim().takeIf { it.startsWith("/") }?.drop(1)?.split(Regex("\\s+"))
        val body = jo("code" to code, "text" to (cmd?.drop(1)?.joinToString(" ") ?: text),
            "command" to cmd?.let { jo("name" to it[0], "args" to jo("text" to it.drop(1).joinToString(" "))) })
        return json.decodeFromJsonElement(TryResult.serializer(), json.parseToJsonElement(call("POST", "/bots/$id/code", body.toString())).jsonObject["result"]!!)
    }
    suspend fun botActivity(id: String, server: String? = null, before: Long? = null): BotActivityPage =
        get("/bots/$id/activity?" + listOfNotNull(server?.let { "server=$it" }, before?.let { "before=$it" }).joinToString("&"))

    // --- calls and voice rooms
    suspend fun ice(): List<IceServer> = get<IceServers>("/calls/ice").ice_servers
    suspend fun callSignal(to: String, callId: String, kind: String, sdp: String? = null) {
        call("POST", "/calls", jo("to" to to, "call_id" to callId, "kind" to kind, "sdp" to sdp).toString())
    }
    suspend fun readCallSignal(id: Long): Signal = get<SignalData>("/calls?id=$id").signal
    suspend fun voiceJoin(channel: String): VoiceJoin = json.decodeFromString(call("POST", "/channels/$channel/voice", jo("action" to "join").toString()))
    suspend fun voiceLeave(channel: String) { runCatching { call("POST", "/channels/$channel/voice", jo("action" to "leave").toString()) } }
    suspend fun voiceState(channel: String, muted: Boolean? = null, deafened: Boolean? = null, streaming: Boolean? = null) {
        call("POST", "/channels/$channel/voice", jo("action" to "state", "muted" to muted, "deafened" to deafened, "streaming" to streaming).toString())
    }
    suspend fun voiceRoom(channel: String): List<Participant> = get<ParticipantsData>("/channels/$channel/voice").participants
    suspend fun voiceSignal(channel: String, to: String, kind: String, sdp: String) {
        call("POST", "/voice/signal", jo("channel_id" to channel, "to" to to, "kind" to kind, "sdp" to sdp).toString())
    }
    suspend fun readVoiceSignal(id: Long): Signal = get<SignalData>("/voice/signal?id=$id").signal

    // --- updates
    suspend fun latestRelease(): Release = get("/releases/mobile")

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}

@kotlinx.serialization.Serializable private data class BansData(val bans: List<Ban> = emptyList())
@kotlinx.serialization.Serializable private data class RoleData(val role: Role)
@kotlinx.serialization.Serializable private data class CommandsData(val commands: List<Command> = emptyList())
@kotlinx.serialization.Serializable private data class BotsData(val bots: List<Bot> = emptyList())
@kotlinx.serialization.Serializable private data class PeopleData(val bots: List<Person> = emptyList())
@kotlinx.serialization.Serializable data class ParticipantsData(val participants: List<Participant> = emptyList())

/** A JSON object from Kotlin values: strings, numbers, booleans, null, lists, maps and JSON. */
fun jo(vararg fields: Pair<String, Any?>): JsonObject = JsonObject(fields.associate { (k, v) -> k to toJson(v) })

fun toJson(v: Any?): kotlinx.serialization.json.JsonElement = when (v) {
    null -> kotlinx.serialization.json.JsonNull
    is kotlinx.serialization.json.JsonElement -> v
    is String -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is List<*> -> kotlinx.serialization.json.JsonArray(v.map { toJson(it) })
    is Map<*, *> -> JsonObject(v.entries.associate { it.key.toString() to toJson(it.value) })
    else -> JsonPrimitive(v.toString())
}
