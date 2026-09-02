import PhotocellCore
import SwiftUI

/// Tela única (paisagem): preview em tela cheia, linha/banda da fotocélula, painel lateral com
/// diagnósticos, cronômetro e botões Calibrar / Armar / Reset; resultado com penalidades ao final.
struct ContentView: View {
    @StateObject private var vm = PhotocellViewModel()
    @State private var showHistory = false
    @State private var showSettings = false
    @State private var showEvent = false
    @State private var showAssign = false
    @Environment(\.scenePhase) private var scenePhase

    private var roiLocked: Bool { vm.snapshot.state != .idle && vm.snapshot.state != .finished && vm.snapshot.state != .error }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch vm.permission {
            case .denied:
                PermissionView()
            default:
                cameraContent
            }
            if vm.flashVisible { Color.white.ignoresSafeArea().transition(.opacity) }
        }
        .statusBarHidden(true)
        .onAppear {
            OrientationLock.requestLandscape()
            vm.startCamera()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .background { vm.stopCamera() }
            if phase == .active && vm.permission == .granted { vm.startCamera() }
        }
        .sheet(isPresented: $showHistory) { HistoryView(store: vm.history) }
        .sheet(isPresented: $showSettings) { SettingsView(vm: vm) }
        .sheet(isPresented: $showEvent) { EventView(vm: vm, events: vm.events, history: vm.history) }
        .sheet(isPresented: $showAssign) { AssignEntryView(vm: vm, events: vm.events) }
    }

    private var cameraContent: some View {
        HStack(spacing: 0) {
            ZStack {
                CameraPreviewView(session: vm.camera.session,
                                  lineXFraction: vm.settings.lineXFraction,
                                  bandTopFraction: vm.settings.bandTopFraction,
                                  bandBottomFraction: vm.settings.bandBottomFraction,
                                  onROIMapped: { cx, top, bottom in vm.roiMapped(centerX: cx, top: top, bottom: bottom) })
                ROIOverlayView(lineX: $vm.settings.lineXFraction, bandTop: $vm.settings.bandTopFraction,
                               bandBottom: $vm.settings.bandBottomFraction, stripWidthPx: vm.settings.stripWidthPx,
                               mmPerPx: nil, locked: roiLocked)
                VStack {
                    // faixa "Próximo" sobre o preview: é o que o operador olha entre uma passada e outra
                    HStack { NextEntryBanner(vm: vm, events: vm.events, history: vm.history); Spacer() }
                    Spacer()
                    if let msg = vm.errorMessage {
                        banner(msg, color: .red)
                    } else if let info = vm.infoMessage {
                        banner(info, color: .blue)
                    }
                }
                .padding(8)
            }
            sidePanel
                .frame(width: 340)
                .background(Color.black.opacity(0.75))
        }
        .ignoresSafeArea()
    }

    private var sidePanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            DiagnosticsBar(vm: vm)
            Divider().background(Color.white.opacity(0.3))
            StopwatchView(model: vm.timerText)
            if let rec = Binding($vm.pendingResult) {
                ScrollView { ResultView(vm: vm, record: rec, onAssign: { showAssign = true }) }
            } else {
                Spacer()
            }
            HStack(spacing: 8) {
                Button { vm.calibrate() } label: { label("Calibrar", "scope") }
                    .buttonStyle(.borderedProminent).tint(.blue)
                    .disabled(!vm.canCalibrate || vm.isCalibratingCamera)
                Button { vm.arm() } label: { label("Armar", "bolt.fill") }
                    .buttonStyle(.borderedProminent).tint(.green)
                    .disabled(!vm.canArm)
                Button { vm.reset() } label: { label("Reset", "arrow.counterclockwise") }
                    .buttonStyle(.borderedProminent).tint(.red)
            }
            HStack {
                Button { showEvent = true } label: { Label("Prova", systemImage: "flag.checkered") }
                Spacer()
                Button { showHistory = true } label: { Label("Histórico", systemImage: "list.bullet") }
                Spacer()
                Button { showSettings = true } label: { Label("Ajustes", systemImage: "gearshape") }
            }
            .font(.footnote)
            .disabled(roiLocked)
        }
        .padding(12)
        .foregroundColor(.white)
    }

    private func label(_ text: String, _ icon: String) -> some View {
        VStack(spacing: 2) { Image(systemName: icon); Text(text).font(.caption.bold()) }
            .frame(maxWidth: .infinity).padding(.vertical, 6)
    }

    private func banner(_ text: String, color: Color) -> some View {
        Text(text).font(.footnote.bold()).foregroundColor(.white).padding(8)
            .background(color.opacity(0.85)).cornerRadius(8)
    }
}
