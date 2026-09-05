// Raiz do build Android. Os plugins são aplicados nos módulos.
tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
