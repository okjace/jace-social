package dev.jacedeb.jacefriends.mixin;

import org.spongepowered.asm.mixin.Mixin;

/**
 * Minecraft's own Friends screen (26.2+) -> Jace Social's, before Minecraft's is ever shown. (Swapping
 * it a tick later let Minecraft's draw one frame, and its background blur crashed the game: "Can only
 * blur once per frame".) JaceFriends.tick still swaps it if this mixin couldn't apply.
 */
//? if >=26.2 {
@Mixin(net.minecraft.client.gui.Gui.class)
public abstract class VanillaFriendsMixin {
	@org.spongepowered.asm.mixin.injection.ModifyVariable(method = "setScreen", at = @org.spongepowered.asm.mixin.injection.At("HEAD"), argsOnly = true)
	private net.minecraft.client.gui.screens.Screen jacefriends$ourFriends(net.minecraft.client.gui.screens.Screen screen) {
		return dev.jacedeb.jacefriends.Compat.isVanillaFriends(screen) ? dev.jacedeb.jacefriends.JaceFriends.friendsInstead() : screen;
	}
}
//?} else {
/*@Mixin(net.minecraft.client.Minecraft.class)
public abstract class VanillaFriendsMixin {
}
*///?}
