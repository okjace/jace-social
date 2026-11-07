package dev.jacedeb.jacefriends.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Sees the messages e4mc writes straight into the chat box ("Local game hosted on domain [...]"):
 * they don't go through the game's chat events, so without this Host world waited for the address forever.
 */
@Mixin(net.minecraft.client.gui.components.ChatComponent.class)
public abstract class ChatAddressMixin {
	@Inject(method = "addMessage(Lnet/minecraft/network/chat/Component;)V", at = @At("HEAD"))
	private void jacefriends$seeAddress(net.minecraft.network.chat.Component message, CallbackInfo ci) {
		dev.jacedeb.jacefriends.JaceFriends.onGameMessage(message);
	}
}
