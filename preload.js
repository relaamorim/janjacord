// JanjaCord — ponte segura entre a interface e o processo principal
// Expõe apenas as duas funções que a interface precisa, nada mais.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mydisc', {
  // A interface registra aqui a função que abre o seletor de tela/janela
  aoAbrirSeletorFonte: (funcao) => {
    ipcRenderer.on('abrir-seletor-fonte', (evento, fontes) => funcao(fontes))
  },

  // A interface responde qual fonte foi escolhida ({ id, comSom }) ou null
  responderFonte: (escolha) => {
    ipcRenderer.send('fonte-escolhida', escolha)
  },

  // Pede para repetir a última tela escolhida, agora sem o som do sistema
  repetirFonteSemSom: () => {
    ipcRenderer.send('repetir-fonte-sem-som')
  },

  // Avisa a interface que o som do sistema não pôde ser incluído
  aoSomIndisponivel: (funcao) => {
    ipcRenderer.on('som-do-sistema-indisponivel', () => funcao())
  },

  // Som de um aplicativo específico (programa nativo bin/janjacord-audio.exe)
  iniciarSomDoApp: (alvo) => {
    ipcRenderer.send('som-app-iniciar', alvo)
  },
  pararSomDoApp: () => {
    ipcRenderer.send('som-app-parar')
  },
  aoDadosSomApp: (funcao) => {
    ipcRenderer.on('som-app-dados', (evento, pedaco) => funcao(pedaco))
  },
  aoSomAppEncerrado: (funcao) => {
    ipcRenderer.on('som-app-encerrado', (evento, motivo) => funcao(motivo))
  },

  // Avisa a interface quando uma versão nova foi encontrada (download começou)
  aoAtualizacaoBaixando: (funcao) => {
    ipcRenderer.on('atualizacao-baixando', (evento, versao) => funcao(versao))
  },

  // Progresso do download da atualização (0 a 100)
  aoAtualizacaoProgresso: (funcao) => {
    ipcRenderer.on('atualizacao-progresso', (evento, porcento) => funcao(porcento))
  },

  // Avisa a interface quando uma atualização terminou de ser baixada
  aoAtualizacaoPronta: (funcao) => {
    ipcRenderer.on('atualizacao-pronta', (evento, versao) => funcao(versao))
  },

  // O usuário clicou em "Reiniciar agora": instala a nova versão já
  reiniciarParaAtualizar: () => {
    ipcRenderer.send('reiniciar-para-atualizar')
  }
})
