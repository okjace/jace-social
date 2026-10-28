package dev.jacedeb.jacesocial.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.GroupAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.ImeAction
import dev.jacedeb.jacesocial.data.Person
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jacedeb.jacesocial.data.ChatTarget
import dev.jacedeb.jacesocial.data.Group
import dev.jacedeb.jacesocial.data.Store

/** Your conversations: friends (direct messages) and group chats, unread first. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatsScreen(store: Store, open: (ChatTarget, String) -> Unit) {
    val friends by store.friends.collectAsState()
    val groups by store.groups.collectAsState()
    val error by store.error.collectAsState()
    val nav = LocalNav.current
    val me by store.me.collectAsState()
    val muted = me?.settings?.muted ?: emptyList()
    Column(Modifier.fillMaxSize()) {
        var adding by remember { mutableStateOf(false) }
        var removing by remember { mutableStateOf<Person?>(null) }
        var menuFor by remember { mutableStateOf<String?>(null) }
        TopAppBar(title = { Text("Chats", fontWeight = FontWeight.Bold) },
            actions = {
                IconButton(onClick = { nav.go("new-group") }) { Icon(Icons.Filled.GroupAdd, "New group chat") }
                IconButton(onClick = { adding = true }) { Icon(Icons.Filled.PersonAdd, "Add friend") }
            })
        if (adding) AddFriendDialog(store) { adding = false }
        removing?.let { p ->
            AlertDialog(onDismissRequest = { removing = null },
                title = { Text("Remove ${p.shownName}?") },
                text = { Text("You won't be friends any more. Your messages stay.") },
                confirmButton = { TextButton(onClick = { store.friendAction { it.removeFriend(p.uuid) }; removing = null }) {
                    Text("Remove", color = JaceColors.red) } },
                dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } })
        }
        PullToRefreshBox(isRefreshing = false, onRefresh = { store.refreshAll() }, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                error?.let { item { Text(it, color = JaceColors.red, modifier = Modifier.padding(16.dp)) } }
                val f = friends
                if (f == null) { item { Text("Loading…", color = JaceColors.muted, modifier = Modifier.padding(16.dp)) }; return@LazyColumn }
                if (f.incoming.isNotEmpty()) {
                    item { SectionTitle("Friend requests — ${f.incoming.size}") }
                    items(f.incoming, key = { "in" + it.uuid }) { p ->
                        PersonRow(p, "Wants to be friends") {
                            IconButton(onClick = { store.friendAction { it.respondFriend(p.uuid, true) } }) {
                                Icon(Icons.Filled.Check, "Accept", tint = JaceColors.green) }
                            IconButton(onClick = { store.friendAction { it.respondFriend(p.uuid, false) } }) {
                                Icon(Icons.Filled.Close, "Decline", tint = JaceColors.muted) }
                        }
                    }
                }
                if (f.outgoing.isNotEmpty()) {
                    item { SectionTitle("Sent requests — ${f.outgoing.size}") }
                    items(f.outgoing, key = { "out" + it.uuid }) { p ->
                        PersonRow(p, "Waiting for them to accept") {
                            TextButton(onClick = { store.friendAction { it.removeFriend(p.uuid) } }) { Text("Cancel", color = JaceColors.muted) }
                        }
                    }
                }
                if (groups.isNotEmpty()) {
                    item { SectionTitle("Group chats") }
                    items(groups, key = { "g" + it.id }) { g ->
                        Box(Modifier.fillMaxWidth().combinedClickable(onLongClick = { menuFor = g.id }) { open(ChatTarget.Channel(g.id), g.name) }) {
                            GroupRow(g, muted.contains(g.id))
                            DropdownMenu(expanded = menuFor == g.id, onDismissRequest = { menuFor = null }) {
                                DropdownMenuItem(text = { Text("Group settings") }, onClick = { menuFor = null; nav.go("group/${g.id}") })
                                DropdownMenuItem(text = { Text(if (muted.contains(g.id)) "Unmute" else "Mute") }, onClick = {
                                    menuFor = null
                                    store.saveSettings(dev.jacedeb.jacesocial.data.jo("muted" to if (muted.contains(g.id)) muted - g.id else muted + g.id))
                                })
                            }
                        }
                    }
                }
                item { SectionTitle("Direct messages") }
                f.jace?.let { j ->           // the official Jace bot: help, and a person when you ask for one
                    item(key = "jace-bot") {
                        Box(Modifier.fillMaxWidth().combinedClickable(onLongClick = {}) { open(ChatTarget.Direct(j.uuid), "Jace") }) {
                            PersonRow(j, if (j.unread > 0) "New message" else "Ask me anything about Jace Social")
                        }
                    }
                }
                items(f.others, key = { "other-" + it.uuid }) { p ->
                    Box(Modifier.fillMaxWidth().combinedClickable(onLongClick = {}) { open(ChatTarget.Direct(p.uuid), p.shownName) }) {
                        PersonRow(p, "Not a friend")
                    }
                }
                val sorted = f.friends.sortedWith(compareByDescending<Person> { it.unread }
                    .thenByDescending { it.online }.thenBy { it.shownName.lowercase() })
                items(sorted, key = { it.uuid }) { p ->
                    Box(Modifier.fillMaxWidth().combinedClickable(onLongClick = { menuFor = p.uuid }) { open(ChatTarget.Direct(p.uuid), p.shownName) }) {
                        PersonRow(p, if (p.online) describe(p) else "Offline")
                        DropdownMenu(expanded = menuFor == p.uuid, onDismissRequest = { menuFor = null }) {
                            DropdownMenuItem(text = { Text("Message") }, onClick = { menuFor = null; open(ChatTarget.Direct(p.uuid), p.shownName) })
                            DropdownMenuItem(text = { Text("Profile") }, onClick = { menuFor = null; nav.profile(p.uuid) })
                            DropdownMenuItem(text = { Text("Call") }, onClick = { menuFor = null; nav.withMic { store.calls.call(p.uuid, p.shownName) } })
                            DropdownMenuItem(text = { Text(if (muted.contains(p.uuid)) "Unmute" else "Mute") }, onClick = {
                                menuFor = null
                                store.saveSettings(dev.jacedeb.jacesocial.data.jo("muted" to if (muted.contains(p.uuid)) muted - p.uuid else muted + p.uuid))
                            })
                            DropdownMenuItem(text = { Text("Remove friend", color = JaceColors.red) }, onClick = { menuFor = null; removing = p })
                        }
                    }
                }
            }
        }
    }
}

/** Send a friend request by Minecraft or Jace name. */
@Composable
fun AddFriendDialog(store: Store, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    fun send() {
        val n = name.trim()
        if (n.isEmpty() || busy) return
        busy = true
        scope.launch {
            try {
                val status = store.api.addFriend(n)
                result = if (status == "accepted") "You're now friends with $n!" else "Friend request sent to $n."
                failed = false
                name = ""
                store.refreshFriends()
            } catch (e: Exception) {
                result = e.message; failed = true
            }
            busy = false
        }
    }
    AlertDialog(onDismissRequest = onDone,
        title = { Text("Add a friend") },
        text = {
            Column {
                Text("Their @handle, or their Minecraft username.", color = JaceColors.muted, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(name, { name = it; result = null }, singleLine = true, placeholder = { Text("Username") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }))
                result?.let { Text(it, color = if (failed) JaceColors.red else JaceColors.green, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = { TextButton(onClick = ::send, enabled = name.isNotBlank() && !busy) { Text("Send request") } },
        dismissButton = { TextButton(onClick = onDone) { Text("Done") } })
}

@Composable
fun GroupRow(g: Group, muted: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        IconPic(g.name, g.icon_url, 44, CircleShape)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(g.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${g.members.size} members", color = JaceColors.muted, style = MaterialTheme.typography.bodySmall)
        }
        if (muted) Text("🔕 ")
        if (g.unread > 0) UnreadBadge(g.unread)
    }
}

@Composable
fun UnreadBadge(n: Int) {
    Box(Modifier.clip(CircleShape).background(JaceColors.red).padding(horizontal = 7.dp, vertical = 2.dp)) {
        Text("$n", style = MaterialTheme.typography.labelSmall)
    }
}
