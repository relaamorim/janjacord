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
  chamadasTela: new Map(), // id -> chamada de vídeo que EU iniciei
  compartilhandoId: null,  // id de quem está transmitindo agora (ou null)
  compartilhandoNome: '',
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
    transmitindo: estado.compartilhandoId === estado.meuId,
    propria: true
  }]

  for (const [id, membro] of estado.membros) {
    todos.push({
      id,
      nome: membro.nome,
      nomeCor: membro.nome,
      ehAnfitriao: !!membro.ehAnfitriao,
      mudo: !!membro.mudo,
      transmitindo: estado.compartilhandoId === id,
      propria: false
    })
  }

  for (const pessoa of todos) {
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

    lista.appendChild(item)
  }

  $('contador-pessoas').textContent = String(todos.length)
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
    estado.membros.set(id, { nome: nome || 'Convidado', ehAnfitriao: false, mudo: false })
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
      membro.chamadaVoz = chamada
      chamada.on('stream', (stream) => tocarAudioDe(chamada.peer, stream))
    }

    if (meta.tipo === 'tela') {
      chamada.answer() // só recebo, não envio nada de volta
      chamada.on('stream', (stream) => mostrarTelaRemota(chamada.peer, meta.nome, stream))
      chamada.on('close', () => {
        if (estado.compartilhandoId === chamada.peer) limparPalco()
      })
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
        codigo: estado.codigo,
        membros: [...estado.membros.entries()].map(([id, m]) => ({
          id, nome: m.nome, mudo: !!m.mudo
        })),
        compartilhandoId: estado.compartilhandoId,
        compartilhandoNome: estado.compartilhandoNome,
        historico: estado.historicoChat.slice(-50)
      })

      // Avisa os demais
      enviarParaTodos({ tipo: 'entrou', id: conexao.peer, nome: nomeNovo }, conexao.peer)

      const membro = garantirMembro(conexao.peer, nomeNovo)
      membro.conexaoDados = conexao
      renderizarParticipantes()
      avisar(`${nomeNovo} entrou na sala.`, 'info')
      mensagemSistema(`${nomeNovo} entrou na sala`)

      // Se eu já estava transmitindo a tela, incluo a pessoa nova
      if (estado.streamTela) ligarTelaPara(conexao.peer)
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
    if (mensagem.ativo) {
      estado.compartilhandoId = id
      estado.compartilhandoNome = membro.nome
    } else if (estado.compartilhandoId === id) {
      estado.compartilhandoId = null
      estado.compartilhandoNome = ''
    }
    renderizarParticipantes()
    enviarParaTodos({
      tipo: 'compartilhando', id, nome: membro.nome, ativo: !!mensagem.ativo
    }, id)
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

  if (estado.compartilhandoId === id) limparPalco()

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

    // O anfitrião entra na minha lista
    const idAnfitriao = PREFIXO_SALA + estado.codigo.toLowerCase()
    estado.membros.set(idAnfitriao, {
      nome: mensagem.nomeAnfitriao, ehAnfitriao: true, mudo: false
    })

    // E os outros convidados também
    for (const m of mensagem.membros) {
      estado.membros.set(m.id, { nome: m.nome, ehAnfitriao: false, mudo: !!m.mudo })
    }

    if (mensagem.compartilhandoId) {
      estado.compartilhandoId = mensagem.compartilhandoId
      estado.compartilhandoNome = mensagem.compartilhandoNome
    }

    entrarNaTelaDaSala()
    atualizarStatus('conectado', 'Conectado')
    ligarMeuDetectorDeFala()
    avisar(`Você entrou na sala de ${mensagem.nomeAnfitriao}!`)

    // Mostra as últimas conversas do chat para quem acabou de chegar
    for (const antiga of (mensagem.historico || [])) {
      renderizarMensagemChat(antiga, false, true)
    }

    // EU liguei agora, então EU inicio a chamada de voz com cada um
    for (const [id] of estado.membros) ligarVozPara(id)
    renderizarParticipantes()
    return
  }

  if (mensagem.tipo === 'entrou') {
    garantirMembro(mensagem.id, mensagem.nome)
    avisar(`${mensagem.nome} entrou na sala.`, 'info')
    mensagemSistema(`${mensagem.nome} entrou na sala`)
    renderizarParticipantes()
    // Quem chegou é quem liga para mim — eu só espero.
    // Mas se EU estiver transmitindo a tela, envio para a pessoa nova:
    if (estado.streamTela) ligarTelaPara(mensagem.id)
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
    if (mensagem.ativo) {
      estado.compartilhandoId = mensagem.id
      estado.compartilhandoNome = mensagem.nome
    } else if (estado.compartilhandoId === mensagem.id) {
      limparPalco()
    }
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
  const chamada = estado.peer.call(id, estado.streamMic, {
    metadata: { tipo: 'voz', nome: estado.nome }
  })
  if (!chamada) return
  const membro = garantirMembro(id, null)
  membro.chamadaVoz = chamada
  chamada.on('stream', (stream) => tocarAudioDe(id, stream))
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

async function alternarCompartilhamento() {
  // Já estou transmitindo? Então parar.
  if (estado.streamTela) {
    pararMinhaTela()
    return
  }

  // Outra pessoa está transmitindo?
  if (estado.compartilhandoId && estado.compartilhandoId !== estado.meuId) {
    avisar(`${estado.compartilhandoNome} já está compartilhando. Peça para parar primeiro.`, 'info')
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
    mostrarTelaLocal(stream)

    // Envia a tela para todo mundo que está na sala
    for (const [id] of estado.membros) ligarTelaPara(id)

    // Avisa a sala
    estado.compartilhandoId = estado.meuId
    estado.compartilhandoNome = estado.nome
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

  limparPalco()

  if (estado.souAnfitriao) {
    enviarParaTodos({ tipo: 'compartilhando', id: estado.meuId, nome: estado.nome, ativo: false })
  } else if (estado.conexaoAnfitriao && estado.conexaoAnfitriao.open) {
    estado.conexaoAnfitriao.send({ tipo: 'compartilhando', ativo: false })
  }

  $('botao-tela').classList.remove('transmitindo')
  $('texto-botao-tela').textContent = 'Compartilhar tela'
  renderizarParticipantes()
}

function mostrarTelaLocal(stream) {
  estado.compartilhandoId = estado.meuId
  $('palco-vazio').classList.add('escondido')
  $('palco-video').classList.remove('escondido')
  const video = $('video-tela')
  video.srcObject = stream
  video.muted = true // nunca tocar meu próprio som de volta
  $('texto-compartilhando').textContent = 'Você está compartilhando'
}

function mostrarTelaRemota(id, nome, stream) {
  estado.compartilhandoId = id
  estado.compartilhandoNome = nome || 'Alguém'
  $('palco-vazio').classList.add('escondido')
  $('palco-video').classList.remove('escondido')
  const video = $('video-tela')
  video.srcObject = stream
  video.muted = false // se vier som do sistema, queremos ouvir
  if (prefSaida() && video.setSinkId) {
    video.setSinkId(prefSaida()).catch(() => { /* saída não existe mais: usa a padrão */ })
  }
  $('texto-compartilhando').textContent = `Tela de ${estado.compartilhandoNome}`
  renderizarParticipantes()
}

function limparPalco() {
  estado.compartilhandoId = null
  estado.compartilhandoNome = ''
  const video = $('video-tela')
  video.srcObject = null
  $('palco-video').classList.add('escondido')
  $('palco-vazio').classList.remove('escondido')
  renderizarParticipantes()
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
  const video = $('video-tela')
  if (video.setSinkId) video.setSinkId(id || '').catch(() => { /* ignora */ })
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
  estado.compartilhandoId = null
  estado.compartilhandoNome = ''
  estado.micMudo = false
  estado.souAnfitriao = false

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

  limparPalco()

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

// Tela cheia com dois cliques no vídeo
$('video-tela').addEventListener('dblclick', () => {
  const video = $('video-tela')
  if (document.fullscreenElement) document.exitFullscreen()
  else video.requestFullscreen().catch(() => { /* ignora */ })
})

// Recadinho quando uma atualização já foi baixada em segundo plano
if (window.mydisc.aoAtualizacaoPronta) {
  window.mydisc.aoAtualizacaoPronta((versao) => {
    avisar(`Nova versão ${versao} baixada! Ela será instalada quando você fechar o JanjaCord.`, 'info')
  })
}

// Lembra o nome usado da última vez
const nomeSalvo = localStorage.getItem('mydisc-nome')
if (nomeSalvo) $('campo-nome').value = nomeSalvo

// Encerra as conexões direitinho ao fechar o aplicativo
window.addEventListener('beforeunload', () => {
  if (estado.peer) { try { estado.peer.destroy() } catch (_) { /* ignora */ } }
})
