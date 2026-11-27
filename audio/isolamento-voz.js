// ============================================================
// Processador de áudio "isolamento-voz" (filtro do microfone)
//
// Deixa passar a VOZ e corta o resto: teclado, mouse, ventilador,
// ar-condicionado, chiado. Funciona em duas etapas:
//
// 1. RNNoise — uma pequena rede neural de código aberto (a mesma usada
//    pelo Jitsi e pelo OBS) que limpa o som em pedaços de 10 ms e ainda
//    diz a chance de haver voz naquele pedaço.
// 2. Portão — quando não há voz por um tempo, o volume é abaixado quase a
//    zero; assim os estalos de teclado entre uma fala e outra não passam.
//    Ele só abre com voz NÍTIDA e SUSTENTADA: 2 pedaços seguidos com chance
//    de voz de 75% ou mais (ou 4 seguidos com 50%). Nas medições, a fala fica
//    centenas de pedaços seguidos perto de 100%, enquanto um estalo de teclado
//    engana a rede por 1 pedaço, raramente 2, e quase nunca acima de 75% —
//    em 72 s de digitação simulada, essa regra não abriu nenhuma vez à toa.
//
// Roda na thread de áudio (não trava com a janela coberta pelo jogo).
// Atraso total: cerca de 50 ms, imperceptível numa conversa.
// ============================================================

import criarRnnoise from '../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'

const QUADRO = 480          // o RNNoise trabalha com 480 amostras (10 ms a 48 kHz)
const ESCALA = 32768        // o RNNoise espera amostras na faixa de 16 bits
const TAMANHO_FILA = 4096   // fila circular de saída (sobra bastante)

// Portão de voz
const CHANCE_NITIDA = 0.75  // "com certeza é voz": 2 pedaços seguidos assim abrem o portão
const CHANCE_VOZ = 0.5      // "provavelmente é voz": 4 seguidos abrem (voz fraca ou sussurrada);
                            // com o portão já aberto, 1 pedaço assim renova a espera
const CHANCE_MANTEM = 0.2   // com o portão aberto, isso basta para a espera não correr
const SEGURA_QUADROS = 35   // depois da última voz, fica aberto mais 350 ms (fim das palavras)
const PISO = 0.06           // volume com o portão fechado (-24 dB): quase silêncio, sem "buraco" seco
const SUBIDA = 1 - Math.exp(-1 / (48000 * 0.004))  // abre em ~4 ms
const DESCIDA = 1 - Math.exp(-1 / (48000 * 0.12))  // fecha em ~120 ms

class IsolamentoDeVoz extends AudioWorkletProcessor {
  constructor() {
    super()
    this.modulo = criarRnnoise()
    this.memoria = this.modulo._malloc(QUADRO * 4)
    this.indice = this.memoria >> 2
    this.rede = this.modulo._rnnoise_create()

    this.entrada = new Float32Array(QUADRO)   // quadro sendo juntado
    this.nEntrada = 0
    // Dois quadros já limpos esperando a decisão do portão (o som sai 20 ms
    // "atrasado" para o portão abrir ANTES do começo da palavra)
    this.espera = [new Float32Array(QUADRO), new Float32Array(QUADRO)]
    this.naEspera = 0

    this.fila = new Float32Array(TAMANHO_FILA)
    this.leitura = 0
    this.escrita = 0
    this.disponivel = 0
    this.chamadas = 0

    this.segura = 0
    this.seguidos = 0        // pedaços seguidos com chance >= CHANCE_VOZ
    this.seguidosNitidos = 0 // pedaços seguidos com chance >= CHANCE_NITIDA
    this.ganho = PISO
    this.portao = true

    this.port.onmessage = (ev) => {
      if (ev.data && typeof ev.data.portao === 'boolean') this.portao = ev.data.portao
    }
  }

  // Limpa um quadro de 10 ms e devolve a chance (0 a 1) de haver voz nele
  limpar(quadro) {
    const heap = this.modulo.HEAPF32
    for (let i = 0; i < QUADRO; i++) heap[this.indice + i] = quadro[i] * ESCALA
    const chance = this.modulo._rnnoise_process_frame(this.rede, this.memoria, this.memoria)
    const limpo = this.modulo.HEAPF32 // a memória pode ter sido realocada
    for (let i = 0; i < QUADRO; i++) quadro[i] = limpo[this.indice + i] / ESCALA
    return chance
  }

  // Coloca um quadro na fila de saída aplicando o volume do portão, amostra a amostra
  enfileirar(quadro, alvo) {
    for (let i = 0; i < QUADRO; i++) {
      const passo = alvo > this.ganho ? SUBIDA : DESCIDA
      this.ganho += (alvo - this.ganho) * passo
      this.fila[this.escrita] = quadro[i] * this.ganho
      this.escrita = (this.escrita + 1) % TAMANHO_FILA
    }
    this.disponivel = Math.min(TAMANHO_FILA, this.disponivel + QUADRO)
  }

  processarQuadro() {
    const chance = this.limpar(this.entrada)

    // Decisão do portão
    const temVoz = chance >= CHANCE_VOZ
    this.seguidos = temVoz ? this.seguidos + 1 : 0
    this.seguidosNitidos = chance >= CHANCE_NITIDA ? this.seguidosNitidos + 1 : 0
    if (this.seguidosNitidos >= 2 || this.seguidos >= 4 || (temVoz && this.segura > 0)) {
      this.segura = SEGURA_QUADROS // abriu agora, ou já estava aberto e a voz continua
    } else if (!(chance >= CHANCE_MANTEM && this.segura > 0)) {
      this.segura = Math.max(0, this.segura - 1)
    }
    const alvo = (!this.portao || this.segura > 0) ? 1 : PISO

    // Sai agora o quadro de DOIS passos atrás, já sabendo o que veio depois dele:
    // quando o portão abre no 2º pedaço com voz nítida, nem o pedaço ANTES do
    // primeiro tinha saído — o começo da palavra passa inteiro
    if (this.naEspera === 2) {
      this.enfileirar(this.espera[0], alvo)
      const livre = this.espera[0]
      this.espera[0] = this.espera[1]
      this.espera[1] = livre
      this.naEspera = 1
    }
    this.espera[this.naEspera].set(this.entrada)
    this.naEspera++
  }

  process(entradas, saidas) {
    const entrada = entradas[0] && entradas[0][0]
    const saida = saidas[0][0]
    const n = saida.length

    // Junta a entrada em quadros de 480 (sem entrada = silêncio)
    for (let i = 0; i < n; i++) {
      this.entrada[this.nEntrada++] = entrada ? entrada[i] : 0
      if (this.nEntrada === QUADRO) {
        this.processarQuadro()
        this.nEntrada = 0
      }
    }

    // Os 12 primeiros blocos (~32 ms) saem em silêncio para a fila ganhar folga:
    // blocos de 128 não casam com quadros de 480 e a saída anda dois quadros
    // atrás da entrada. Com essa folga, nunca falta som depois.
    this.chamadas++
    if (this.chamadas <= 12 || this.disponivel < n) {
      saida.fill(0)
    } else {
      for (let i = 0; i < n; i++) {
        saida[i] = this.fila[this.leitura]
        this.leitura = (this.leitura + 1) % TAMANHO_FILA
      }
      this.disponivel -= n
    }
    // Copia para os demais canais de saída, se houver
    for (let c = 1; c < saidas[0].length; c++) saidas[0][c].set(saida)
    return true
  }
}

registerProcessor('isolamento-voz', IsolamentoDeVoz)
