package br.com.tportooliveira.fotocelula.results

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Cópia do histórico numa pasta escolhida pelo usuário (Drive, Arquivos, cartão), reescrita a cada
 * passada salva. É o que substitui a nuvem: se o celular sumir ou o app for desinstalado, a planilha
 * sobrevive. Sem rede e sem servidor — quem sincroniza é o app de arquivos do usuário.
 *
 * Usa o Storage Access Framework direto (sem dependência extra): a permissão da pasta é persistida
 * uma única vez com `takePersistableUriPermission`.
 */
class HistoryBackup(private val context: Context) {
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "backup-io") }
    /** Último erro, para a UI dizer que o backup parou (pasta apagada, cartão removido). */
    @Volatile var lastError: String? = null
        private set

    /** Guarda a permissão da pasta escolhida em ACTION_OPEN_DOCUMENT_TREE. */
    fun takePermission(tree: Uri): Boolean = try {
        context.contentResolver.takePersistableUriPermission(
            tree, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        lastError = null
        true
    } catch (e: Exception) {
        lastError = "Não foi possível guardar a permissão da pasta: ${e.message}"
        false
    }

    /**
     * Reescreve `name` na pasta com o conteúdo dado, fora da main thread. `onDone` recebe o erro (ou
     * null) NA THREAD DE E/S — quem chama devolve para a main thread; sem isso a tela continuaria
     * dizendo que o backup está bem depois de a pasta ser apagada ou a permissão revogada.
     */
    fun write(treeUriString: String, name: String, content: String, onDone: (String?) -> Unit = {}) {
        if (treeUriString.isEmpty()) return
        io.execute {
            try {
                val resolver = context.contentResolver
                val tree = Uri.parse(treeUriString)
                val dirId = DocumentsContract.getTreeDocumentId(tree)
                val dirUri = DocumentsContract.buildDocumentUriUsingTree(tree, dirId)
                val existing = findChild(resolver, tree, dirId, name)
                val target = existing ?: DocumentsContract.createDocument(resolver, dirUri, "text/csv", name)
                if (target == null) {
                    lastError = "Não consegui criar $name na pasta escolhida."
                    onDone(lastError); return@execute
                }
                // "wt" trunca: sem isso um histórico menor deixaria lixo do arquivo anterior no fim
                resolver.openOutputStream(target, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                    ?: run { lastError = "Pasta de backup indisponível."; onDone(lastError); return@execute }
                lastError = null
                onDone(null)
            } catch (e: Exception) {
                lastError = "Backup falhou: ${e.message}"
                Log.w("HistoryBackup", "falha ao gravar $name", e)
                onDone(lastError)
            }
        }
    }

    /** Nome de arquivo seguro para uma prova ("Copa de Verão" → "fotocelula-prova-copa-de-verao.csv"). */
    fun eventFileName(eventName: String): String {
        // Normalizer + remoção das marcas de acento: mesma regra do `folding(.diacriticInsensitive)`
        // do iOS, para a mesma prova não gravar dois arquivos diferentes na pasta compartilhada.
        val folded = Normalizer.normalize(eventName, Normalizer.Form.NFD)
            .replace(Regex("\\p{Mn}+"), "")
            .lowercase(Locale.ROOT)
        val slug = folded.replace(Regex("[^a-z0-9]+"), "-").trim('-')
        return "fotocelula-prova-" + (if (slug.isEmpty()) "sem-nome" else slug.take(40)) + ".csv"
    }

    private fun findChild(resolver: ContentResolver, tree: Uri, dirId: String, name: String): Uri? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirId)
        resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == name) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
            }
        }
        return null
    }
}
