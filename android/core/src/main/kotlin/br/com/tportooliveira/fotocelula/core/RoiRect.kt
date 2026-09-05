package br.com.tportooliveira.fotocelula.core

/**
 * Faixa vertical (Região de Interesse) em coordenadas de pixel do plano Y.
 * [y1] é exclusivo. Endereço(x, y) = base + y*stride + x.
 */
data class RoiRect(val x: Int, val width: Int, val y0: Int, val y1: Int) {
    val height: Int get() = y1 - y0

    fun coreX0(coreWidth: Int): Int = x + (width - coreWidth) / 2

    fun validate(planeWidth: Int, planeHeight: Int, coreWidth: Int) {
        require(width >= 1 && height >= 1) { "ROI vazia" }
        require(x >= 0 && x + width <= planeWidth) { "ROI fora do plano em x" }
        require(y0 >= 0 && y1 <= planeHeight) { "ROI fora do plano em y" }
        require(coreWidth in 1..width) { "coreWidth inválido" }
    }
}
