package br.com.tportooliveira.fotocelula.feedback

import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import br.com.tportooliveira.fotocelula.core.Effect

/** Bipe (ToneGenerator, sem assets) na largada e dois bipes na chegada. O flash é feito pela UI. */
class TriggerFeedback {
    private val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
    private val main = Handler(Looper.getMainLooper())

    fun play(kind: Effect.Feedback.Kind) {
        tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 80)
        if (kind == Effect.Feedback.Kind.FINISH) {
            main.postDelayed({ tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 80) }, 140)
        }
    }

    fun release() = tone.release()
}
