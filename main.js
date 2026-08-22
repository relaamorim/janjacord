// JanjaCord — processo principal do Electron
// Este arquivo cria a janela do aplicativo e cuida da parte que só o
// "lado do sistema" pode fazer: listar as telas/janelas disponíveis
// para compartilhamento e entregar a captura escolhida ao aplicativo.

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

const PAGINA_DE_DOWNLOADS = 'https://github.com/relaamorim/janjacord/releases/latest'

let janela = null

// Guarda o "callback" pendente enquanto o usuário escolhe qual tela compartilhar
let pedidoDeCaptura = null

function criarJanela() {
  janela = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0d14',
    autoHideMenuBar: true,
    title: 'JanjaCord',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  janela.loadFile('index.html')

  // Links clicados no chat abrem no navegador padrão, nunca dentro do app
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  janela.webContents.on('will-navigate', (evento, url) => {
    evento.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
  })

  // Repassa mensagens do console da interface para o terminal (ajuda a depurar)
  janela.webContents.on('console-message', (evento, nivel, mensagem) => {
    console.log('[interface]', mensagem)
  })
}

app.whenReady().then(() => {
  // Permite automaticamente o uso de microfone e captura de tela
  // (sem isso, o Chromium bloquearia os pedidos silenciosamente)
  session.defaultSession.setPermissionRequestHandler((webContents, permissao, responder) => {
    const permitidas = ['media', 'display-capture', 'clipboard-sanitized-write']
    responder(permitidas.includes(permissao))
  })

  // Quando a interface pede para compartilhar tela, buscamos as telas e
  // janelas abertas e mandamos para a interface mostrar o seletor bonito.
  session.defaultSession.setDisplayMediaRequestHandler(async (pedido, responder) => {
    try {
      const fontes = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 400, height: 225 },
        fetchWindowIcons: true
      })

      pedidoDeCaptura = { responder, fontes }

      // Envia versões "leves" das fontes (miniatura em imagem) para a interface
      janela.webContents.send('abrir-seletor-fonte', fontes.map((fonte) => ({
        id: fonte.id,
        nome: fonte.name,
        tipo: fonte.id.startsWith('screen') ? 'tela' : 'janela',
        miniatura: fonte.thumbnail.toDataURL(),
        icone: fonte.appIcon && !fonte.appIcon.isEmpty() ? fonte.appIcon.toDataURL() : null
      })))
    } catch (erro) {
      console.error('Erro ao listar telas:', erro)
      try { responder(null) } catch (_) { /* pedido já encerrado */ }
    }
  }, { useSystemPicker: false })

  criarJanela()

  // Espera a janela abrir com calma antes de conferir se há versão nova
  setTimeout(configurarAtualizacoes, 4000)
})

// A interface respondeu qual tela/janela o usuário escolheu (ou null se cancelou)
ipcMain.on('fonte-escolhida', (evento, escolha) => {
  if (!pedidoDeCaptura) return
  const { responder, fontes } = pedidoDeCaptura
  pedidoDeCaptura = null

  if (!escolha) {
    // Usuário cancelou o seletor
    try { responder(null) } catch (_) { /* ignora */ }
    return
  }

  const fonte = fontes.find((f) => f.id === escolha.id)
  if (!fonte) {
    try { responder(null) } catch (_) { /* ignora */ }
    return
  }

  const resposta = { video: fonte }
  // No Windows dá para capturar também o som do computador ("loopback")
  if (escolha.comSom) resposta.audio = 'loopback'

  try { responder(resposta) } catch (erro) {
    console.error('Erro ao entregar a captura:', erro)
  }
})

// ============================================================
// ATUALIZAÇÃO AUTOMÁTICA
// Quem instalou pelo "JanjaCord Setup" recebe as novas versões sozinho:
// o app baixa em segundo plano e instala quando for fechado.
// A versão portátil não consegue se substituir, então ela apenas
// avisa quando existe versão nova e oferece a página de download.
// ============================================================

function configurarAtualizacoes() {
  // Em modo de desenvolvimento (npm start) não há o que atualizar
  if (!app.isPackaged) return

  const ehPortatil = !!process.env.PORTABLE_EXECUTABLE_DIR
  if (ehPortatil) {
    verificarVersaoPortatil()
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    // Avisa a interface para mostrar o recadinho ao usuário
    if (janela && !janela.isDestroyed()) {
      janela.webContents.send('atualizacao-pronta', info.version)
    }
  })

  autoUpdater.on('error', (erro) => {
    // Sem internet ou GitHub fora do ar: falha em silêncio, sem incomodar
    console.log('Atualização adiada:', erro.message)
  })

  autoUpdater.checkForUpdates().catch(() => { /* ignora */ })

  // Confere de novo a cada 4 horas, para quem deixa o app aberto direto
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => { /* ignora */ })
  }, 4 * 60 * 60 * 1000)
}

// A versão portátil só consulta qual é a última versão publicada
async function verificarVersaoPortatil() {
  try {
    const resposta = await fetch('https://api.github.com/repos/relaamorim/janjacord/releases/latest', {
      headers: { 'User-Agent': 'JanjaCord' }
    })
    if (!resposta.ok) return
    const dados = await resposta.json()
    const novaVersao = String(dados.tag_name || '').replace(/^v/, '')

    if (novaVersao && ehVersaoMaisNova(novaVersao, app.getVersion())) {
      const escolha = await dialog.showMessageBox(janela, {
        type: 'info',
        title: 'Atualização disponível',
        message: `Saiu o JanjaCord ${novaVersao}!`,
        detail: 'Você usa a versão portátil, que não se atualiza sozinha. Quer abrir a página para baixar a nova versão?',
        buttons: ['Baixar agora', 'Deixar para depois'],
        defaultId: 0,
        cancelId: 1
      })
      if (escolha.response === 0) shell.openExternal(PAGINA_DE_DOWNLOADS)
    }
  } catch (_) {
    // Sem internet: tenta de novo na próxima vez que abrir
  }
}

// Compara versões tipo "1.2.0": a é mais nova que b?
function ehVersaoMaisNova(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

// Fecha o aplicativo quando todas as janelas forem fechadas
app.on('window-all-closed', () => {
  app.quit()
})
