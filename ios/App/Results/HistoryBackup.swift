import Foundation

/// Cópia do histórico numa pasta escolhida pelo usuário (iCloud Drive, Arquivos, pen drive), reescrita
/// a cada passada salva. É o que substitui a nuvem: se o aparelho sumir ou o app for reinstalado, a
/// planilha sobrevive. Sem rede e sem servidor — quem sincroniza é o app Arquivos.
///
/// A pasta é guardada como *security-scoped bookmark*: o acesso concedido pelo seletor não sobrevive
/// ao fechamento do app, o marcador sim.
enum HistoryBackup {
    /// Marcador da pasta escolhida no `fileImporter` (guardar em `AppSettings.backupBookmark`).
    static func bookmark(for folder: URL) -> Data? {
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        return try? folder.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    /// Resultado de uma gravação: erro em pt-BR (ou nil) e, quando o marcador envelheceu, o
    /// marcador novo para quem chamou guardar — sem isso a permissão da pasta some sem aviso.
    struct WriteResult {
        var error: String?
        var refreshedBookmark: Data?
    }

    /// Grava `content` como `name` dentro da pasta do marcador. Chamar FORA da main thread: pasta do
    /// iCloud Drive é provedor de arquivos, e a escrita pode demorar.
    @discardableResult
    static func write(_ content: String, name: String, bookmark: Data?) -> WriteResult {
        guard let bookmark else { return WriteResult() }
        var stale = false
        guard let folder = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil,
                                    bookmarkDataIsStale: &stale) else {
            return WriteResult(error: "Pasta de backup não encontrada. Escolha a pasta de novo.")
        }
        guard folder.startAccessingSecurityScopedResource() else {
            return WriteResult(error: "Sem permissão para escrever na pasta de backup. Escolha a pasta de novo.")
        }
        defer { folder.stopAccessingSecurityScopedResource() }
        // marcador envelhecido ainda resolve uma vez; renovar agora evita perder a pasta depois
        let refreshed = stale ? try? folder.bookmarkData(options: .minimalBookmark,
                                                         includingResourceValuesForKeys: nil, relativeTo: nil) : nil
        do {
            try content.data(using: .utf8)!.write(to: folder.appendingPathComponent(name), options: .atomic)
            return WriteResult(error: nil, refreshedBookmark: refreshed)
        } catch {
            return WriteResult(error: "Backup falhou: \(error.localizedDescription)", refreshedBookmark: refreshed)
        }
    }

    /// Nome de arquivo seguro para uma prova ("Copa de Verão" → "fotocelula-prova-copa-de-verao.csv").
    static func eventFileName(_ eventName: String) -> String {
        let folded = eventName.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pt_BR"))
        var slug = ""
        var lastDash = false
        for ch in folded {
            if ch.isLetter || ch.isNumber {
                slug.append(ch)
                lastDash = false
            } else if !lastDash {
                slug.append("-")
                lastDash = true
            }
        }
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if slug.isEmpty { slug = "sem-nome" }
        return "fotocelula-prova-" + String(slug.prefix(40)) + ".csv"
    }
}
