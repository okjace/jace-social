package dev.jacedeb.jacefriends.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Sees the messages e4mc writes straight into the chat box ("Local game hosted on domain [...]"):
 * they don't go through the game's chat events, so without this Host world waited for the address forever.
 * (Didn't work in 1.5.4 on 26.3: it only hooked addMessage(Component), which 26.3 doesn't have.)
 */
@Mixin(net.minecraft.client.gui.components.ChatComponent.class)
public abstract class ChatAddressMixin {
	// 26.3 has no addMessage(Component): e4mc uses addClientSystemMessage there (either may be missing on a version)
	//? if >=26.1 {
	@Inject(method = {"addMessage(Lnet/minecraft/network/chat/Component;)V", "addClientSystemMessage(Lnet/minecraft/network/chat/Component;)V"}, at = @At("HEAD"))
	//?} else {
	/*@Inject(method = "addMessage(Lnet/minecraft/network/chat/Component;)V", at = @At("HEAD"))
	*///?}
	private void jacefriends$seeAddress(net.minecraft.network.chat.Component message, CallbackInfo ci) {
		dev.jacedeb.jacefriends.JaceFriends.onGameMessage(message);
	}
}
