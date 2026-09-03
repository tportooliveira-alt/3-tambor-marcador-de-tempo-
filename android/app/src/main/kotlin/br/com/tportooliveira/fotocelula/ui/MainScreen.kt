package br.com.tportooliveira.fotocelula.ui

import android.graphics.SurfaceTexture
import android.view.TextureView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import br.com.tportooliveira.fotocelula.core.PhotocellState
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import kotlin.math.abs

/** Tela única em paisagem: preview + linha/banda da fotocélula à esquerda, painel à direita. */
@Composable
fun MainScreen(vm: PhotocellViewModel, displayRotation: Int) {
    var showHistory by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showEvent by remember { mutableStateOf(false) }
    var showAssign by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxHeight()) {
                PreviewWithRoi(vm, displayRotation)
                // faixa "Próximo" sobre o preview: é o que o operador olha entre uma passada e outra
                NextEntryBanner(vm, Modifier.align(Alignment.TopCenter).padding(8.dp))
                Column(Modifier.align(Alignment.BottomCenter).padding(8.dp)) {
                    vm.errorMessage?.let { Banner(it, Color(0xCCB00020)) }
                        ?: vm.infoMessage?.let { Banner(it, Color(0xCC1E5AA8)) }
                }
            }
            SidePanel(vm, onHistory = { showHistory = true }, onSettings = { showSettings = true },
                onEvent = { showEvent = true }, onAssign = { showAssign = true })
        }
        if (vm.flashVisible) Box(Modifier.fillMaxSize().background(Color.White))
        if (showHistory) HistoryDialog(vm) { showHistory = false }
        if (showSettings) SettingsDialog(vm) { showSettings = false }
        if (showEvent) EventDialog(vm) { showEvent = false }
        if (showAssign) AssignEntryDialog(vm) { showAssign = false }
    }
}

@Composable
private fun Banner(text: String, color: Color) {
    Text(text, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.background(color, RoundedCornerShape(8.dp)).padding(8.dp))
}

/** TextureView (preview) + overlay da ROI com gestos. */
@Composable
private fun PreviewWithRoi(vm: PhotocellViewModel, displayRotation: Int) {
    val cap = vm.capability
    var viewSize by remember { mutableStateOf(Pair(0, 0)) }
    val geometry = remember(viewSize, cap, displayRotation) {
        PreviewGeometry(viewSize.first.toFloat(), viewSize.second.toFloat(),
            cap?.size?.width?.toFloat() ?: 16f, cap?.size?.height?.toFloat() ?: 9f,
            sensorOrientation = cap?.sensorOrientation ?: 90, displayRotation = displayRotation,
            bufferRotatedBySensor = cap?.mode?.highSpeed == false)
    }
    val s = vm.settings
    // ROI mapeada para o buffer sempre que a geometria ou a linha mudam (ignorada pelo VM com a ROI travada)
    LaunchedEffect(geometry, s.lineXFraction, s.bandTopFraction, s.bandBottomFraction, s.stripWidthPx, vm.roiLocked) {
        if (viewSize.first > 0) {
            val cx = geometry.bufferX(s.lineXFraction)
            val a = geometry.bufferY(s.bandTopFraction)
            val b = geometry.bufferY(s.bandBottomFraction)
            vm.roiMapped(cx, minOf(a, b), maxOf(a, b))
        }
    }
    Box(Modifier.fillMaxSize().onSizeChanged { viewSize = Pair(it.width, it.height) }) {
        AndroidView(
            factory = { ctx ->
                TextureView(ctx).apply {
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        // O tamanho do buffer é decidido pelo controlador: só a sessão normal escreve
                        // nesta SurfaceTexture pelo Camera2; o leitor GL usa o tamanho da view.
                        override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) { vm.previewSurfaceAvailable(st) }
                        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
                        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { vm.previewSurfaceDestroyed(); return true }
                        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                    }
                }
            },
            update = { tv -> tv.setTransform(geometry.textureTransform()) },
            modifier = Modifier.fillMaxSize(),
        )
        RoiOverlay(vm, geometry)
    }
}

@Composable
private fun RoiOverlay(vm: PhotocellViewModel, geometry: PreviewGeometry) {
    val s = vm.settings
    val locked = vm.roiLocked
    val latest = rememberUpdatedState(s)
    val color = if (locked) Color.Red else Color(0xFF39D353)
    Canvas(
        // reinicia o gesto só quando a trava muda; os ajustes correntes vêm de `latest` (sem recompor o gesto por pixel)
        Modifier.fillMaxSize().pointerInput(locked) {
            if (locked) return@pointerInput
            detectDragGestures { change, _ ->
                change.consume()
                val s = latest.value
                val w = size.width.toFloat(); val h = size.height.toFloat()
                val x = change.position.x; val y = change.position.y
                val lineX = s.lineXFraction * w
                val top = s.bandTopFraction * h; val bottom = s.bandBottomFraction * h
                val newS = when {
                    abs(y - top) < 40 && abs(x - lineX) < 60 -> s.copy(bandTopFraction = (y / h).coerceIn(0f, s.bandBottomFraction - 0.03f))
                    abs(y - bottom) < 40 && abs(x - lineX) < 60 -> s.copy(bandBottomFraction = (y / h).coerceIn(s.bandTopFraction + 0.03f, 1f))
                    else -> s.copy(lineXFraction = (x / w).coerceIn(0.02f, 0.98f))
                }
                vm.updateSettings(newS)
            }
        }
    ) {
        val w = size.width; val h = size.height
        val x = s.lineXFraction * w
        val top = s.bandTopFraction * h; val bottom = s.bandBottomFraction * h
        drawLine(Color.Yellow.copy(alpha = 0.35f), Offset(x, 0f), Offset(x, h), strokeWidth = 2f,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(16f, 16f)))
        drawRect(color.copy(alpha = 0.35f), Offset(x - 3f, top), androidx.compose.ui.geometry.Size(6f, bottom - top))
        drawRect(color, Offset(x - 11f, top), androidx.compose.ui.geometry.Size(22f, bottom - top),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f))
        drawCircle(color, 18f, Offset(x, top))
        drawCircle(color, 18f, Offset(x, bottom))
    }
}

@Composable
private fun SidePanel(vm: PhotocellViewModel, onHistory: () -> Unit, onSettings: () -> Unit,
                      onEvent: () -> Unit, onAssign: () -> Unit) {
    val snap = vm.snapshot
    Column(
        Modifier.width(360.dp).fillMaxHeight().background(Color(0xE6111111)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        DiagnosticsBlock(vm)
        Stopwatch(vm)
        val pending = vm.pendingResult
        if (pending != null) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) { ResultCard(vm, pending, onAssign) }
        } else {
            Spacer(Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = { vm.calibrate() }, enabled = vm.canCalibrate && !vm.isCalibratingCamera,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E5AA8)), modifier = Modifier.weight(1f)) { Text("Calibrar") }
            Button(onClick = { vm.arm() }, enabled = vm.canArm && !vm.isCalibratingCamera,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)), modifier = Modifier.weight(1f)) { Text("Armar") }
            Button(onClick = { vm.reset() },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFB00020)), modifier = Modifier.weight(1f)) { Text("Reset") }
        }
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onEvent, enabled = !vm.roiLocked) { Text("Prova") }
            OutlinedButton(onClick = onHistory, enabled = !vm.roiLocked) { Text("Histórico") }
            OutlinedButton(onClick = onSettings, enabled = !vm.roiLocked) { Text("Ajustes") }
        }
    }
}

@Composable
private fun Badge(text: String, color: Color) {
    Text(text, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.background(color, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
private fun DiagnosticsBlock(vm: PhotocellViewModel) {
    val snap = vm.snapshot; val d = vm.diagnostics; val ls = vm.lockState; val cap = vm.capability
    val stateColor = when (snap.state) {
        PhotocellState.IDLE -> Color.Gray
        PhotocellState.CALIBRATING -> Color(0xFF1E5AA8)
        PhotocellState.ARMED, PhotocellState.AWAITING_FINISH -> Color(0xFF2E7D32)
        PhotocellState.CONFIRMING_START, PhotocellState.CONFIRMING_FINISH -> Color(0xFFEF6C00)
        PhotocellState.DEBOUNCE_START, PhotocellState.RUNNING, PhotocellState.DEBOUNCE_FINISH -> Color(0xFFB00020)
        PhotocellState.FINISHED -> Color(0xFF00796B)
        PhotocellState.ERROR -> Color.Black
    }
    val stateLabel = when (snap.state) {
        PhotocellState.IDLE -> "Em espera"; PhotocellState.CALIBRATING -> "Calibrando ruído"; PhotocellState.ARMED -> "Armada"
        PhotocellState.CONFIRMING_START -> "Confirmando largada"; PhotocellState.DEBOUNCE_START -> "Largada!"
        PhotocellState.RUNNING -> "Prova em andamento"; PhotocellState.AWAITING_FINISH -> "Aguardando chegada"
        PhotocellState.CONFIRMING_FINISH -> "Confirmando chegada"; PhotocellState.DEBOUNCE_FINISH -> "Chegada!"
        PhotocellState.FINISHED -> "Finalizada"; PhotocellState.ERROR -> "Erro"
    }
    val thermal = when (vm.thermalStatus) { 0 -> "Térmico OK" to Color(0xFF2E7D32); 1 -> "Térmico: leve" to Color(0xFFF9A825)
        2 -> "Térmico: moderado" to Color(0xFFEF6C00); 3 -> "Térmico: sério" to Color(0xFFD84315); else -> "Térmico: crítico" to Color(0xFFB00020) }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Badge(stateLabel, stateColor); Badge(thermal.first, thermal.second)
            if (snap.lag == 2) Badge("Flicker 120 Hz", Color(0xFF6A1B9A))
        }
        val mono = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, color = Color.White.copy(alpha = 0.9f), fontSize = 11.sp)
        Text(cap?.let { "${it.size.width}x${it.size.height} · ${it.mode.label} (medido %s)".format(if (d.fpsValid) "%.1f FPS".format(d.measuredFps) else "—") } ?: "Sondando câmera…", style = mono)
        Text(if (ls.locked) "Exposição 1/%.0f s · ISO %d · foco %s · skew %s".format(1e9 / maxOf(ls.exposureNs, 1L), ls.iso, ls.focusMode, ls.skewNs?.let { "%.2f ms".format(it / 1e6) } ?: "n/d")
             else "Exposição/foco/branco: NÃO travados — toque em Calibrar", style = mono)
        Text("ΔY %.2f (núcleo %.2f) · limiar %s".format(d.lastDeltaFull, d.lastDeltaCore, snap.threshold?.let { "%.2f".format(it) } ?: "—"), style = mono)
        Text("Drops %d · erros %d · custo/quadro %.0f µs · %s".format(snap.drops, d.processingErrors, d.lastFrameCostMicros, cap?.precisionText ?: ""), style = mono)
        if (!vm.roiLocked) vm.armBlockReason?.let { Text(it, style = mono.copy(color = Color(0xFFF9A825))) }
        DeltaMeter(d.lastDeltaCore, snap.threshold ?: 4.0)
    }
}

@Composable
private fun DeltaMeter(value: Double, threshold: Double) {
    val scale = maxOf(threshold * 3, 1.0)
    val frac = (value / scale).coerceIn(0.0, 1.0).toFloat()
    val thFrac = (threshold / scale).coerceIn(0.0, 1.0).toFloat()
    Canvas(Modifier.fillMaxWidth().height(8.dp)) {
        drawRoundRect(Color.White.copy(alpha = 0.15f))
        drawRoundRect(if (frac > thFrac) Color.Red else Color(0xFF39D353), size = androidx.compose.ui.geometry.Size(size.width * frac, size.height))
        drawRect(Color.Yellow, Offset(size.width * thFrac, 0f), androidx.compose.ui.geometry.Size(2f, size.height))
    }
}

/** Cronômetro atualizado a cada quadro do display (Choreographer via withFrameNanos). */
@Composable
private fun Stopwatch(vm: PhotocellViewModel) {
    val snap = vm.snapshot
    var text by remember { mutableStateOf("0:00.000") }
    val running = snap.startNs != null && snap.finishNs == null
    LaunchedEffect(running, snap.startNs, snap.finishNs) {
        val start = snap.startNs
        if (start == null) { text = "0:00.000"; return@LaunchedEffect }
        val finish = snap.finishNs
        if (finish != null) { text = TimeFormatter.formatClock(finish - start); return@LaunchedEffect }
        while (true) {
            withFrameNanos { _ -> text = TimeFormatter.formatClock(vm.sensorClock.nowNs() - start) }
        }
    }
    Text(text, color = Color.White, fontSize = 48.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
}

@Composable
private fun ResultCard(vm: PhotocellViewModel, r: br.com.tportooliveira.fotocelula.results.RunRecord, onAssign: () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion
    Column(Modifier.fillMaxWidth().background(Color(0xFF1F1F1F), RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // quem correu vem antes do número: é o que o operador confere antes de salvar
        val who = if (r.entryId != null) "#${r.entryOrder} ${r.rider}" + (if (r.horse.isNotBlank()) " / ${r.horse}" else "") +
            (if (r.category.isNotBlank()) " — ${r.category}" else "") else "Sem competidor"
        Text(who, color = if (r.entryId != null) Color(0xFF9FD3B0) else Color.Gray, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text("Tempo final", color = Color.White, fontWeight = FontWeight.Bold)
        Text(r.finalText, color = if (r.noTime) Color.Red else Color(0xFF39D353), fontSize = 44.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace)
        val small = MaterialTheme.typography.bodySmall.copy(color = Color.LightGray, fontSize = 11.sp)
        Text("Refinado: ${TimeFormatter.formatElapsed(r.elapsedRefinedNs)} s · bruto: ${TimeFormatter.formatElapsed(r.elapsedRawNs)} s", style = small)
        Text("Qualidade largada %d (±%.2f ms) · chegada %d (±%.2f ms)%s".format(r.startQuality, r.startUncertaintyNs / 1e6, r.finishQuality, r.finishUncertaintyNs / 1e6, if (r.degraded) " · DEGRADADA" else ""), style = small)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Tambores: ${r.barrelsKnocked} (+${r.barrelsKnocked * 5} s)", color = Color.White, fontSize = 13.sp)
            OutlinedButton(onClick = { vm.pendingResult = r.copy(barrelsKnocked = (r.barrelsKnocked - 1).coerceAtLeast(0)); vm.savePendingResult() }) { Text("−") }
            OutlinedButton(onClick = { vm.pendingResult = r.copy(barrelsKnocked = (r.barrelsKnocked + 1).coerceAtMost(3)); vm.savePendingResult() }) { Text("+") }
            OutlinedButton(onClick = { vm.pendingResult = r.copy(noTime = !r.noTime); vm.savePendingResult() }) { Text(if (r.noTime) "SAT ✓" else "SAT") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = { vm.savePendingResult(); vm.reset() }, modifier = Modifier.weight(1f)) {
                Text(if (r.entryId != null) "Salvar para #${r.entryOrder}" else "Salvar e Reset")
            }
            if (vm.events.currentEventId != null) OutlinedButton(onClick = onAssign) { Text("Trocar") }
        }
    }
}
