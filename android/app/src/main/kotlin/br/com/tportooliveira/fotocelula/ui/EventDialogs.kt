package br.com.tportooliveira.fotocelula.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import br.com.tportooliveira.fotocelula.results.Entry
import java.io.File

/**
 * Prova: criar/escolher evento, lista de largada (digitada ou importada por CSV), classificação por
 * categoria e a pasta de backup. Tudo local — o app não fala com servidor nenhum.
 */
@Composable
fun EventDialog(vm: PhotocellViewModel, onClose: () -> Unit) {
    val ctx = LocalContext.current
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion + vm.historyVersion
    var tab by remember { mutableStateOf(0) }
    var newName by remember { mutableStateOf("") }
    var newPlace by remember { mutableStateOf("") }
    val current = vm.currentEvent

    val openCsv = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val text = runCatching {
                ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()
            if (text == null) vm.errorMessage = "Não consegui ler o arquivo escolhido."
            else vm.importEntries(text)
        }
    }
    val openTree = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        vm.setBackupFolder(uri)
    }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(current?.let { "Prova: ${it.name}" } ?: "Prova (nenhuma aberta)") },
        text = {
            Column(Modifier.height(360.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("Provas", "Inscrições", "Classificação", "Backup").forEachIndexed { i, label ->
                        OutlinedButton(onClick = { tab = i }) { Text(if (tab == i) "[$label]" else label) }
                    }
                }
                when (tab) {
                    0 -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(newName, { newName = it }, label = { Text("Nome") }, singleLine = true, modifier = Modifier.weight(1f))
                            OutlinedTextField(newPlace, { newPlace = it }, label = { Text("Local") }, singleLine = true, modifier = Modifier.weight(1f))
                            Button(onClick = { vm.createEvent(newName, newPlace); newName = ""; newPlace = "" },
                                enabled = newName.isNotBlank()) { Text("Criar") }
                        }
                        LazyColumn(Modifier.fillMaxWidth()) {
                            items(vm.events.events, key = { it.id }) { e ->
                                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    Text((if (e.id == vm.events.currentEventId) "● " else "○ ") + e.name +
                                        (if (e.place.isNotBlank()) " — ${e.place}" else ""), modifier = Modifier.weight(1f))
                                    TextButton(onClick = { vm.selectEvent(e.id) }) { Text("Abrir") }
                                    TextButton(onClick = { vm.removeEvent(e.id) }) { Text("Excluir") }
                                }
                            }
                        }
                        if (current != null) {
                            TextButton(onClick = { vm.selectEvent(null) }) { Text("Fechar a prova (voltar ao cronômetro avulso)") }
                        }
                    }
                    1 -> EntriesTab(vm, onImport = { openCsv.launch(arrayOf("text/csv", "text/comma-separated-values", "text/plain", "*/*")) })
                    2 -> RankingTab(vm)
                    else -> BackupTab(vm, onChooseFolder = { openTree.launch(null) })
                }
            }
        },
        confirmButton = {
            if (tab == 2 && current != null) {
                Button(onClick = {
                    val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
                    val f = File(dir, "classificacao.csv")
                    f.writeText(vm.events.rankingCsv(current.id, vm.history.records), Charsets.UTF_8)
                    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", f)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/csv"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, "Classificação — ${current.name}")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    ctx.startActivity(Intent.createChooser(send, "Compartilhar classificação"))
                }) { Text("Compartilhar classificação") }
            } else {
                TextButton(onClick = onClose) { Text("OK") }
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Fechar") } },
    )
}

@Composable
private fun EntriesTab(vm: PhotocellViewModel, onImport: () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion + vm.historyVersion
    val ev = vm.events.currentEventId
    if (ev == null) { Text("Abra ou crie uma prova na primeira aba."); return }
    var order by remember { mutableStateOf("") }
    var rider by remember { mutableStateOf("") }
    var horse by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    val entries = vm.events.entriesOf(ev)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(order, { order = it.filter { c -> c.isDigit() } }, label = { Text("Nº") }, singleLine = true, modifier = Modifier.width(70.dp))
            OutlinedTextField(rider, { rider = it }, label = { Text("Competidor") }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(horse, { horse = it }, label = { Text("Cavalo") }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(category, { category = it }, label = { Text("Cat.") }, singleLine = true, modifier = Modifier.width(90.dp))
            Button(onClick = {
                val n = order.toIntOrNull() ?: ((entries.maxOfOrNull { it.order } ?: 0) + 1)
                vm.addEntry(n, rider, horse, category)
                order = ""; rider = ""; horse = ""
            }, enabled = rider.isNotBlank()) { Text("+") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = onImport) { Text("Importar CSV") }
            Text("formato: ordem;competidor;cavalo;categoria", fontSize = 11.sp, color = Color.Gray)
        }
        LazyColumn(Modifier.fillMaxWidth()) {
            items(entries, key = { it.id }) { e ->
                val done = vm.history.records.any { it.entryId == e.id }
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text((if (done) "✓ " else "· ") + e.label, modifier = Modifier.weight(1f))
                    TextButton(onClick = { vm.removeEntry(e.id) }) { Text("Excluir") }
                }
            }
        }
    }
}

@Composable
private fun RankingTab(vm: PhotocellViewModel) {
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion + vm.historyVersion
    val ev = vm.events.currentEventId
    if (ev == null) { Text("Abra ou crie uma prova na primeira aba."); return }
    val records = vm.history.records
    // linhas já pareadas dentro de cada categoria pelo EventStore: a mesma ordem de largada existe
    // em categorias diferentes, então nem a chave nem o competidor podem sair de um mapa por número
    val rows = vm.events.rankingRows(ev, records)
    if (rows.isEmpty()) { Text("Nenhuma passada salva nesta prova ainda."); return }
    LazyColumn(Modifier.fillMaxWidth()) {
        items(rows.size, key = { i -> rows[i].second.id }) { i ->
            val (p, r) = rows[i]
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(p.place?.let { "${it}º" } ?: "SAT", fontWeight = FontWeight.Bold, modifier = Modifier.width(48.dp))
                Column(Modifier.weight(1f)) {
                    Text("#${p.entryOrder} ${r.rider}${if (r.horse.isNotBlank()) " / ${r.horse}" else ""}")
                    Text((if (r.category.isNotBlank()) "${r.category} · " else "") +
                        "bruto ${TimeFormatter.formatElapsed(r.elapsedRawNs)}" +
                        (if (p.penaltyNs > 0) " · +${p.penaltyNs / 1_000_000_000}s" else ""),
                        style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                }
                Text(if (p.place == null) "—" else TimeFormatter.formatElapsed(p.finalNs),
                    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun BackupTab(vm: PhotocellViewModel, onChooseFolder: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Escolha uma pasta (Drive, Arquivos, cartão). A cada passada salva o app reescreve ali " +
            "`fotocelula-historico.csv` e, com uma prova aberta, a classificação. Se o celular sumir, " +
            "a planilha sobrevive.", style = MaterialTheme.typography.bodySmall)
        val uri = vm.settings.backupTreeUri
        Text(if (uri.isEmpty()) "Backup desligado." else "Pasta: $uri", fontSize = 11.sp, color = Color.Gray)
        vm.backupError?.let { Text(it, color = Color(0xFFB00020), fontSize = 12.sp) }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = onChooseFolder) { Text(if (uri.isEmpty()) "Escolher pasta" else "Trocar pasta") }
            if (uri.isNotEmpty()) {
                OutlinedButton(onClick = { vm.writeBackup() }) { Text("Copiar agora") }
                OutlinedButton(onClick = { vm.clearBackupFolder() }) { Text("Desligar") }
            }
        }
    }
}

/** Escolher outra inscrição para a passada em aberto (quando a ordem de largada muda na hora). */
@Composable
fun AssignEntryDialog(vm: PhotocellViewModel, onClose: () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion + vm.historyVersion
    val ev = vm.events.currentEventId
    val entries: List<Entry> = if (ev == null) emptyList() else vm.events.entriesOf(ev)
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Atribuir a passada") },
        text = {
            Column(Modifier.height(300.dp)) {
                if (entries.isEmpty()) Text("Nenhuma inscrição nesta prova.")
                LazyColumn {
                    items(entries, key = { it.id }) { e ->
                        val done = vm.history.records.any { it.entryId == e.id && it.id != vm.pendingResult?.id }
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text((if (done) "✓ " else "· ") + e.label, modifier = Modifier.weight(1f))
                            TextButton(onClick = { vm.assignPending(e); onClose() }) { Text("Escolher") }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { vm.assignPending(null); onClose() }) { Text("Sem competidor") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancelar") } },
    )
}

/** Faixa "Próximo: #12 João / Estrela" — o operador lê de longe, com luva, no sol. */
@Composable
fun NextEntryBanner(vm: PhotocellViewModel, modifier: Modifier = Modifier) {
    // o EventStore e o histórico não são observáveis: ler os contadores AQUI (antes de qualquer
    // return) é o que faz a faixa avançar para o próximo competidor quando uma passada é salva
    @Suppress("UNUSED_VARIABLE") val version = vm.eventVersion + vm.historyVersion
    val e = vm.nextEntry ?: return
    Column(modifier.background(Color(0xE6143024), RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 6.dp)) {
        Text("PRÓXIMO", color = Color(0xFF9FD3B0), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Text(e.label, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Black, maxLines = 1)
    }
}
