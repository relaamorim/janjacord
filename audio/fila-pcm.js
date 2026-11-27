// ============================================================
// Processador de áudio "fila-pcm" (som de um aplicativo na transmissão)
//
// Roda na thread de áudio: recebe pedaços de PCM 16 bits (48 kHz, estéreo)
// e os toca em sequência, sem depender de agendamento por relógio. Isso
// importa porque, quando a janela do JanjaCord está coberta pelo jogo, o
// Chromium desacelera os temporizadores da página.
//
// Fica num ARQUIVO próprio de propósito: a regra de segurança da página
// (Content-Security-Policy) só deixa carregar código que vem de arquivos do
// aplicativo. Na versão 1.13 este código era carregado "da memória" (Blob),
// a regra bloqueava e o som do aplicativo nunca chegava à transmissão.
// ============================================================

class FilaPcm extends AudioWorkletProcessor {
  constructor() {
    super()
    this.fila = []              // pedaços Int16Array intercalados (E, D, E, D...)
    this.posicao = 0            // posição de leitura no primeiro pedaço
    this.guardados = 0          // quadros à espera
    this.limite = 48000 * 0.5   // no máximo meio segundo na fila, senão o atraso só cresce
    this.port.onmessage = (ev) => {
      const amostras = new Int16Array(ev.data)
      this.fila.push(amostras)
      this.guardados += amostras.length / 2
      while (this.guardados > this.limite && this.fila.length > 1) {
        const velho = this.fila.shift()
        this.guardados -= (velho.length - this.posicao) / 2
        this.posicao = 0
      }
    }
  }

  process(entradas, saidas) {
    const esq = saidas[0][0]
    const dir = saidas[0][1] || esq
    for (let i = 0; i < esq.length; i++) {
      if (!this.fila.length) { esq[i] = 0; dir[i] = 0; continue }
      const atual = this.fila[0]
      esq[i] = atual[this.posicao] / 32768
      dir[i] = atual[this.posicao + 1] / 32768
      this.posicao += 2
      this.guardados--
      if (this.posicao >= atual.length) { this.fila.shift(); this.posicao = 0 }
    }
    return true
  }
}

registerProcessor('fila-pcm', FilaPcm)
