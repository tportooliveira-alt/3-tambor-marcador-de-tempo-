// Projeto Android: módulo `core` (Kotlin JVM puro, testável em qualquer máquina) e `app` (Camera2 + Compose).
// Rode com -PskipApp=true para compilar/testar só o núcleo sem o Android SDK.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.1.21"
        id("org.jetbrains.kotlin.jvm") version "2.1.21"
        id("org.jetbrains.kotlin.plugin.compose") version "2.1.21"
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "FotocelulaTambor"
include(":core")
if (!(extra.properties["skipApp"]?.toString()?.toBoolean() ?: false)) {
    include(":app")
}
