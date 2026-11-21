package dev.jacedeb.jacesocial.ui

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jacedeb.jacesocial.data.DeviceCode
import dev.jacedeb.jacesocial.data.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Sign in with Jace (in the browser) or with Minecraft (a code at microsoft.com/link). */
@Composable
fun SignInScreen(session: Session) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }       // what we're waiting for
    var error by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf<DeviceCode?>(null) }

    fun signInWithJace() = scope.launch {
        error = null
        busy = "Finish signing in in your browser…"
        try {
            val start = session.api.startJace()
            openInBrowser(context, start.url)
            repeat(150) {                       // up to ~5 minutes
                delay(2000)
                session.api.pollJace(start)?.let { session.signedIn(it); return@launch }
            }
            error = "Sign-in took too long - try again"
        } catch (e: Exception) {
            error = e.message
        } finally {
            busy = null
        }
    }

    fun signInWithMinecraft() = scope.launch {
        error = null
        try {
            val dc = session.api.startMinecraft()
            code = dc
            busy = "Waiting for you to enter the code…"
            while (true) {
                delay(dc.interval * 1000L)
                session.api.pollMinecraft(dc.ticket)?.let { session.signedIn(it); return@launch }
            }
        } catch (e: Exception) {
            error = e.message
        } finally {
            busy = null
            code = null
        }
    }

    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Card(Modifier.widthIn(max = 420.dp).fillMaxWidth(),
            colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = JaceColors.panel)) {
            Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Jace Social", color = JaceColors.green, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
                Text("Friends, chat and servers - with Minecraft built in.", color = JaceColors.muted, textAlign = TextAlign.Center)
                val dc = code
                if (dc != null) {
                    Text("Go to ${dc.verification_uri} and enter this code:", textAlign = TextAlign.Center)
                    SelectionContainer { Text(dc.user_code, fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp) }
                    Button(onClick = { openInBrowser(context, dc.verification_uri) }, Modifier.fillMaxWidth()) { Text("Open microsoft.com/link") }
                }
                if (busy != null) {
                    CircularProgressIndicator()
                    Text(busy!!, color = JaceColors.muted, textAlign = TextAlign.Center)
                } else {
                    Button(onClick = { signInWithJace() }, Modifier.fillMaxWidth()) { Text("Sign in with Jace") }
                    OutlinedButton(onClick = { signInWithMinecraft() }, Modifier.fillMaxWidth()) { Text("⛏  Sign in with Minecraft") }
                }
                error?.let { Text(it, color = JaceColors.red, textAlign = TextAlign.Center) }
                Text("By making an account, you agree to the Terms of Service and Privacy Policy.",
                    color = JaceColors.muted, fontSize = 13.sp, textAlign = TextAlign.Center)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { openInBrowser(context, "https://jace-social.vercel.app/legal#terms") }) { Text("Terms of Service", color = JaceColors.green, fontSize = 13.sp) }
                    TextButton(onClick = { openInBrowser(context, "https://jace-social.vercel.app/legal#privacy") }) { Text("Privacy Policy", color = JaceColors.green, fontSize = 13.sp) }
                }
            }
        }
    }
}

fun openInBrowser(context: Context, url: String) {
    CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url))
}
