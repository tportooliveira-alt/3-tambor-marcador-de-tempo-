package br.com.tportooliveira.fotocelula

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Surface
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import br.com.tportooliveira.fotocelula.ui.MainScreen
import br.com.tportooliveira.fotocelula.ui.PhotocellViewModel

/**
 * Atividade única, sempre em paisagem (`sensorLandscape` no manifesto), tela ligada e 120 Hz quando
 * disponível. Pede a permissão de câmera, sonda o hardware e monta a tela.
 */
class MainActivity : ComponentActivity() {
    private lateinit var vm: PhotocellViewModel
    private var permission by mutableStateOf<Boolean?>(null)

    private val requestPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permission = ok
        if (ok) vm.probe()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PhotocellViewModel.keepScreenOn(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        vm = PhotocellViewModel(applicationContext)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            permission = true
            vm.probe()
        } else {
            requestPermission.launch(Manifest.permission.CAMERA)
        }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                when (permission) {
                    true -> {
                        @Suppress("DEPRECATION")
                        val rotation = if (android.os.Build.VERSION.SDK_INT >= 30) (display?.rotation ?: Surface.ROTATION_90)
                                       else windowManager.defaultDisplay.rotation
                        MainScreen(vm, displayRotation = rotation)
                    }
                    false -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Permissão de câmera necessária. A fotocélula usa a câmera traseira em alta velocidade; nenhum vídeo é gravado.")
                    }
                    null -> Box(Modifier.fillMaxSize())
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        vm.close()
    }
}
