package br.com.tportooliveira.fotocelula

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.os.Build
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
 * disponível. Pede a permissão de câmera, sonda o hardware e monta a tela. A câmera abre em onStart
 * e fecha em onStop (uma prova em andamento é interrompida — por projeto, nunca medida às cegas).
 */
class MainActivity : ComponentActivity() {
    private lateinit var vm: PhotocellViewModel
    private var permission by mutableStateOf<Boolean?>(null)
    /** Rotação atual da tela (0/90/180/270 → Surface.ROTATION_*), atualizada pelo DisplayManager. */
    private var rotation by mutableStateOf(Surface.ROTATION_90)

    private val requestPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permission = ok
        if (ok) vm.probe()
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) { rotation = currentRotation() }
    }

    @Suppress("DEPRECATION")
    private fun currentRotation(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) (display?.rotation ?: Surface.ROTATION_90)
        else windowManager.defaultDisplay.rotation

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PhotocellViewModel.keepScreenOn(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        vm = PhotocellViewModel(applicationContext)
        rotation = currentRotation()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            permission = true
            vm.probe()
        } else {
            requestPermission.launch(Manifest.permission.CAMERA)
        }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                when (permission) {
                    true -> MainScreen(vm, displayRotation = rotation)
                    false -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Permissão de câmera necessária. A fotocélula usa a câmera traseira em alta velocidade; nenhum vídeo é gravado.")
                    }
                    null -> Box(Modifier.fillMaxSize())
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).registerDisplayListener(displayListener, null)
        rotation = currentRotation()
        vm.start()
    }

    override fun onStop() {
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(displayListener)
        vm.stop()
        super.onStop()
    }

    override fun onDestroy() {
        super.onDestroy()
        vm.close()
    }
}
