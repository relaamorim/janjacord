// ============================================================
// JanjaCord — lógica da interface
//
// Como funciona, em resumo:
// • Quem CRIA a sala vira o "anfitrião": recebe um código e fica
//   com um endereço fixo na rede (via serviço gratuito PeerJS).
// • Quem ENTRA usa o código para achar o anfitrião. O anfitrião
//   apresenta todo mundo, e cada pessoa conecta áudio e tela
//   DIRETAMENTE com as outras (conexão ponto a ponto).
// • O vídeo da tela é enviado em Full HD (1920x1080) com taxa de
//   bits reforçada para o texto ficar nítido.
// ============================================================

'use strict'

// ---------- atalhos e estado geral ----------

const $ = (id) => document.getElementById(id)

// Prefixo do endereço do anfitrião na rede. Continua "mydisc" de propósito:
// mudar quebraria as salas entre quem já tem o app e quem acabou de atualizar.
const PREFIXO_SALA = 'mydisc-v1-'
const LIMITE_PESSOAS = 10         // máximo de pessoas na sala (contando o anfitrião)

// Orçamento de internet para a tela compartilhada: quem transmite envia uma
// cópia para CADA espectador, então dividimos o total entre eles.
const ORCAMENTO_TELA = 18_000_000 // total de ~18 Mbps de envio para a tela
const TETO_TELA = 6_000_000       // com poucos espectadores: máximo por pessoa
const PISO_TELA = 1_500_000       // com muitos espectadores: mínimo por pessoa

// Canais de voz: toda sala nasce com o canal "Geral"
const CANAL_PADRAO = { id: 'geral', nome: 'Geral' }
const LIMITE_CANAIS = 8

const estado = {
  nome: '',
  codigo: '',
  souAnfitriao: false,
  peer: null,            // minha identidade na rede (PeerJS)
  meuId: null,
  conexaoAnfitriao: null, // (só membro) canal de dados com o anfitrião
  membros: new Map(),     // id -> { nome, ehAnfitriao, mudo, conexaoDados, chamadaVoz, audioEl, pararMonitor }
  streamMic: null,
  micEhSilencioso: false, // true quando não achamos microfone e criamos um "mudo"
  micMudo: false,
  streamTela: null,
  chamadasTela: new Map(),  // id -> chamada de vídeo que EU iniciei
  transmissoes: new Map(),  // id -> { nome, stream, propria, tile } (até 2 telas no ar por canal)
  layout: localStorage.getItem('mydisc-layout') || 'dividida', // 'dividida' ou 'foco'
  focoId: null,             // no modo foco: qual transmissão está grande
  canais: [],               // canais de voz da sala: [{ id, nome }]
  meuCanal: null,           // em qual canal de voz eu estou agora
  pararMeuMonitor: null,
  saindo: false,
  chatAberto: false,
  naoLidas: 0,
  historicoChat: []  // (só o anfitrião) últimas mensagens, para quem chega depois
}

let contextoAudio = null // usado para detectar quem está falando

// ---------- preferências salvas (ficam guardadas entre um uso e outro) ----------

const prefMic = () => localStorage.getItem('mydisc-mic') || ''            // '' = padrão do Windows
const prefSaida = () => localStorage.getItem('mydisc-saida') || ''        // '' = padrão do Windows
const prefResolucao = () => localStorage.getItem('mydisc-resolucao') || '1080'

// ---------- avisos rápidos (toasts) ----------

function avisar(mensagem, tipo = 'ok') {
  const caixa = document.createElement('div')
  caixa.className = 'toast' + (tipo === 'erro' ? ' erro' : tipo === 'info' ? ' info' : '')
  caixa.textContent = mensagem
  $('area-toasts').appendChild(caixa)
  setTimeout(() => {
    caixa.classList.add('saindo')
    setTimeout(() => caixa.remove(), 350)
  }, 4200)
}

// ---------- utilidades ----------

// Gera um código de sala fácil de ditar (sem letras/números confusos como O e 0)
function gerarCodigo() {
  const letras = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let codigo = ''
  for (let i = 0; i < 6; i++) {
    codigo += letras[Math.floor(Math.random() * letras.length)]
  }
  return codigo
}

function iniciaisDoNome(nome) {
  const partes = nome.trim().split(/\s+/)
  const primeira = partes[0]?.[0] || '?'
  const segunda = partes.length > 1 ? partes[partes.length - 1][0] : (partes[0]?.[1] || '')
  return (primeira + segunda).toUpperCase()
}

// Cada nome ganha uma cor própria e constante
function corDoNome(nome) {
  let hash = 0
  for (let i = 0; i < nome.length; i++) {
    hash = (hash * 31 + nome.charCodeAt(i)) >>> 0
  }
  return `hsl(${hash % 360}, 62%, 46%)`
}

function atualizarStatus(classe, texto) {
  const alvo = $('status-conexao')
  alvo.classList.remove('conectando', 'conectado', 'erro')
  alvo.classList.add(classe)
  $('texto-status').textContent = texto
}

function trocarParaTela(idTela) {
  document.querySelectorAll('.tela').forEach((t) => t.classList.remove('ativa'))
  $(idTela).classList.add('ativa')
}

// ============================================================
// LISTA DE PARTICIPANTES
// ============================================================

function renderizarParticipantes() {
  const lista = $('lista-participantes')
  lista.innerHTML = ''

  const todos = [{
    id: estado.meuId || 'eu',
    nome: estado.nome + ' (você)',
    nomeCor: estado.nome,
    ehAnfitriao: estado.souAnfitriao,
    mudo: estado.micMudo,
    transmitindo: estado.transmissoes.has(estado.meuId),
    canal: estado.meuCanal,
    propria: true
  }]

  for (const [id, membro] of estado.membros) {
    todos.push({
      id,
      nome: membro.nome,
      nomeCor: membro.nome,
      ehAnfitriao: !!membro.ehAnfitriao,
      mudo: !!membro.mudo,
      transmitindo: estado.transmissoes.has(id),
      canal: membro.canal,
      propria: false
    })
  }

  // Desenha cada canal com as pessoas que estão dentro dele
  const canais = estado.canais.length ? estado.canais : [CANAL_PADRAO]
  const canaisValidos = new Set(canais.map((c) => c.id))

  for (const canal of canais) {
    const bloco = document.createElement('li')
    bloco.className = 'canal'

    const cabecalho = document.createElement('div')
    cabecalho.className = 'canal-cabecalho' + (canal.id === estado.meuCanal ? ' atual' : '')
    cabecalho.title = canal.id === estado.meuCanal
      ? 'Você está neste canal'
      : 'Clique para entrar neste canal de voz'
    cabecalho.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>'

    const nomeCanal = document.createElement('span')
    nomeCanal.textContent = canal.nome
    cabecalho.appendChild(nomeCanal)

    // Pessoas deste canal (quem tiver canal desconhecido cai no primeiro)
    const pessoas = todos.filter((p) =>
      p.canal === canal.id || (!canaisValidos.has(p.canal) && canal === canais[0])
    )

    const quantidade = document.createElement('span')
    quantidade.className = 'canal-qtd'
    quantidade.textContent = pessoas.length ? String(pessoas.length) : ''
    cabecalho.appendChild(quantidade)

    cabecalho.addEventListener('click', () => trocarDeCanal(canal.id))
    bloco.appendChild(cabecalho)

    const membrosDoCanal = document.createElement('ul')
    membrosDoCanal.className = 'canal-membros'
    for (const pessoa of pessoas) {
      membrosDoCanal.appendChild(construirItemParticipante(pessoa))
    }
    bloco.appendChild(membrosDoCanal)

    lista.appendChild(bloco)
  }

  $('contador-pessoas').textContent = String(todos.length)
}

// Monta o cartãozinho de uma pessoa (avatar, nome, estado e volume)
function construirItemParticipante(pessoa) {
    const item = document.createElement('li')
    item.className = 'participante' + (pessoa.propria ? '' : ' remoto')
    item.dataset.id = pessoa.id

    const linha = document.createElement('div')
    linha.className = 'participante-linha'

    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.style.background = corDoNome(pessoa.nomeCor)
    avatar.textContent = iniciaisDoNome(pessoa.nomeCor)

    const info = document.createElement('div')
    info.className = 'participante-info'

    const nome = document.createElement('span')
    nome.className = 'participante-nome'
    nome.textContent = pessoa.nome
    if (pessoa.ehAnfitriao) {
      nome.insertAdjacentHTML('beforeend',
        '<svg class="coroa" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<path fill="currentColor" d="M3 8l4.5 3L12 5l4.5 6L21 8l-1.5 10h-15L3 8z"/></svg>')
    }
    info.appendChild(nome)

    if (pessoa.transmitindo) {
      const rotulo = document.createElement('span')
      rotulo.className = 'participante-estado transmitindo'
      rotulo.textContent = '● Transmitindo a tela'
      info.appendChild(rotulo)
    }

    linha.appendChild(avatar)
    linha.appendChild(info)

    if (pessoa.mudo) {
      linha.insertAdjacentHTML('beforeend',
        '<svg class="icone-mudo" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path fill="currentColor" d="M3.3 2.3 21.7 20.7l-1.4 1.4-4.2-4.2A6.96 6.96 0 0 1 13 18.9V21h-2v-2.08A7 7 0 0 1 5 11h2a5 5 0 0 0 7.6 4.27l-1.5-1.5A3 3 0 0 1 9 11v-.76L1.9 3.7l1.4-1.4zM15 11c0 .17-.01.33-.04.49L9.5 6.03V6a3 3 0 1 1 6 0v5h-.5zm4 0h-2c0 .61-.11 1.2-.31 1.74l1.51 1.51c.51-.98.8-2.08.8-3.25z"/></svg>')
    }

    item.appendChild(linha)

    // Nas outras pessoas, clicar abre um controle de volume só para ela
    if (!pessoa.propria) {
      const membro = estado.membros.get(pessoa.id)
      linha.title = 'Clique para ajustar o volume desta pessoa'

      const linhaVolume = document.createElement('div')
      linhaVolume.className = 'linha-volume'

      const controle = document.createElement('input')
      controle.type = 'range'
      controle.min = '0'
      controle.max = '100'
      controle.value = String(membro && membro.volume != null ? membro.volume : 100)

      const valor = document.createElement('span')
      valor.className = 'valor-volume'
      valor.textContent = controle.value + '%'

      controle.addEventListener('input', () => {
        const v = Number(controle.value)
        valor.textContent = v + '%'
        if (membro) {
          membro.volume = v
          if (membro.audioEl) membro.audioEl.volume = v / 100
        }
      })
      linhaVolume.addEventListener('click', (e) => e.stopPropagation())

      linhaVolume.appendChild(controle)
      linhaVolume.appendChild(valor)
      item.appendChild(linhaVolume)

      if (membro && membro.volumeAberto) item.classList.add('volume-aberto')

      linha.addEventListener('click', () => {
        if (!membro) return
        membro.volumeAberto = !membro.volumeAberto
        item.classList.toggle('volume-aberto', membro.volumeAberto)
      })
    }

    return item
}

function marcarFalando(id, falando) {
  const item = document.querySelector(`.participante[data-id="${id}"]`)
  if (item) item.classList.toggle('falando', falando)
}

// ============================================================
// MICROFONE E DETECÇÃO DE FALA
// ============================================================

// Monta o pedido de microfone respeitando o aparelho escolhido nas configurações
function restricoesDeMicrofone() {
  const restricoes = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (prefMic()) restricoes.deviceId = { exact: prefMic() }
  return { audio: restricoes }
}

// Tenta abrir o microfone; se não houver, cria um áudio silencioso
// (assim a conexão de voz funciona mesmo sem microfone — só para ouvir)
async function obterMicrofone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(restricoesDeMicrofone())
    estado.micEhSilencioso = false
    return stream
  } catch (primeiroErro) {
    // O microfone escolhido pode ter sido desconectado — tenta o padrão
    if (prefMic()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        estado.micEhSilencioso = false
        avisar('O microfone escolhido não foi encontrado — usando o padrão do Windows.', 'info')
        return stream
      } catch (_) { /* segue para o plano C logo abaixo */ }
    }
    return microfoneSilencioso(primeiroErro)
  }
}

function microfoneSilencioso(erro) {
  console.log('Sem microfone disponível:', erro.name)
  estado.micEhSilencioso = true
  avisar('Microfone não encontrado — você entrou apenas para ouvir.', 'info')
  const ctx = obterContextoAudio()
  const destino = ctx.createMediaStreamDestination()
  return destino.stream
}

function obterContextoAudio() {
  if (!contextoAudio) contextoAudio = new AudioContext()
  if (contextoAudio.state === 'suspended') contextoAudio.resume()
  return contextoAudio
}

// Observa o volume de um áudio e avisa quando a pessoa está falando
function monitorarFala(stream, aoMudar) {
  if (!stream.getAudioTracks().length) return () => {}
  const ctx = obterContextoAudio()
  const origem = ctx.createMediaStreamSource(stream)
  const analisador = ctx.createAnalyser()
  analisador.fftSize = 512
  origem.connect(analisador)

  const dados = new Uint8Array(analisador.fftSize)
  let estavaFalando = false

  const intervalo = setInterval(() => {
    analisador.getByteTimeDomainData(dados)
    let soma = 0
    for (let i = 0; i < dados.length; i++) {
      const desvio = (dados[i] - 128) / 128
      soma += desvio * desvio
    }
    const volume = Math.sqrt(soma / dados.length)
    const falando = volume > 0.03
    if (falando !== estavaFalando) {
      estavaFalando = falando
      aoMudar(falando)
    }
  }, 140)

  return () => {
    clearInterval(intervalo)
    try { origem.disconnect() } catch (_) { /* ignora */ }
    aoMudar(false)
  }
}

// Toca o áudio de outra pessoa e liga o detector de fala dela
function tocarAudioDe(id, stream) {
  const membro = garantirMembro(id, null)
  if (membro.audioEl) membro.audioEl.remove()
  if (membro.pararMonitor) membro.pararMonitor()

  const audio = document.createElement('audio')
  audio.autoplay = true
  audio.srcObject = stream
  // Respeita o volume individual e a saída de som escolhida nas configurações
  audio.volume = (membro.volume != null ? membro.volume : 100) / 100
  if (prefSaida() && audio.setSinkId) {
    audio.setSinkId(prefSaida()).catch(() => { /* saída não existe mais: usa a padrão */ })
  }
  $('area-audios').appendChild(audio)

  membro.audioEl = audio
  membro.pararMonitor = monitorarFala(stream, (falando) => marcarFalando(id, falando))
}

// ============================================================
// CONEXÕES (PeerJS)
// ============================================================

// Garante que um membro exista no mapa (útil quando a ligação de voz
// chega um instante antes do aviso oficial de "fulano entrou")
function garantirMembro(id, nome) {
  if (!estado.membros.has(id)) {
    estado.membros.set(id, {
      nome: nome || 'Convidado',
      ehAnfitriao: false,
      mudo: false,
      canal: estado.meuCanal || CANAL_PADRAO.id
    })
    renderizarParticipantes()
  } else if (nome) {
    estado.membros.get(id).nome = nome
  }
  return estado.membros.get(id)
}

function criarPeer(idDesejado) {
  // Sem argumentos o PeerJS usa o servidor público e gratuito deles
  // apenas para o "aperto de mão"; áudio e vídeo vão direto entre os PCs.
  const peer = idDesejado ? new Peer(idDesejado, { debug: 1 }) : new Peer({ debug: 1 })

  // Alguém está me ligando (voz ou tela)
  peer.on('call', (chamada) => {
    const meta = chamada.metadata || {}

    if (meta.tipo === 'voz') {
      chamada.answer(estado.streamMic || undefined)
      const membro = garantirMembro(chamada.peer, meta.nome)
      if (membro.chamadaVoz && membro.chamadaVoz !== chamada) {
        try { membro.chamadaVoz.close() } catch (_) { /* ignora */ }
      }
      membro.chamadaVoz = chamada
      chamada.on('stream', (stream) => tocarAudioDe(chamada.peer, stream))
      chamada.on('close', () => {
        if (membro.chamadaVoz === chamada) desligarVozDe(chamada.peer)
      })
    }

    if (meta.tipo === 'tela') {
      chamada.answer() // só recebo, não envio nada de volta
      chamada.on('stream', (stream) => {
        adicionarTransmissao(chamada.peer, meta.nome || 'Alguém', stream, false)
      })
      chamada.on('close', () => removerTransmissao(chamada.peer))
    }
  })

  peer.on('disconnected', () => {
    if (estado.saindo) return
    atualizarStatus('conectando', 'Reconectando…')
    try { peer.reconnect() } catch (_) { /* ignora */ }
  })

  peer.on('error', (erro) => {
    console.log('Erro de conexão:', erro.type, erro.message)
    if (estado.saindo) return

    if (erro.type === 'peer-unavailable') {
      // Esse erro também aparece ao ligar para alguém que acabou de sair,
      // então só significa "sala não existe" se eu ainda nem entrei nela.
      if (!estado.souAnfitriao && estado.membros.size === 0) {
        avisar('Sala não encontrada. Confira o código e tente de novo.', 'erro')
        sairDaSala(null, true)
      }
    } else if (erro.type === 'network' || erro.type === 'server-error') {
      atualizarStatus('erro', 'Sem conexão')
      avisar('Problema de conexão com a internet. Tentando de novo…', 'erro')
    }
  })

  return peer
}

// ---------- criar sala (anfitrião) ----------

async function criarSala(tentativa = 0) {
  estado.nome = $('campo-nome').value.trim()
  if (!estado.nome) {
    avisar('Escreva seu nome primeiro. 🙂', 'erro')
    $('campo-nome').focus()
    return
  }
  localStorage.setItem('mydisc-nome', estado.nome)

  estado.souAnfitriao = true
  estado.codigo = gerarCodigo()
  estado.saindo = false

  $('botao-criar').disabled = true

  const peer = criarPeer(PREFIXO_SALA + estado.codigo.toLowerCase())
  estado.peer = peer

  peer.on('open', async (id) => {
    estado.meuId = id
    $('botao-criar').disabled = false
    estado.canais = [{ ...CANAL_PADRAO }]
    estado.meuCanal = CANAL_PADRAO.id
    entrarNaTelaDaSala()
    atualizarStatus('conectado', 'Conectado')
    estado.streamMic = await obterMicrofone()
    ligarMeuDetectorDeFala()
    avisar(`Sala ${estado.codigo} criada! Compartilhe o código.`)
  })

  // Se por coincidência o código já estiver em uso, tenta outro
  peer.on('error', (erro) => {
    if (erro.type === 'unavailable-id' && tentativa < 3) {
      peer.destroy()
      criarSala(tentativa + 1)
    } else if (erro.type === 'unavailable-id') {
      $('botao-criar').disabled = false
      avisar('Não consegui criar a sala agora. Tente de novo.', 'erro')
    }
  })

  // Alguém novo chegou na sala
  peer.on('connection', (conexao) => {
    conexao.on('open', () => {
      // Sala cheia? Avisa e desconecta educadamente
      if (estado.membros.size + 1 >= LIMITE_PESSOAS) {
        conexao.send({ tipo: 'sala-cheia' })
        setTimeout(() => conexao.close(), 300)
        return
      }

      const nomeNovo = (conexao.metadata && conexao.metadata.nome) || 'Convidado'

      // Apresenta a sala para quem chegou: quem já está aqui + quem transmite
      conexao.send({
        tipo: 'bemvindo',
        nomeAnfitriao: estado.nome,
        canalAnfitriao: estado.meuCanal,
        codigo: estado.codigo,
        canais: estado.canais,
        membros: [...estado.membros.entries()].map(([id, m]) => ({
          id, nome: m.nome, mudo: !!m.mudo, canal: m.canal || CANAL_PADRAO.id
        })),
        historico: estado.historicoChat.slice(-50)
      })

      // Avisa os demais (quem chega sempre começa no canal Geral)
      enviarParaTodos({ tipo: 'entrou', id: conexao.peer, nome: nomeNovo, canal: CANAL_PADRAO.id }, conexao.peer)

      const membro = garantirMembro(conexao.peer, nomeNovo)
      membro.conexaoDados = conexao
      membro.canal = CANAL_PADRAO.id
      renderizarParticipantes()
      avisar(`${nomeNovo} entrou na sala.`, 'info')
      mensagemSistema(`${nomeNovo} entrou na sala`)

      // Se eu transmito no canal Geral, incluo a pessoa nova
      if (estado.streamTela && estado.meuCanal === CANAL_PADRAO.id) ligarTelaPara(conexao.peer)
    })

    conexao.on('data', (mensagem) => tratarMensagemComoAnfitriao(conexao, mensagem))

    conexao.on('close', () => removerMembro(conexao.peer))
    conexao.on('error', () => removerMembro(conexao.peer))
  })
}

// O anfitrião recebe estados dos membros e repassa a todos
function tratarMensagemComoAnfitriao(conexao, mensagem) {
  if (!mensagem || typeof mensagem !== 'object') return
  const id = conexao.peer
  const membro = estado.membros.get(id)
  if (!membro) return

  if (mensagem.tipo === 'mudo') {
    membro.mudo = !!mensagem.ativo
    renderizarParticipantes()
    enviarParaTodos({ tipo: 'mudo', id, ativo: membro.mudo }, id)
  }

  if (mensagem.tipo === 'compartilhando') {
    // O quadro em si aparece quando o vídeo chega; aqui só repassamos o aviso
    if (!mensagem.ativo) removerTransmissao(id)
    renderizarParticipantes()
    enviarParaTodos({
      tipo: 'compartilhando', id, nome: membro.nome, ativo: !!mensagem.ativo
    }, id)
  }

  if (mensagem.tipo === 'mudei-canal') {
    // Confere se o canal existe antes de espalhar a mudança
    if (!estado.canais.some((c) => c.id === mensagem.canal)) return
    enviarParaTodos({ tipo: 'canal', id, canal: mensagem.canal }, id)
    reagirMudancaDeCanal(id, mensagem.canal)
    return
  }

  if (mensagem.tipo === 'chat') {
    const texto = String(mensagem.texto || '').slice(0, 1000).trim()
    if (!texto) return
    // O anfitrião "carimba" a mensagem (autor + horário) e repassa a todos
    const carimbada = { tipo: 'chat', id, nome: membro.nome, texto, hora: Date.now() }
    estado.historicoChat.push(carimbada)
    if (estado.historicoChat.length > 50) estado.historicoChat.shift()
    enviarParaTodos(carimbada, id)
    renderizarMensagemChat(carimbada, false)
  }
}

function enviarParaTodos(mensagem, excetoId) {
  for (const [id, membro] of estado.membros) {
    if (id === excetoId) continue
    if (membro.conexaoDados && membro.conexaoDados.open) {
      membro.conexaoDados.send(mensagem)
    }
  }
}

function removerMembro(id) {
  const membro = estado.membros.get(id)
  if (!membro) return

  if (membro.audioEl) membro.audioEl.remove()
  if (membro.pararMonitor) membro.pararMonitor()
  if (membro.chamadaVoz) { try { membro.chamadaVoz.close() } catch (_) { /* ignora */ } }

  const chamadaTela = estado.chamadasTela.get(id)
  if (chamadaTela) { try { chamadaTela.close() } catch (_) { /* ignora */ } }
  estado.chamadasTela.delete(id)

  // Um espectador a menos: sobra mais qualidade para os que ficaram
  if (estado.streamTela) atualizarQualidadeDaTela()

  estado.membros.delete(id)

  removerTransmissao(id)

  if (estado.souAnfitriao) {
    enviarParaTodos({ tipo: 'saiu', id })
    avisar(`${membro.nome} saiu da sala.`, 'info')
    mensagemSistema(`${membro.nome} saiu da sala`)
  }

  renderizarParticipantes()
}

// ============================================================
// CHAT DE TEXTO
// ============================================================

let ultimoAutorChat = null // para agrupar mensagens seguidas da mesma pessoa
let ultimaHoraChat = 0

function horaFormatada(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Desenha uma mensagem no painel. "silenciosa" = não conta como não lida
// (usada para o histórico que chega quando você entra na sala)
function renderizarMensagemChat(msg, propria, silenciosa = false) {
  const area = $('chat-mensagens')

  // Mensagens seguidas da mesma pessoa (em até 3 min) ficam agrupadas
  const continuacao = msg.id === ultimoAutorChat && (msg.hora - ultimaHoraChat) < 180000
  ultimoAutorChat = msg.id
  ultimaHoraChat = msg.hora

  const caixa = document.createElement('div')
  caixa.className = 'mensagem' + (continuacao ? ' continuacao' : '')

  if (!continuacao) {
    const cabecalho = document.createElement('div')
    cabecalho.className = 'mensagem-cabecalho'

    const autor = document.createElement('span')
    autor.className = 'mensagem-autor'
    autor.style.color = corDoNome(msg.nome)
    autor.textContent = propria ? `${msg.nome} (você)` : msg.nome

    const hora = document.createElement('span')
    hora.className = 'mensagem-hora'
    hora.textContent = horaFormatada(msg.hora)

    cabecalho.appendChild(autor)
    cabecalho.appendChild(hora)
    caixa.appendChild(cabecalho)
  }

  const texto = document.createElement('div')
  texto.className = 'mensagem-texto'
  // Endereços de site viram links clicáveis (abrem no navegador)
  for (const parte of msg.texto.split(/(https?:\/\/\S+)/g)) {
    if (/^https?:\/\//.test(parte)) {
      const link = document.createElement('a')
      link.href = parte
      link.textContent = parte
      link.target = '_blank'
      link.rel = 'noreferrer'
      texto.appendChild(link)
    } else if (parte) {
      texto.appendChild(document.createTextNode(parte))
    }
  }
  caixa.appendChild(texto)

  area.appendChild(caixa)
  area.scrollTop = area.scrollHeight

  if (!propria && !silenciosa && !estado.chatAberto) {
    estado.naoLidas++
    atualizarSeloChat()
  }
}

// Linha cinza central, tipo "Fulano entrou na sala"
function mensagemSistema(texto) {
  ultimoAutorChat = null
  const area = $('chat-mensagens')
  const linha = document.createElement('div')
  linha.className = 'mensagem-sistema'
  linha.textContent = `• ${texto}`
  area.appendChild(linha)
  area.scrollTop = area.scrollHeight
}

function enviarMensagemChat() {
  const campo = $('campo-chat')
  const texto = campo.value.trim()
  if (!texto) return

  if (!estado.souAnfitriao && !(estado.conexaoAnfitriao && estado.conexaoAnfitriao.open)) {
    avisar('Sem conexão com a sala agora. Tente de novo.', 'erro')
    return
  }

  campo.value = ''
  const minha = { tipo: 'chat', id: estado.meuId, nome: estado.nome, texto, hora: Date.now() }

  if (estado.souAnfitriao) {
    estado.historicoChat.push(minha)
    if (estado.historicoChat.length > 50) estado.historicoChat.shift()
    enviarParaTodos(minha)
  } else {
    // O anfitrião carimba e repassa para os outros
    estado.conexaoAnfitriao.send({ tipo: 'chat', texto })
  }

  renderizarMensagemChat(minha, true)
}

function abrirFecharChat() {
  estado.chatAberto = !estado.chatAberto
  $('painel-chat').classList.toggle('escondido', !estado.chatAberto)
  $('botao-chat').classList.toggle('ativo', estado.chatAberto)
  if (estado.chatAberto) {
    estado.naoLidas = 0
    atualizarSeloChat()
    const area = $('chat-mensagens')
    area.scrollTop = area.scrollHeight
    $('campo-chat').focus()
  }
}

function atualizarSeloChat() {
  const selo = $('selo-chat')
  selo.textContent = estado.naoLidas > 9 ? '9+' : String(estado.naoLidas)
  selo.classList.toggle('escondido', estado.naoLidas === 0)
}

// ---------- entrar em sala (convidado) ----------

async function entrarEmSala() {
  estado.nome = $('campo-nome').value.trim()
  const codigo = $('campo-codigo').value.trim().toUpperCase()

  if (!estado.nome) {
    avisar('Escreva seu nome primeiro. 🙂', 'erro')
    $('campo-nome').focus()
    return
  }
  if (codigo.length < 6) {
    avisar('O código da sala tem 6 letras/números.', 'erro')
    $('campo-codigo').focus()
    return
  }
  localStorage.setItem('mydisc-nome', estado.nome)

  estado.souAnfitriao = false
  estado.codigo = codigo
  estado.saindo = false

  $('botao-entrar').disabled = true

  const peer = criarPeer(null)
  estado.peer = peer

  peer.on('open', async (id) => {
    estado.meuId = id

    // Pega o microfone ANTES de ligar para os outros
    estado.streamMic = await obterMicrofone()

    const conexao = peer.connect(PREFIXO_SALA + codigo.toLowerCase(), {
      reliable: true,
      metadata: { nome: estado.nome }
    })
    estado.conexaoAnfitriao = conexao

    // Se em 10 segundos ninguém responder, desiste
    const alarme = setTimeout(() => {
      if (!estado.membros.size) {
        avisar('Não consegui entrar na sala. Confira o código.', 'erro')
        sairDaSala(null, true)
      }
    }, 10000)

    conexao.on('data', (mensagem) => {
      tratarMensagemComoConvidado(mensagem, alarme)
    })

    conexao.on('close', () => {
      if (!estado.saindo) sairDaSala('A sala foi encerrada pelo anfitrião.')
    })
  })
}

function tratarMensagemComoConvidado(mensagem, alarme) {
  if (!mensagem || typeof mensagem !== 'object') return

  if (mensagem.tipo === 'sala-cheia') {
    clearTimeout(alarme)
    avisar('Essa sala já está cheia (máximo de 10 pessoas).', 'erro')
    sairDaSala(null, true)
    return
  }

  if (mensagem.tipo === 'bemvindo') {
    clearTimeout(alarme)
    $('botao-entrar').disabled = false

    // A lista de canais da sala (e eu começo no Geral)
    estado.canais = mensagem.canais && mensagem.canais.length
      ? mensagem.canais : [{ ...CANAL_PADRAO }]
    estado.meuCanal = CANAL_PADRAO.id

    // O anfitrião entra na minha lista
    const idAnfitriao = PREFIXO_SALA + estado.codigo.toLowerCase()
    estado.membros.set(idAnfitriao, {
      nome: mensagem.nomeAnfitriao,
      ehAnfitriao: true,
      mudo: false,
      canal: mensagem.canalAnfitriao || CANAL_PADRAO.id
    })

    // E os outros convidados também
    for (const m of mensagem.membros) {
      estado.membros.set(m.id, {
        nome: m.nome, ehAnfitriao: false, mudo: !!m.mudo, canal: m.canal || CANAL_PADRAO.id
      })
    }

    entrarNaTelaDaSala()
    atualizarStatus('conectado', 'Conectado')
    ligarMeuDetectorDeFala()
    avisar(`Você entrou na sala de ${mensagem.nomeAnfitriao}!`)

    // Mostra as últimas conversas do chat para quem acabou de chegar
    for (const antiga of (mensagem.historico || [])) {
      renderizarMensagemChat(antiga, false, true)
    }

    // EU liguei agora, então EU inicio a chamada de voz — só com o meu canal
    for (const [id, m] of estado.membros) {
      if (m.canal === estado.meuCanal) ligarVozPara(id)
    }
    renderizarParticipantes()
    return
  }

  if (mensagem.tipo === 'entrou') {
    const novato = garantirMembro(mensagem.id, mensagem.nome)
    novato.canal = mensagem.canal || CANAL_PADRAO.id
    avisar(`${mensagem.nome} entrou na sala.`, 'info')
    mensagemSistema(`${mensagem.nome} entrou na sala`)
    renderizarParticipantes()
    // Quem chegou é quem liga para mim — eu só espero.
    // Mas se EU estiver transmitindo no canal em que a pessoa caiu, envio a tela:
    if (estado.streamTela && estado.meuCanal === novato.canal) ligarTelaPara(mensagem.id)
    return
  }

  if (mensagem.tipo === 'novo-canal') {
    estado.canais.push(mensagem.canal)
    avisar(`Canal de voz "${mensagem.canal.nome}" criado!`, 'info')
    renderizarParticipantes()
    return
  }

  if (mensagem.tipo === 'canal') {
    reagirMudancaDeCanal(mensagem.id, mensagem.canal)
    return
  }

  if (mensagem.tipo === 'saiu') {
    const membro = estado.membros.get(mensagem.id)
    if (membro) {
      avisar(`${membro.nome} saiu da sala.`, 'info')
      mensagemSistema(`${membro.nome} saiu da sala`)
    }
    removerMembro(mensagem.id)
    return
  }

  if (mensagem.tipo === 'mudo') {
    const membro = estado.membros.get(mensagem.id)
    if (membro) { membro.mudo = !!mensagem.ativo; renderizarParticipantes() }
    return
  }

  if (mensagem.tipo === 'compartilhando') {
    // O quadro em si aparece quando o vídeo chega; aqui só tiramos quem parou
    if (!mensagem.ativo) removerTransmissao(mensagem.id)
    renderizarParticipantes()
    return
  }

  if (mensagem.tipo === 'chat') {
    renderizarMensagemChat(mensagem, mensagem.id === estado.meuId)
  }
}

// ---------- chamadas de voz ----------

function ligarVozPara(id) {
  if (!estado.peer || !estado.streamMic) return
  const membro = garantirMembro(id, null)
  if (membro.chamadaVoz) return // já estamos conectados
  const chamada = estado.peer.call(id, estado.streamMic, {
    metadata: { tipo: 'voz', nome: estado.nome }
  })
  if (!chamada) return
  membro.chamadaVoz = chamada
  chamada.on('stream', (stream) => tocarAudioDe(id, stream))
  chamada.on('close', () => {
    if (membro.chamadaVoz === chamada) desligarVozDe(id)
  })
}

// Encerra só a parte de VOZ com uma pessoa (usada ao trocar de canal)
function desligarVozDe(id) {
  const membro = estado.membros.get(id)
  if (!membro) return
  if (membro.chamadaVoz) {
    const chamada = membro.chamadaVoz
    membro.chamadaVoz = null
    try { chamada.close() } catch (_) { /* ignora */ }
  }
  if (membro.audioEl) { membro.audioEl.remove(); membro.audioEl = null }
  if (membro.pararMonitor) { membro.pararMonitor(); membro.pararMonitor = null }
}

// ============================================================
// CANAIS DE VOZ
// Você só ouve (e só vê a tela de) quem está no MESMO canal.
// ============================================================

function trocarDeCanal(novoCanal) {
  if (!estado.peer || novoCanal === estado.meuCanal) return
  estado.meuCanal = novoCanal

  // Despede do canal antigo: para de ouvir e de ver as telas de lá
  for (const [id, membro] of estado.membros) {
    if (membro.canal !== novoCanal) {
      desligarVozDe(id)
      removerTransmissao(id)
    }
  }

  // Cumprimenta o canal novo: quem se move é quem liga para os outros
  for (const [id, membro] of estado.membros) {
    if (membro.canal === novoCanal) ligarVozPara(id)
  }

  // Se eu estava transmitindo a tela, ela me acompanha para o canal novo
  if (estado.streamTela) {
    for (const [, chamada] of estado.chamadasTela) {
      try { chamada.close() } catch (_) { /* ignora */ }
    }
    estado.chamadasTela.clear()
    for (const [id, membro] of estado.membros) {
      if (membro.canal === novoCanal) ligarTelaPara(id)
    }
  }

  // Conta para a sala onde eu estou agora
  if (estado.souAnfitriao) {
    enviarParaTodos({ tipo: 'canal', id: estado.meuId, canal: novoCanal })
  } else if (estado.conexaoAnfitriao && estado.conexaoAnfitriao.open) {
    estado.conexaoAnfitriao.send({ tipo: 'mudei-canal', canal: novoCanal })
  }

  renderizarParticipantes()
}

// Alguém trocou de canal: ajusta voz e telas do meu lado
function reagirMudancaDeCanal(id, canal) {
  const membro = estado.membros.get(id)
  if (!membro) return
  membro.canal = canal

  if (canal !== estado.meuCanal) {
    // Saiu do meu canal: paro de ouvir e de ver a tela dele
    desligarVozDe(id)
    removerTransmissao(id)
    const chamadaTela = estado.chamadasTela.get(id)
    if (chamadaTela) {
      try { chamadaTela.close() } catch (_) { /* ignora */ }
      estado.chamadasTela.delete(id)
      if (estado.streamTela) atualizarQualidadeDaTela()
    }
  } else {
    // Entrou no meu canal: ele liga a voz para mim; se transmito, mando a tela
    if (estado.streamTela) ligarTelaPara(id)
  }

  renderizarParticipantes()
}

// (só o anfitrião) cria um canal de voz novo e apresenta para a sala
function criarCanal(nome) {
  nome = String(nome || '').trim().slice(0, 20)
  if (!nome) return
  if (estado.canais.length >= LIMITE_CANAIS) {
    avisar(`O máximo é ${LIMITE_CANAIS} canais de voz.`, 'erro')
    return
  }
  const canal = {
    id: 'canal-' + (estado.canais.length + 1) + '-' + Math.random().toString(36).slice(2, 6),
    nome
  }
  estado.canais.push(canal)
  enviarParaTodos({ tipo: 'novo-canal', canal })
  renderizarParticipantes()
  avisar(`Canal de voz "${nome}" criado!`)
}

function ligarMeuDetectorDeFala() {
  if (estado.pararMeuMonitor) estado.pararMeuMonitor()
  if (!estado.streamMic || estado.micEhSilencioso) return
  estado.pararMeuMonitor = monitorarFala(estado.streamMic, (falando) => {
    marcarFalando(estado.meuId || 'eu', falando && !estado.micMudo)
  })
}

function alternarMicrofone() {
  if (estado.micEhSilencioso) {
    avisar('Nenhum microfone foi encontrado neste computador.', 'erro')
    return
  }
  estado.micMudo = !estado.micMudo
  estado.streamMic.getAudioTracks().forEach((t) => { t.enabled = !estado.micMudo })

  $('botao-mic').classList.toggle('mudo', estado.micMudo)
  $('icone-mic-ligado').classList.toggle('escondido', estado.micMudo)
  $('icone-mic-mudo').classList.toggle('escondido', !estado.micMudo)

  // Conta para os outros que mutei / desmutei
  if (estado.souAnfitriao) {
    enviarParaTodos({ tipo: 'mudo', id: estado.meuId, ativo: estado.micMudo })
  } else if (estado.conexaoAnfitriao && estado.conexaoAnfitriao.open) {
    estado.conexaoAnfitriao.send({ tipo: 'mudo', ativo: estado.micMudo })
  }
  renderizarParticipantes()
}

// ============================================================
// COMPARTILHAMENTO DE TELA (Full HD)
// ============================================================

const LIMITE_TRANSMISSOES = 2 // quantas telas podem estar no ar ao mesmo tempo

async function alternarCompartilhamento() {
  // Já estou transmitindo? Então parar.
  if (estado.streamTela) {
    pararMinhaTela()
    return
  }

  // O palco já está cheio?
  if (estado.transmissoes.size >= LIMITE_TRANSMISSOES) {
    avisar('Já existem duas telas sendo transmitidas. Peça para alguém parar primeiro.', 'info')
    return
  }

  try {
    // Pede a captura na resolução escolhida nas configurações
    // (Full HD 1920x1080 ou HD 1280x720), a 30 quadros por segundo.
    // O Electron vai abrir o nosso seletor de tela/janela.
    const emHd = prefResolucao() === '720'
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: emHd ? 1280 : 1920 },
        height: { ideal: emHd ? 720 : 1080 },
        frameRate: { ideal: 30, max: 60 }
      },
      audio: true // o som do sistema só vem se a caixinha for marcada
    })

    estado.streamTela = stream

    const trilha = stream.getVideoTracks()[0]
    // "detail" = priorizar nitidez (ótimo para texto e telas de programas)
    try { trilha.contentHint = 'detail' } catch (_) { /* ignora */ }

    // Se a captura acabar por qualquer motivo, arruma tudo
    trilha.onended = () => pararMinhaTela()

    // Mostra minha própria tela no palco (sem som, para não dar eco)
    adicionarTransmissao(estado.meuId, estado.nome, stream, true)

    // Envia a tela para quem está no MEU canal de voz
    for (const [id, membro] of estado.membros) {
      if (membro.canal === estado.meuCanal) ligarTelaPara(id)
    }

    // Avisa a sala
    if (estado.souAnfitriao) {
      enviarParaTodos({ tipo: 'compartilhando', id: estado.meuId, nome: estado.nome, ativo: true })
    } else if (estado.conexaoAnfitriao && estado.conexaoAnfitriao.open) {
      estado.conexaoAnfitriao.send({ tipo: 'compartilhando', ativo: true })
    }

    $('botao-tela').classList.add('transmitindo')
    $('texto-botao-tela').textContent = 'Parar de compartilhar'
    renderizarParticipantes()
  } catch (erro) {
    // Usuário cancelou o seletor — não é um problema
    console.log('Compartilhamento cancelado ou negado:', erro.name)
  }
}

function ligarTelaPara(id) {
  if (!estado.peer || !estado.streamTela) return
  if (estado.chamadasTela.has(id)) return // já estou enviando para essa pessoa
  const chamada = estado.peer.call(id, estado.streamTela, {
    metadata: { tipo: 'tela', nome: estado.nome }
  })
  if (!chamada) return
  estado.chamadasTela.set(id, chamada)
  // Chegou mais um espectador: reequilibra a qualidade de todo mundo
  atualizarQualidadeDaTela()
}

// Quanto de internet cada espectador recebe agora
function taxaPorEspectador() {
  const espectadores = Math.max(1, estado.chamadasTela.size)
  const fatia = Math.floor(ORCAMENTO_TELA / espectadores)
  return Math.min(TETO_TELA, Math.max(PISO_TELA, fatia))
}

// Reaplica a qualidade em todas as transmissões ativas
// (chamado quando alguém entra ou sai durante o compartilhamento)
function atualizarQualidadeDaTela() {
  for (const [, chamada] of estado.chamadasTela) {
    reforcarQualidade(chamada)
  }
}

// Ajusta o limite de qualidade do vídeo enviado:
// taxa de bits calculada + manter a resolução mesmo se a rede oscilar
function reforcarQualidade(chamada, tentativa = 0) {
  const conexaoBruta = chamada.peerConnection
  const remetente = conexaoBruta &&
    conexaoBruta.getSenders().find((s) => s.track && s.track.kind === 'video')

  if (!remetente) {
    if (tentativa < 10) setTimeout(() => reforcarQualidade(chamada, tentativa + 1), 500)
    return
  }

  const parametros = remetente.getParameters()
  if (!parametros.encodings || !parametros.encodings.length) {
    parametros.encodings = [{}]
  }
  parametros.encodings[0].maxBitrate = taxaPorEspectador()
  parametros.degradationPreference = 'maintain-resolution'

  remetente.setParameters(parametros).catch(() => {
    if (tentativa < 10) setTimeout(() => reforcarQualidade(chamada, tentativa + 1), 500)
  })
}

function pararMinhaTela() {
  if (!estado.streamTela) return

  estado.streamTela.getTracks().forEach((t) => { try { t.stop() } catch (_) { /* ignora */ } })
  estado.streamTela = null

  for (const [, chamada] of estado.chamadasTela) {
    try { chamada.close() } catch (_) { /* ignora */ }
  }
  estado.chamadasTela.clear()

  removerTransmissao(estado.meuId)

  if (estado.souAnfitriao) {
    enviarParaTodos({ tipo: 'compartilhando', id: estado.meuId, nome: estado.nome, ativo: false })
  } else if (estado.conexaoAnfitriao && estado.conexaoAnfitriao.open) {
    estado.conexaoAnfitriao.send({ tipo: 'compartilhando', ativo: false })
  }

  $('botao-tela').classList.remove('transmitindo')
  $('texto-botao-tela').textContent = 'Compartilhar tela'
  renderizarParticipantes()
}

// ============================================================
// PALCO COM ATÉ DUAS TRANSMISSÕES
// Cada transmissão vira um "quadro" (vídeo + etiqueta com o nome).
// Com duas no ar, dá para escolher o layout: Dividida ou Foco.
// ============================================================

function adicionarTransmissao(id, nome, stream, propria) {
  // Se essa pessoa já tinha um quadro (ex.: reconexão), limpa o antigo
  removerTransmissao(id, true)

  const quadro = document.createElement('div')
  quadro.className = 'tile'

  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.srcObject = stream
  video.muted = !!propria // nunca tocar meu próprio som de volta
  if (!propria && prefSaida() && video.setSinkId) {
    video.setSinkId(prefSaida()).catch(() => { /* saída não existe mais: usa a padrão */ })
  }
  video.title = 'Clique duas vezes para tela cheia'
  video.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else video.requestFullscreen().catch(() => { /* ignora */ })
  })

  const etiqueta = document.createElement('span')
  etiqueta.className = 'tile-nome'
  etiqueta.textContent = propria ? 'Você' : nome

  quadro.appendChild(video)
  quadro.appendChild(etiqueta)

  // No modo Foco, clicar na tela pequena traz ela para a frente
  quadro.addEventListener('click', () => {
    if (estado.layout === 'foco' && quadro.classList.contains('miniatura')) {
      estado.focoId = id
      renderizarPalco()
    }
  })

  estado.transmissoes.set(id, { nome, stream, propria, tile: quadro })
  if (estado.transmissoes.size === 1) estado.focoId = id
  renderizarPalco()
  renderizarParticipantes()
}

function removerTransmissao(id, silencioso = false) {
  const transmissao = estado.transmissoes.get(id)
  if (!transmissao) return
  transmissao.tile.remove()
  estado.transmissoes.delete(id)

  // Se quem saiu era o destaque do modo Foco, promove a que sobrou
  if (estado.focoId === id) {
    const primeira = estado.transmissoes.keys().next()
    estado.focoId = primeira.done ? null : primeira.value
  }

  if (!silencioso) {
    renderizarPalco()
    renderizarParticipantes()
  }
}

function renderizarPalco() {
  const quantas = estado.transmissoes.size
  $('palco-vazio').classList.toggle('escondido', quantas > 0)
  $('palco-video').classList.toggle('escondido', quantas === 0)
  $('botoes-layout').classList.toggle('escondido', quantas < 2)

  const area = $('area-tiles')
  area.className = 'area-tiles ' + (quantas < 2 ? 'uma' : estado.layout)

  for (const [id, transmissao] of estado.transmissoes) {
    transmissao.tile.classList.remove('principal', 'miniatura')
    if (quantas >= 2 && estado.layout === 'foco') {
      transmissao.tile.classList.add(id === estado.focoId ? 'principal' : 'miniatura')
    }
    area.appendChild(transmissao.tile)
  }

  atualizarFaixa()
  $('layout-dividida').classList.toggle('ativa', estado.layout === 'dividida')
  $('layout-foco').classList.toggle('ativa', estado.layout === 'foco')
}

// Texto da faixa do topo: quem está transmitindo agora
function atualizarFaixa() {
  const nomes = []
  let aMinhaEstaNoAr = false
  for (const [, transmissao] of estado.transmissoes) {
    if (transmissao.propria) aMinhaEstaNoAr = true
    else nomes.push(transmissao.nome)
  }

  let texto = ''
  if (aMinhaEstaNoAr && nomes.length) texto = `Você e ${nomes[0]} estão compartilhando`
  else if (aMinhaEstaNoAr) texto = 'Você está compartilhando'
  else if (nomes.length > 1) texto = `Telas de ${nomes[0]} e ${nomes[1]}`
  else if (nomes.length === 1) texto = `Tela de ${nomes[0]}`
  $('texto-compartilhando').textContent = texto
}

function trocarLayout(novo) {
  estado.layout = novo
  localStorage.setItem('mydisc-layout', novo)
  renderizarPalco()
}

// ============================================================
// SELETOR DE TELA/JANELA (chamado pelo processo principal)
// ============================================================

let fontesDisponiveis = []
let fonteSelecionada = null
let abaAtual = 'tela'

window.mydisc.aoAbrirSeletorFonte((fontes) => {
  fontesDisponiveis = fontes
  fonteSelecionada = null
  abaAtual = 'tela'
  $('opcao-com-som').checked = false
  $('botao-confirmar-fonte').disabled = true
  atualizarAbas()
  preencherGradeDeFontes()
  $('modal-seletor').classList.remove('escondido')
})

function atualizarAbas() {
  $('aba-telas').classList.toggle('ativa', abaAtual === 'tela')
  $('aba-janelas').classList.toggle('ativa', abaAtual === 'janela')
}

function preencherGradeDeFontes() {
  const grade = $('grade-fontes')
  grade.innerHTML = ''

  const visiveis = fontesDisponiveis.filter((f) => f.tipo === abaAtual)

  if (!visiveis.length) {
    const vazio = document.createElement('div')
    vazio.className = 'grade-vazia'
    vazio.textContent = 'Nada encontrado por aqui.'
    grade.appendChild(vazio)
    return
  }

  for (const fonte of visiveis) {
    const botao = document.createElement('button')
    botao.className = 'fonte'
    if (fonteSelecionada === fonte.id) botao.classList.add('selecionada')

    const mini = document.createElement('img')
    mini.className = 'mini'
    mini.src = fonte.miniatura
    mini.alt = ''
    botao.appendChild(mini)

    const nome = document.createElement('span')
    nome.className = 'fonte-nome'
    if (fonte.icone) {
      const icone = document.createElement('img')
      icone.src = fonte.icone
      icone.alt = ''
      nome.appendChild(icone)
    }
    nome.appendChild(document.createTextNode(fonte.nome))
    botao.appendChild(nome)

    botao.addEventListener('click', () => {
      fonteSelecionada = fonte.id
      $('botao-confirmar-fonte').disabled = false
      grade.querySelectorAll('.fonte').forEach((b) => b.classList.remove('selecionada'))
      botao.classList.add('selecionada')
    })

    botao.addEventListener('dblclick', () => {
      fonteSelecionada = fonte.id
      confirmarFonte()
    })

    grade.appendChild(botao)
  }
}

function confirmarFonte() {
  if (!fonteSelecionada) return
  window.mydisc.responderFonte({
    id: fonteSelecionada,
    comSom: $('opcao-com-som').checked
  })
  $('modal-seletor').classList.add('escondido')
}

function cancelarFonte() {
  window.mydisc.responderFonte(null)
  $('modal-seletor').classList.add('escondido')
}

// ============================================================
// CONFIGURAÇÕES (microfone, saída de som e resolução)
// ============================================================

async function abrirConfiguracoes() {
  $('modal-config').classList.remove('escondido')

  // Marca a resolução salva
  const salva = prefResolucao()
  document.querySelectorAll('input[name="resolucao"]').forEach((radio) => {
    radio.checked = radio.value === salva
  })

  await preencherListaDeAparelhos()
}

function fecharConfiguracoes() {
  $('modal-config').classList.add('escondido')
}

// Preenche as listas de microfones e saídas de som do computador
async function preencherListaDeAparelhos() {
  // O Windows só revela os NOMES dos aparelhos depois de uma permissão de
  // áudio; se ainda não temos microfone aberto, pedimos um por um instante.
  let temporario = null
  try {
    if (!estado.streamMic || estado.micEhSilencioso) {
      temporario = await navigator.mediaDevices.getUserMedia({ audio: true })
    }
  } catch (_) { /* sem microfone nenhum: as listas ficam genéricas */ }

  const aparelhos = await navigator.mediaDevices.enumerateDevices()
  if (temporario) temporario.getTracks().forEach((t) => t.stop())

  montarSeletor($('seletor-mic'), aparelhos.filter((a) => a.kind === 'audioinput'),
    prefMic(), 'Microfone')
  montarSeletor($('seletor-saida'), aparelhos.filter((a) => a.kind === 'audiooutput'),
    prefSaida(), 'Saída')
}

function montarSeletor(seletor, aparelhos, escolhido, apelido) {
  seletor.innerHTML = ''

  const padrao = document.createElement('option')
  padrao.value = ''
  padrao.textContent = 'Padrão do Windows'
  seletor.appendChild(padrao)

  let numero = 1
  for (const aparelho of aparelhos) {
    if (aparelho.deviceId === 'default' || aparelho.deviceId === 'communications') continue
    const opcao = document.createElement('option')
    opcao.value = aparelho.deviceId
    opcao.textContent = aparelho.label || `${apelido} ${numero}`
    seletor.appendChild(opcao)
    numero++
  }

  seletor.value = escolhido
  if (seletor.value !== escolhido) seletor.value = '' // aparelho sumiu: volta ao padrão
}

// Troca o microfone NO MEIO da chamada, sem derrubar ninguém:
// substitui a trilha de áudio dentro de cada conexão já aberta
async function aplicarNovoMicrofone() {
  if (!estado.peer) return // fora da sala, a escolha vale na próxima entrada

  try {
    const novoStream = await navigator.mediaDevices.getUserMedia(restricoesDeMicrofone())
    const novaTrilha = novoStream.getAudioTracks()[0]
    novaTrilha.enabled = !estado.micMudo

    for (const [, membro] of estado.membros) {
      const conexao = membro.chamadaVoz && membro.chamadaVoz.peerConnection
      const remetente = conexao &&
        conexao.getSenders().find((s) => s.track && s.track.kind === 'audio')
      if (remetente) remetente.replaceTrack(novaTrilha).catch(() => { /* ignora */ })
    }

    if (estado.streamMic) {
      estado.streamMic.getTracks().forEach((t) => { try { t.stop() } catch (_) { /* ignora */ } })
    }
    estado.streamMic = novoStream
    estado.micEhSilencioso = false
    ligarMeuDetectorDeFala()
    avisar('Microfone trocado!')
  } catch (_) {
    avisar('Não consegui usar esse microfone. Confira se ele está conectado.', 'erro')
  }
}

// Aplica a saída de som escolhida em tudo que toca áudio
function aplicarSaidaDeSom() {
  const id = prefSaida()
  for (const [, membro] of estado.membros) {
    if (membro.audioEl && membro.audioEl.setSinkId) {
      membro.audioEl.setSinkId(id || '').catch(() => { /* ignora */ })
    }
  }
  for (const [, transmissao] of estado.transmissoes) {
    const video = transmissao.tile.querySelector('video')
    if (video && !transmissao.propria && video.setSinkId) {
      video.setSinkId(id || '').catch(() => { /* ignora */ })
    }
  }
}

// Aplica a nova resolução em uma transmissão que já está no ar
function aplicarResolucaoAoVivo() {
  if (!estado.streamTela) return
  const emHd = prefResolucao() === '720'
  const trilha = estado.streamTela.getVideoTracks()[0]
  if (trilha) {
    trilha.applyConstraints({
      width: { ideal: emHd ? 1280 : 1920 },
      height: { ideal: emHd ? 720 : 1080 }
    }).catch(() => { /* ignora */ })
  }
}

// ============================================================
// ENTRAR / SAIR DA SALA (arrumação geral)
// ============================================================

function entrarNaTelaDaSala() {
  $('texto-codigo').textContent = estado.codigo
  // Só o anfitrião pode criar canais de voz
  $('botao-novo-canal').classList.toggle('escondido', !estado.souAnfitriao)
  trocarParaTela('tela-sala')
  renderizarParticipantes()
}

function sairDaSala(motivo, silencioso = false) {
  estado.saindo = true

  if (estado.pararMeuMonitor) { estado.pararMeuMonitor(); estado.pararMeuMonitor = null }

  if (estado.streamTela) {
    estado.streamTela.getTracks().forEach((t) => { try { t.stop() } catch (_) { /* ignora */ } })
    estado.streamTela = null
  }
  if (estado.streamMic) {
    estado.streamMic.getTracks().forEach((t) => { try { t.stop() } catch (_) { /* ignora */ } })
    estado.streamMic = null
  }

  for (const [id] of estado.membros) {
    const membro = estado.membros.get(id)
    if (membro.audioEl) membro.audioEl.remove()
    if (membro.pararMonitor) membro.pararMonitor()
  }
  estado.membros.clear()
  estado.chamadasTela.clear()

  if (estado.peer) {
    try { estado.peer.destroy() } catch (_) { /* ignora */ }
    estado.peer = null
  }

  estado.conexaoAnfitriao = null
  estado.meuId = null
  estado.focoId = null
  estado.micMudo = false
  estado.souAnfitriao = false
  estado.canais = []
  estado.meuCanal = null
  $('form-novo-canal').classList.add('escondido')
  $('campo-novo-canal').value = ''

  // Tira todos os quadros de transmissão do palco
  for (const id of [...estado.transmissoes.keys()]) removerTransmissao(id, true)

  // Volta o visual ao estado inicial
  $('botao-mic').classList.remove('mudo')
  $('icone-mic-ligado').classList.remove('escondido')
  $('icone-mic-mudo').classList.add('escondido')
  $('botao-tela').classList.remove('transmitindo')
  $('texto-botao-tela').textContent = 'Compartilhar tela'
  $('botao-entrar').disabled = false
  $('botao-criar').disabled = false

  // Limpa o chat para a próxima sala
  estado.historicoChat = []
  estado.naoLidas = 0
  estado.chatAberto = false
  ultimoAutorChat = null
  $('chat-mensagens').innerHTML = ''
  $('campo-chat').value = ''
  $('painel-chat').classList.add('escondido')
  $('botao-chat').classList.remove('ativo')
  atualizarSeloChat()

  renderizarPalco()

  trocarParaTela('tela-lobby')
  if (motivo && !silencioso) avisar(motivo, 'info')
}

// ============================================================
// LIGAÇÕES DOS BOTÕES
// ============================================================

$('botao-criar').addEventListener('click', () => criarSala())
$('botao-entrar').addEventListener('click', () => entrarEmSala())

$('campo-codigo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') entrarEmSala()
})
$('campo-nome').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if ($('campo-codigo').value.trim()) entrarEmSala()
    else criarSala()
  }
})

$('botao-mic').addEventListener('click', alternarMicrofone)
$('botao-tela').addEventListener('click', alternarCompartilhamento)
$('botao-sair').addEventListener('click', () => sairDaSala('Você saiu da sala.'))

// Criação de canal de voz (botão + do anfitrião)
$('botao-novo-canal').addEventListener('click', () => {
  const form = $('form-novo-canal')
  form.classList.toggle('escondido')
  if (!form.classList.contains('escondido')) $('campo-novo-canal').focus()
})
$('campo-novo-canal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    criarCanal($('campo-novo-canal').value)
    $('campo-novo-canal').value = ''
    $('form-novo-canal').classList.add('escondido')
  }
  if (e.key === 'Escape') $('form-novo-canal').classList.add('escondido')
})

$('botao-chat').addEventListener('click', abrirFecharChat)
$('botao-enviar-chat').addEventListener('click', enviarMensagemChat)
$('campo-chat').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enviarMensagemChat()
})

$('chip-codigo').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(estado.codigo)
    avisar('Código copiado! Agora é só mandar para a galera.')
  } catch (_) {
    avisar(`O código da sala é ${estado.codigo}`, 'info')
  }
})

$('aba-telas').addEventListener('click', () => { abaAtual = 'tela'; atualizarAbas(); preencherGradeDeFontes() })
$('aba-janelas').addEventListener('click', () => { abaAtual = 'janela'; atualizarAbas(); preencherGradeDeFontes() })
$('botao-confirmar-fonte').addEventListener('click', confirmarFonte)
$('botao-cancelar-fonte').addEventListener('click', cancelarFonte)

// ---------- configurações ----------

$('botao-config').addEventListener('click', abrirConfiguracoes)
$('botao-config-lobby').addEventListener('click', abrirConfiguracoes)
$('botao-fechar-config').addEventListener('click', fecharConfiguracoes)

$('seletor-mic').addEventListener('change', () => {
  localStorage.setItem('mydisc-mic', $('seletor-mic').value)
  aplicarNovoMicrofone()
})

$('seletor-saida').addEventListener('change', () => {
  localStorage.setItem('mydisc-saida', $('seletor-saida').value)
  aplicarSaidaDeSom()
})

document.querySelectorAll('input[name="resolucao"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return
    localStorage.setItem('mydisc-resolucao', radio.value)
    aplicarResolucaoAoVivo()
  })
})

// Se um aparelho for plugado/desplugado com a janela aberta, atualiza as listas
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!$('modal-config').classList.contains('escondido')) preencherListaDeAparelhos()
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('modal-seletor').classList.contains('escondido')) {
    cancelarFonte()
  } else if (!$('modal-config').classList.contains('escondido')) {
    fecharConfiguracoes()
  }
})

// Botões de troca de layout do palco (aparecem com duas transmissões)
$('layout-dividida').addEventListener('click', () => trocarLayout('dividida'))
$('layout-foco').addEventListener('click', () => trocarLayout('foco'))

// Recadinho quando uma atualização já foi baixada em segundo plano:
// fica na tela até o usuário escolher "Reiniciar agora" ou "Depois"
function avisarAtualizacao(versao) {
  const caixa = document.createElement('div')
  caixa.className = 'toast toast-atualizacao'

  const texto = document.createElement('div')
  texto.textContent = `Nova versão ${versao} pronta! Quer reiniciar agora para atualizar?`
  caixa.appendChild(texto)

  const botoes = document.createElement('div')
  botoes.className = 'toast-botoes'

  const agora = document.createElement('button')
  agora.className = 'botao-toast principal'
  agora.textContent = 'Reiniciar agora'
  agora.addEventListener('click', () => {
    agora.disabled = true
    agora.textContent = 'Reiniciando…'
    window.mydisc.reiniciarParaAtualizar()
  })

  const depois = document.createElement('button')
  depois.className = 'botao-toast'
  depois.textContent = 'Depois'
  depois.addEventListener('click', () => {
    caixa.classList.add('saindo')
    setTimeout(() => caixa.remove(), 350)
    avisar('Sem problema! Ela se instala sozinha quando você sair do JanjaCord.', 'info')
  })

  botoes.appendChild(agora)
  botoes.appendChild(depois)
  caixa.appendChild(botoes)
  $('area-toasts').appendChild(caixa)
}

if (window.mydisc.aoAtualizacaoPronta) {
  window.mydisc.aoAtualizacaoPronta((versao) => avisarAtualizacao(versao))
}

// Lembra o nome usado da última vez
const nomeSalvo = localStorage.getItem('mydisc-nome')
if (nomeSalvo) $('campo-nome').value = nomeSalvo

// Encerra as conexões direitinho ao fechar o aplicativo
window.addEventListener('beforeunload', () => {
  if (estado.peer) { try { estado.peer.destroy() } catch (_) { /* ignora */ } }
})
