package dev.jacedeb.jacefriends.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * No chat signing in a world you host with Offline accounts on (Host world; like e4all's
 * No-Chat-Reports part). A player's chat signing key belongs to their real Minecraft account, but in
 * offline mode they join with an offline id, so the key doesn't match it and Minecraft kicks them
 * ("Invalid signature for profile public key") as soon as they chat. Here the world ignores players'
 * signing keys while it doesn't check accounts: everyone's chat arrives unsigned, which a world you
 * host accepts (it doesn't require signed chat, unlike servers with enforce-secure-profile).
 */
@Mixin(net.minecraft.server.network.ServerGamePacketListenerImpl.class)
public abstract class OfflineChatMixin {
	@Inject(method = "handleChatSessionUpdate", at = @At("HEAD"), cancellable = true)
	private void jacefriends$noSigningOffline(net.minecraft.network.protocol.game.ServerboundChatSessionUpdatePacket packet, CallbackInfo ci) {
		net.minecraft.client.server.IntegratedServer sp = net.minecraft.client.Minecraft.getInstance().getSingleplayerServer();
		if (sp != null && sp.isPublished() && !sp.usesAuthentication()) ci.cancel();
	}
}
