plugins {
    id("net.neoforged.moddev") version "2.0.147"
    id("neoforge-mutex")
}

version = "${property("mod.version")}+${sc.current.version}"
base.archivesName = "${property("mod.id") as String}-neoforge"

val requiredJava = when {
    sc.current.parsed >= "26.1" -> JavaVersion.VERSION_25
    sc.current.parsed >= "1.20.5" -> JavaVersion.VERSION_21
    sc.current.parsed >= "1.18" -> JavaVersion.VERSION_17
    sc.current.parsed >= "1.17" -> JavaVersion.VERSION_16
    else -> JavaVersion.VERSION_1_8
}

repositories {
    /**
     * Restricts dependency search of the given [groups] to the [maven URL][url],
     * improving the setup speed.
     */
    fun strictMaven(url: String, alias: String, vararg groups: String) = exclusiveContent {
        forRepository { maven(url) { name = alias } }
        filter { groups.forEach(::includeGroup) }
    }
    strictMaven("https://www.cursemaven.com", "CurseForge", "curse.maven")
    strictMaven("https://api.modrinth.com/maven", "Modrinth", "maven.modrinth")
    mavenCentral()
}

dependencies {
    // LuckPerms API: only used when LuckPerms is installed (the permissions menus)
    compileOnly("net.luckperms:api:5.4")
    // e4mc (gives hosted worlds a public address; optional - e4all works too); in the dev/test client only
    runtimeOnly("maven.modrinth:e4mc:${sc.properties.get<String>("deps.e4mc")}")
}

neoForge {
    version = property("deps.neo_loader") as String

    mods {
        register("jacefriends") {
            sourceSet(sourceSets.main.get())
        }
    }

    runs {
        register("client") {
            gameDirectory = file("../../run/")
            client()
        }

        register("server") {
            gameDirectory = file("../../run/")
            server()
        }
    }
}

java {
    withSourcesJar()
    targetCompatibility = requiredJava
    sourceCompatibility = requiredJava

    toolchain {
        vendor = JvmVendorSpec.ADOPTIUM
        languageVersion = JavaLanguageVersion.of(requiredJava.majorVersion)
    }
}

tasks {
    processResources {
        fun MutableMap<String, String>.register(key: String, value: String) {
            inputs.property(key, value)
            set(key, value)
        }

        val props = buildMap {
            register("id", sc.properties["mod.id"])
            register("name", sc.properties["mod.name"])
            register("version", sc.properties["mod.version"])
            register("minecraft", sc.properties["mod.mc_compat"])
            register("e4mc_type", "optional")      // (hosting: e4mc, or e4all - either one, so neither is required)
        }

        // NeoForge before 1.20.5 still read META-INF/mods.toml (computed here so the
        // file action below doesn't capture build-script objects)
        val tomlName = if (sc.current.parsed < "1.20.5") "mods.toml" else "neoforge.mods.toml"
        filesMatching("META-INF/neoforge.mods.toml") {
            expand(props)
            name = tomlName
        }

        val mixinJava = "JAVA_${requiredJava.majorVersion}"
        filesMatching("*.mixins.json") { expand("java" to mixinJava) }

        exclude("fabric.mod.json", "META-INF/forge.mods.toml")
    }

    named("createMinecraftArtifacts") {
        dependsOn("stonecutterGenerate")
    }

    // Includes the license file in the built mod
    withType<Jar> {
        val name = project.property("mod.id")
        inputs.property("mod_id", name)
        from("../../LICENSE") { rename { "$it-$name" } }
    }

    register<Copy>("buildAndCollect") {
        group = "build"
        description = "Builds mod jars and copies results to `build/libs/{mod version}/`"

        inputs.property("version", project.property("mod.version"))
        from(jar.flatMap { it.archiveFile }, named<Jar>("sourcesJar").flatMap { it.archiveFile })
        into(rootProject.layout.buildDirectory.file("libs/${project.property("mod.version")}"))
    }
}

// Jar files are named jace_social_1.4.0+26.3-neoforge.jar (and ...-sources.jar); the mod id stays jacefriends.
// Every archive task, including Loom's remapJar and remapSourcesJar, and after the loader plugin set its own name.
afterEvaluate {
    val fileVersion = project.version.toString()
    tasks.withType<AbstractArchiveTask>().configureEach {
        archiveFileName.set(archiveClassifier.map { c -> "jace_social_$fileVersion-neoforge" + (if (c.isEmpty()) "" else "-$c") + ".jar" })
    }
}
