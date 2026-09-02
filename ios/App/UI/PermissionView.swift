import SwiftUI

struct PermissionView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill").font(.system(size: 48))
            Text("Permissão de câmera necessária").font(.title2.bold())
            Text("A fotocélula virtual usa a câmera traseira a 240 quadros por segundo. Nenhum vídeo é gravado ou enviado.")
                .multilineTextAlignment(.center).foregroundColor(.secondary)
            Button("Abrir Ajustes") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(32)
    }
}
