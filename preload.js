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
