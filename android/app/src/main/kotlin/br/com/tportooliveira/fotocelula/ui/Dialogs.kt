package br.com.tportooliveira.fotocelula.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Histórico com exportação CSV via Storage Access Framework (o usuário escolhe onde salvar). */
@Composable
fun HistoryDialog(vm: PhotocellViewModel, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val version = vm.historyVersion
    val records = vm.history.records
    val createDoc = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) {
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(vm.history.toCsv().toByteArray(Charsets.UTF_8)) }
        }
    }
    val df = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Histórico (${records.size}) · v$version") },
        text = {
            LazyColumn(Modifier.height(300.dp)) {
                items(records, key = { it.id }) { r ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column {
                            Text("${r.finalText}  ${listOf(r.rider, r.horse).filter { it.isNotEmpty() }.joinToString(" · ")}")
                            Text("${df.format(Date(r.dateMillis))} · bruto ${TimeFormatter.formatElapsed(r.elapsedRawNs)} · refinado ${TimeFormatter.formatElapsed(r.elapsedRefinedNs)} · q${r.startQuality}/${r.finishQuality}${if (r.degraded) " · degradada" else ""}",
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = { vm.deleteRecord(r.id) }) { Text("Excluir") }
                    }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                // Compartilhar: manda o CSV direto pelo WhatsApp/e-mail/Drive (o arquivo vai para uma
                // subpasta do cache exposta pelo FileProvider, nada mais do app fica acessível).
                Button(onClick = {
                    val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
                    val f = File(dir, "fotocelula-tambor.csv")
                    f.writeText(vm.history.toCsv(), Charsets.UTF_8)
                    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", f)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/csv"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, "Histórico Fotocélula Tambor")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    ctx.startActivity(Intent.createChooser(send, "Compartilhar histórico"))
                }, enabled = records.isNotEmpty()) { Text("Compartilhar") }
                Button(onClick = { createDoc.launch("fotocelula-tambor.csv") }, enabled = records.isNotEmpty()) { Text("Salvar CSV") }
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Fechar") } },
    )
}

/** Ajustes principais (faixa, exposição, janelas, confirmação, flicker, feedback). */
@Composable
fun SettingsDialog(vm: PhotocellViewModel, onClose: () -> Unit) {
    val s = vm.settings
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Ajustes") },
        text = {
            Column(Modifier.height(360.dp).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Largura da faixa: ${s.stripWidthPx} px")
                Slider(value = s.stripWidthPx.toFloat(), onValueChange = { vm.updateSettings(s.copy(stripWidthPx = it.toInt())) }, valueRange = 5f..40f, steps = 34)
                Text("Colunas centrais (gatilho): ${s.coreWidth}")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(1, 3, 5).forEach { c -> OutlinedButton(onClick = { vm.updateSettings(s.copy(coreWidth = c)) }) { Text(if (c == s.coreWidth) "[$c]" else "$c") } }
                }
                Text("Exposição desejada")
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    AppSettings.exposureChoices.forEach { (label, ns) ->
                        OutlinedButton(onClick = { vm.updateSettings(s.copy(exposureNs = ns)) }) { Text(label.substringBefore(" ("), maxLines = 1) }
                    }
                }
                // Bancada/treino: janelas curtas para repetir o teste a cada poucos segundos.
                // Prova: as janelas da especificação (1,5 s / 8 s / 10 s / 2 s).
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = {
                        vm.updateSettings(s.copy(startLockoutMs = 500, frameResumeS = 1.5f, finishArmS = 2.0f, finishLockoutMs = 500))
                    }) { Text("Modo teste") }
                    OutlinedButton(onClick = {
                        vm.updateSettings(s.copy(startLockoutMs = 1500, frameResumeS = 8f, finishArmS = 10f, finishLockoutMs = 2000))
                    }) { Text("Modo prova") }
                }
                Text("Bloqueio na largada: ${s.startLockoutMs} ms")
                Slider(value = s.startLockoutMs.toFloat(), onValueChange = { vm.updateSettings(s.copy(startLockoutMs = (it / 100).toInt() * 100)) }, valueRange = 500f..5000f)
                Text("Retomar quadros aos %.1f s · armar chegada aos %.1f s".format(s.frameResumeS, s.finishArmS))
                Slider(value = s.finishArmS, onValueChange = { vm.updateSettings(s.copy(finishArmS = it, frameResumeS = minOf(s.frameResumeS, it - 0.5f))) }, valueRange = 2.5f..20f)
                Text("Bloqueio na chegada: ${s.finishLockoutMs} ms")
                Slider(value = s.finishLockoutMs.toFloat(), onValueChange = { vm.updateSettings(s.copy(finishLockoutMs = (it / 100).toInt() * 100)) }, valueRange = 500f..5000f)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Curva de tom (gamma 2,2)"); Switch(checked = s.gamma > 1.05f, onCheckedChange = { vm.updateSettings(s.copy(gamma = if (it) 2.2f else 1.0f)) })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Flicker 120 Hz auto"); Switch(checked = s.flickerAuto, onCheckedChange = { vm.updateSettings(s.copy(flickerAuto = it)) })
                    Text("Bipe"); Switch(checked = s.feedbackSound, onCheckedChange = { vm.updateSettings(s.copy(feedbackSound = it)) })
                    Text("Flash"); Switch(checked = s.feedbackFlash, onCheckedChange = { vm.updateSettings(s.copy(feedbackFlash = it)) })
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("OK") } },
    )
}
