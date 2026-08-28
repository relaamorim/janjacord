// ============================================================
// janjacord-audio — captura o som de UM aplicativo do Windows
//
// Usa a API "process loopback" do Windows (10 versão 2004+ e 11), a mesma
// que o Discord e o OBS usam, para pegar só o áudio de um processo (e dos
// processos filhos dele) e escrever PCM cru na saída padrão:
// 48 kHz, 2 canais, 16 bits, intercalado (esquerda, direita, esquerda...).
//
// Por que capturamos em TODOS os canais do dispositivo e reduzimos para
// estéreo nós mesmos: em placas/headsets "7.1" (8 canais), quando se pede
// a captura já em estéreo o Windows aplica um fator de normalização
// (~0,21, ou -13,5 dB) na redução 8→2 e o som chega baixíssimo. Fazendo a
// redução aqui, o nível fica igual ao do aplicativo.
//
// Também compensamos o volume do aplicativo no Mixer do Windows (a captura
// vem DEPOIS desse volume), usando o volume da sessão de áudio, para que a
// transmissão saia no nível real do jogo, e não no volume local do usuário.
//
// Uso:
//   janjacord-audio.exe --hwnd <número da janela>   (o programa descobre o processo)
//   janjacord-audio.exe --pid <número do processo>
//   opcionais: --segundos <n> (para após n segundos)  --saida <arquivo> (grava em vez de stdout)
//              --depurar (imprime níveis por canal e o ganho aplicado, a cada segundo)
//
// Mensagens na saída de erro (stderr), lidas pelo JanjaCord:
//   PRONTO            captura começou
//   AVISO: <texto>    algo que o usuário deveria saber (ex.: app mudo no Mixer)
//   ERRO: <texto>     não deu para capturar (o programa sai com código ≠ 0)
//
// Compilado com o compilador C# que já vem no Windows (csc.exe, .NET Framework 4).
// ============================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace JanjaCordAudio
{
  // ---- Interfaces COM do Windows (ordem dos métodos = ordem da tabela virtual) ----

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient
  {
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
    [PreserveSig] int GetBufferSize(out uint bufferFrames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr eventHandle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient
  {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint numFrames);
    [PreserveSig] int GetNextPacketSize(out uint numFrames);
  }

  [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceAsyncOperation
  {
    [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
  }

  [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceCompletionHandler
  {
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
  }

  // Carimbo exigido pelo Windows: o objeto pode ser chamado de qualquer thread
  [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAgileObject { }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice
  {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator
  {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume
  {
    [PreserveSig] int SetMasterVolume(float nivel, ref Guid contexto);
    [PreserveSig] int GetMasterVolume(out float nivel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mudo, ref Guid contexto);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mudo);
  }

  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2
  {
    // IAudioSessionControl
    [PreserveSig] int GetState(out int estado);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string nome);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string nome, ref Guid contexto);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string caminho);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string caminho, ref Guid contexto);
    [PreserveSig] int GetGroupingParam(out Guid grupo);
    [PreserveSig] int SetGroupingParam(ref Guid grupo, ref Guid contexto);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    // IAudioSessionControl2
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool naoAbaixar);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator
  {
    [PreserveSig] int GetCount(out int total);
    [PreserveSig] int GetSession(int indice, [MarshalAs(UnmanagedType.IUnknown)] out object sessao);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2
  {
    // IAudioSessionManager
    [PreserveSig] int GetAudioSessionControl(ref Guid sessao, uint flags, [MarshalAs(UnmanagedType.IUnknown)] out object controle);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid sessao, uint flags, [MarshalAs(UnmanagedType.IUnknown)] out object volume);
    // IAudioSessionManager2
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerador);
  }

  // Recebe o aviso do Windows de que a ativação terminou
  [ComVisible(true)]
  class Concluidor : IActivateAudioInterfaceCompletionHandler, IAgileObject
  {
    public readonly ManualResetEvent Pronto = new ManualResetEvent(false);
    public int Resultado = 0;
    public object Interface = null;

    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operacao)
    {
      int hr;
      object obj;
      int hr2 = operacao.GetActivateResult(out hr, out obj);
      Resultado = (hr2 != 0) ? hr2 : hr;
      Interface = obj;
      Pronto.Set();
      return 0;
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessEntry32
  {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  static class Nativo
  {
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int ActivateAudioInterfaceAsync(
      [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
      ref Guid riid,
      IntPtr activationParams,
      IActivateAudioInterfaceCompletionHandler completionHandler,
      out IActivateAudioInterfaceAsyncOperation activationOperation);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);

    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr ptr);
  }

  // Descreve o formato que o Windows nos entrega (lido do WAVEFORMATEX/EXTENSIBLE)
  class FormatoDeAudio
  {
    public int Canais;
    public int Taxa;
    public int Bits;
    public uint Mascara;   // quais alto-falantes (0 = desconhecido)
    public bool EhFloat;
    public IntPtr Ponteiro; // cópia do formato para passar ao Initialize
  }

  class Programa
  {
    const short VT_BLOB = 65;
    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int PROCESS_LOOPBACK_ACTIVATION = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    const int INCLUIR_ARVORE_DO_PROCESSO = 0;    // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    const int TAXA_SAIDA = 48000;
    const float GANHO_MAXIMO = 10f;              // compensação do Mixer limitada a +20 dB

    static readonly Guid SUBFORMATO_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
    static readonly Guid SUBFORMATO_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");

    static bool depurar = false;

    static int Falhar(string mensagem, int codigo)
    {
      Console.Error.WriteLine("ERRO: " + mensagem);
      return codigo;
    }

    static void Avisar(string mensagem)
    {
      Console.Error.WriteLine("AVISO: " + mensagem);
    }

    // ---- Formato: lê o formato de mixagem do dispositivo padrão e prepara o nosso pedido ----

    static FormatoDeAudio LerFormato(IntPtr p)
    {
      var f = new FormatoDeAudio();
      int tag = Marshal.ReadInt16(p, 0) & 0xFFFF;
      f.Canais = Marshal.ReadInt16(p, 2);
      f.Taxa = Marshal.ReadInt32(p, 4);
      f.Bits = Marshal.ReadInt16(p, 14);
      int cbSize = Marshal.ReadInt16(p, 16);
      if (tag == 0xFFFE && cbSize >= 22)
      {
        f.Mascara = (uint)Marshal.ReadInt32(p, 20);
        byte[] guid = new byte[16];
        Marshal.Copy(new IntPtr(p.ToInt64() + 24), guid, 0, 16);
        f.EhFloat = new Guid(guid) == SUBFORMATO_FLOAT;
      }
      else
      {
        f.EhFloat = tag == 3;
      }
      return f;
    }

    // Monta um WAVEFORMATEXTENSIBLE float 32 bits com N canais na taxa pedida
    static FormatoDeAudio MontarFormatoFloat(int canais, int taxa, uint mascara)
    {
      var f = new FormatoDeAudio();
      f.Canais = canais; f.Taxa = taxa; f.Bits = 32; f.Mascara = mascara; f.EhFloat = true;
      f.Ponteiro = Marshal.AllocHGlobal(40);
      for (int i = 0; i < 40; i++) Marshal.WriteByte(f.Ponteiro, i, 0);
      Marshal.WriteInt16(f.Ponteiro, 0, unchecked((short)0xFFFE));   // WAVE_FORMAT_EXTENSIBLE
      Marshal.WriteInt16(f.Ponteiro, 2, (short)canais);
      Marshal.WriteInt32(f.Ponteiro, 4, taxa);
      Marshal.WriteInt32(f.Ponteiro, 8, taxa * canais * 4);           // bytes por segundo
      Marshal.WriteInt16(f.Ponteiro, 12, (short)(canais * 4));        // bytes por quadro
      Marshal.WriteInt16(f.Ponteiro, 14, 32);                         // bits por amostra
      Marshal.WriteInt16(f.Ponteiro, 16, 22);                         // cbSize
      Marshal.WriteInt16(f.Ponteiro, 18, 32);                         // bits válidos
      Marshal.WriteInt32(f.Ponteiro, 20, (int)mascara);
      Marshal.Copy(SUBFORMATO_FLOAT.ToByteArray(), 0, new IntPtr(f.Ponteiro.ToInt64() + 24), 16);
      return f;
    }

    // Formato simples de reserva: PCM 16 bits, 2 canais, 48 kHz (o que a versão 1.12 usava)
    static FormatoDeAudio MontarFormatoPcmEstereo()
    {
      var f = new FormatoDeAudio();
      f.Canais = 2; f.Taxa = TAXA_SAIDA; f.Bits = 16; f.Mascara = 0x3; f.EhFloat = false;
      f.Ponteiro = Marshal.AllocHGlobal(18);
      Marshal.WriteInt16(f.Ponteiro, 0, 1);
      Marshal.WriteInt16(f.Ponteiro, 2, 2);
      Marshal.WriteInt32(f.Ponteiro, 4, TAXA_SAIDA);
      Marshal.WriteInt32(f.Ponteiro, 8, TAXA_SAIDA * 4);
      Marshal.WriteInt16(f.Ponteiro, 12, 4);
      Marshal.WriteInt16(f.Ponteiro, 14, 16);
      Marshal.WriteInt16(f.Ponteiro, 16, 0);
      return f;
    }

    static IMMDevice DispositivoPadrao()
    {
      var enumerador = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice dispositivo;
      int hr = enumerador.GetDefaultAudioEndpoint(0 /* saída */, 0 /* console */, out dispositivo);
      if (hr != 0) throw new COMException("GetDefaultAudioEndpoint", hr);
      return dispositivo;
    }

    static FormatoDeAudio FormatoDeMixagemDoDispositivo()
    {
      try
      {
        object obj;
        Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        if (DispositivoPadrao().Activate(ref iid, 23, IntPtr.Zero, out obj) != 0) return null;
        IntPtr p;
        if (((IAudioClient)obj).GetMixFormat(out p) != 0) return null;
        var f = LerFormato(p);
        Nativo.CoTaskMemFree(p);
        return f;
      }
      catch { return null; }
    }

    // ---- Redução de canais para estéreo (coeficientes clássicos, sem normalização) ----

    static void MontarCoeficientes(FormatoDeAudio f, out float[] paraEsquerda, out float[] paraDireita)
    {
      paraEsquerda = new float[f.Canais];
      paraDireita = new float[f.Canais];
      uint mascara = f.Mascara;
      if (mascara == 0)
      {
        // Sem mapa de alto-falantes: assume os dois primeiros como esquerda/direita
        if (f.Canais >= 1) paraEsquerda[0] = 1f;
        if (f.Canais >= 2) paraDireita[1] = 1f; else paraDireita[0] = 1f;
        return;
      }
      int indice = 0;
      for (int bit = 0; bit < 18 && indice < f.Canais; bit++)
      {
        if ((mascara & (1u << bit)) == 0) continue;
        float e = 0f, d = 0f;
        switch (bit)
        {
          case 0: e = 1f; break;              // frente esquerda
          case 1: d = 1f; break;              // frente direita
          case 2: e = 0.707f; d = 0.707f; break; // centro
          case 3: break;                      // grave (LFE): fica de fora, como no padrão ITU
          case 4: e = 0.707f; break;          // traseira esquerda
          case 5: d = 0.707f; break;          // traseira direita
          case 6: e = 0.707f; break;          // frente esquerda-centro
          case 7: d = 0.707f; break;          // frente direita-centro
          case 8: e = 0.5f; d = 0.5f; break;  // traseira centro
          case 9: e = 0.707f; break;          // lateral esquerda
          case 10: d = 0.707f; break;         // lateral direita
          default: break;                     // canais de altura etc.: ignorados
        }
        paraEsquerda[indice] = e;
        paraDireita[indice] = d;
        indice++;
      }
    }

    // ---- Árvore de processos e volume da sessão no Mixer ----

    static Dictionary<uint, uint> MapaDePais()
    {
      var mapa = new Dictionary<uint, uint>();
      IntPtr foto = Nativo.CreateToolhelp32Snapshot(2 /* processos */, 0);
      if (foto == IntPtr.Zero || foto.ToInt64() == -1) return mapa;
      var entrada = new ProcessEntry32();
      entrada.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
      if (Nativo.Process32FirstW(foto, ref entrada))
      {
        do { mapa[entrada.th32ProcessID] = entrada.th32ParentProcessID; }
        while (Nativo.Process32NextW(foto, ref entrada));
      }
      Nativo.CloseHandle(foto);
      return mapa;
    }

    static bool EstaNaArvore(uint pid, uint alvo, Dictionary<uint, uint> pais)
    {
      for (int passos = 0; passos < 64 && pid != 0; passos++)
      {
        if (pid == alvo) return true;
        uint pai;
        if (!pais.TryGetValue(pid, out pai) || pai == pid) return false;
        pid = pai;
      }
      return false;
    }

    // Devolve o volume (0 a 1) da sessão ativa do aplicativo no Mixer; -1 se não achou; 0 se mudo
    static float VolumeDoAppNoMixer(uint alvo)
    {
      try
      {
        object gerenteObj;
        Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        if (DispositivoPadrao().Activate(ref iid, 23, IntPtr.Zero, out gerenteObj) != 0) return -1f;
        IAudioSessionEnumerator lista;
        if (((IAudioSessionManager2)gerenteObj).GetSessionEnumerator(out lista) != 0) return -1f;
        int total; lista.GetCount(out total);
        var pais = MapaDePais();
        float melhor = -1f;
        for (int i = 0; i < total; i++)
        {
          object sessao;
          if (lista.GetSession(i, out sessao) != 0) continue;
          var controle = (IAudioSessionControl2)sessao;
          uint pid; controle.GetProcessId(out pid);
          if (pid == 0 || !EstaNaArvore(pid, alvo, pais)) continue;
          int estado; controle.GetState(out estado);
          if (estado != 1) continue; // só sessões tocando agora
          float nivel; bool mudo;
          var volume = (ISimpleAudioVolume)sessao;
          volume.GetMasterVolume(out nivel);
          volume.GetMute(out mudo);
          float efetivo = mudo ? 0f : nivel;
          if (efetivo > melhor) melhor = efetivo;
        }
        return melhor;
      }
      catch { return -1f; }
    }

    [MTAThread]
    static int Main(string[] args)
    {
      uint pid = 0;
      long hwnd = 0;
      int segundos = 0;
      string arquivoSaida = null;

      for (int i = 0; i < args.Length; i++)
      {
        switch (args[i])
        {
          case "--pid": pid = uint.Parse(args[++i]); break;
          case "--hwnd": hwnd = long.Parse(args[++i]); break;
          case "--segundos": segundos = int.Parse(args[++i]); break;
          case "--saida": arquivoSaida = args[++i]; break;
          case "--depurar": depurar = true; break;
        }
      }

      if (pid == 0 && hwnd != 0)
      {
        uint encontrado;
        Nativo.GetWindowThreadProcessId(new IntPtr(hwnd), out encontrado);
        pid = encontrado;
      }
      if (pid == 0) return Falhar("informe --hwnd <janela> ou --pid <processo>", 2);

      Console.Error.WriteLine("Capturando o som do processo " + pid);

      // Parâmetros de ativação: AUDIOCLIENT_ACTIVATION_PARAMS (tipo, pid, modo)
      IntPtr parametros = Marshal.AllocHGlobal(12);
      Marshal.WriteInt32(parametros, 0, PROCESS_LOOPBACK_ACTIVATION);
      Marshal.WriteInt32(parametros, 4, (int)pid);
      Marshal.WriteInt32(parametros, 8, INCLUIR_ARVORE_DO_PROCESSO);

      // Embrulhados num PROPVARIANT do tipo BLOB (24 bytes em 64 bits)
      IntPtr propvariant = Marshal.AllocHGlobal(24);
      for (int i = 0; i < 24; i++) Marshal.WriteByte(propvariant, i, 0);
      Marshal.WriteInt16(propvariant, 0, VT_BLOB);
      Marshal.WriteInt32(propvariant, 8, 12);
      Marshal.WriteIntPtr(propvariant, 16, parametros);

      Guid iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
      Concluidor concluidor = new Concluidor();
      IActivateAudioInterfaceAsyncOperation operacao;

      int hr = Nativo.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iidAudioClient, propvariant, concluidor, out operacao);
      if (hr != 0) return Falhar("ActivateAudioInterfaceAsync devolveu 0x" + hr.ToString("X8") + " (Windows antigo demais?)", 3);
      if (!concluidor.Pronto.WaitOne(5000)) return Falhar("o Windows não respondeu à ativação do áudio", 4);
      if (concluidor.Resultado != 0 || concluidor.Interface == null)
        return Falhar("ativação recusada: 0x" + concluidor.Resultado.ToString("X8"), 5);

      IAudioClient cliente = (IAudioClient)concluidor.Interface;

      // Escolha do formato de captura: todos os canais do dispositivo, em float, a 48 kHz.
      // Se o Windows recusar, tenta o formato de mixagem exato; por último, estéreo 16 bits.
      FormatoDeAudio mix = FormatoDeMixagemDoDispositivo();
      var tentativas = new List<FormatoDeAudio>();
      if (mix != null && mix.Canais >= 1 && mix.Canais <= 18)
      {
        tentativas.Add(MontarFormatoFloat(mix.Canais, TAXA_SAIDA, mix.Mascara));
        if (mix.Taxa != TAXA_SAIDA) tentativas.Add(MontarFormatoFloat(mix.Canais, mix.Taxa, mix.Mascara));
      }
      tentativas.Add(MontarFormatoPcmEstereo());

      FormatoDeAudio formato = null;
      foreach (var tentativa in tentativas)
      {
        hr = cliente.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, tentativa.Ponteiro, IntPtr.Zero);
        if (hr == 0) { formato = tentativa; break; }
        if (depurar) Console.Error.WriteLine("formato " + tentativa.Canais + " canais/" + tentativa.Taxa + " Hz recusado: 0x" + hr.ToString("X8"));
      }
      if (formato == null) return Falhar("Initialize devolveu 0x" + hr.ToString("X8"), 6);
      Console.Error.WriteLine("Formato de captura: " + formato.Canais + " canais, " + formato.Taxa + " Hz, " + (formato.EhFloat ? "float" : "16 bits")
        + (mix != null ? " (dispositivo: " + mix.Canais + " canais, " + mix.Taxa + " Hz)" : ""));

      IntPtr evento = Nativo.CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
      cliente.SetEventHandle(evento);

      Guid iidCaptura = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
      object servico;
      hr = cliente.GetService(ref iidCaptura, out servico);
      if (hr != 0 || servico == null) return Falhar("GetService devolveu 0x" + hr.ToString("X8"), 7);
      IAudioCaptureClient captura = (IAudioCaptureClient)servico;

      hr = cliente.Start();
      if (hr != 0) return Falhar("Start devolveu 0x" + hr.ToString("X8"), 8);
      Console.Error.WriteLine("PRONTO");

      float[] paraEsquerda, paraDireita;
      MontarCoeficientes(formato, out paraEsquerda, out paraDireita);

      Stream destino = arquivoSaida != null ? (Stream)File.Create(arquivoSaida) : Console.OpenStandardOutput();
      DateTime fim = segundos > 0 ? DateTime.UtcNow.AddSeconds(segundos) : DateTime.MaxValue;

      int bytesPorQuadro = formato.Canais * (formato.Bits / 8);
      float[] entrada = new float[formato.Canais * 4800];
      byte[] brutos = new byte[bytesPorQuadro * 4800];
      float[] estereo = new float[2 * 4800];
      byte[] saida = new byte[4 * 9600];

      // Reamostragem (só se o Windows não aceitou 48 kHz): interpolação linear simples
      bool reamostrar = formato.Taxa != TAXA_SAIDA;
      double passo = (double)formato.Taxa / TAXA_SAIDA;
      double posicao = 0;
      float ultimoE = 0f, ultimoD = 0f;

      // Compensação do volume do Mixer, renovada a cada segundo
      float ganho = 1f;
      DateTime proximaLeituraDeVolume = DateTime.MinValue;
      bool avisouMudo = false;
      float[] picos = new float[formato.Canais];
      DateTime proximoRelatorio = DateTime.UtcNow.AddSeconds(1);

      while (DateTime.UtcNow < fim)
      {
        Nativo.WaitForSingleObject(evento, 500);

        if (DateTime.UtcNow >= proximaLeituraDeVolume)
        {
          proximaLeituraDeVolume = DateTime.UtcNow.AddSeconds(1);
          float volume = VolumeDoAppNoMixer(pid);
          if (volume < 0f) ganho = 1f;                         // não achou sessão: não mexe
          else if (volume < 0.001f)
          {
            ganho = 1f;
            if (!avisouMudo) { avisouMudo = true; Avisar("o aplicativo está MUDO no Mixer de volume do Windows — não há som para transmitir"); }
          }
          else
          {
            ganho = Math.Min(GANHO_MAXIMO, 1f / volume);
            if (volume < 0.05f && !avisouMudo) { avisouMudo = true; Avisar("o volume do aplicativo está muito baixo no Mixer do Windows (" + Math.Round(volume * 100) + "%) — o som transmitido pode sair baixo"); }
          }
        }

        uint pacote;
        while (captura.GetNextPacketSize(out pacote) == 0 && pacote > 0)
        {
          IntPtr dados;
          uint quadros, sinais;
          ulong posicaoDisp, relogio;
          if (captura.GetBuffer(out dados, out quadros, out sinais, out posicaoDisp, out relogio) != 0) break;

          int q = (int)quadros;
          if (entrada.Length < q * formato.Canais) entrada = new float[q * formato.Canais];
          if (brutos.Length < q * bytesPorQuadro) brutos = new byte[q * bytesPorQuadro];
          if (estereo.Length < 2 * q) estereo = new float[2 * q];

          bool silencio = (sinais & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
          if (silencio)
          {
            Array.Clear(entrada, 0, q * formato.Canais);
          }
          else if (formato.EhFloat)
          {
            Marshal.Copy(dados, entrada, 0, q * formato.Canais);
          }
          else
          {
            // 16 bits → float
            Marshal.Copy(dados, brutos, 0, q * bytesPorQuadro);
            for (int i = 0; i < q * formato.Canais; i++)
              entrada[i] = BitConverter.ToInt16(brutos, 2 * i) / 32768f;
          }
          captura.ReleaseBuffer(quadros);

          // Redução para estéreo + ganho
          for (int i = 0; i < q; i++)
          {
            float e = 0f, d = 0f;
            int baseIdx = i * formato.Canais;
            for (int c = 0; c < formato.Canais; c++)
            {
              float v = entrada[baseIdx + c];
              e += v * paraEsquerda[c];
              d += v * paraDireita[c];
              if (depurar) { float a = Math.Abs(v); if (a > picos[c]) picos[c] = a; }
            }
            estereo[2 * i] = e * ganho;
            estereo[2 * i + 1] = d * ganho;
          }

          // Converte para 16 bits (reamostrando se preciso) e escreve
          int quadrosSaida = 0;
          if (!reamostrar)
          {
            quadrosSaida = q;
            if (saida.Length < 4 * quadrosSaida) saida = new byte[4 * quadrosSaida];
            for (int i = 0; i < 2 * q; i++) EscreverAmostra(saida, 2 * i, estereo[i]);
          }
          else
          {
            int maximo = (int)(q / passo) + 2;
            if (saida.Length < 4 * maximo) saida = new byte[4 * maximo];
            // 'posicao' anda em quadros de entrada; a cada passo gera um quadro de saída
            while (posicao < q)
            {
              int i0 = (int)Math.Floor(posicao);
              float fr = (float)(posicao - i0);
              float e0 = i0 - 1 >= 0 ? estereo[2 * (i0 - 1)] : ultimoE;
              float d0 = i0 - 1 >= 0 ? estereo[2 * (i0 - 1) + 1] : ultimoD;
              float e1 = estereo[2 * i0], d1 = estereo[2 * i0 + 1];
              EscreverAmostra(saida, 4 * quadrosSaida, e0 + (e1 - e0) * fr);
              EscreverAmostra(saida, 4 * quadrosSaida + 2, d0 + (d1 - d0) * fr);
              quadrosSaida++;
              posicao += passo;
            }
            posicao -= q;
            ultimoE = estereo[2 * (q - 1)];
            ultimoD = estereo[2 * (q - 1) + 1];
          }

          try { destino.Write(saida, 0, 4 * quadrosSaida); }
          catch { cliente.Stop(); return 0; } // quem lia o áudio fechou: encerra em silêncio
        }
        try { destino.Flush(); } catch { cliente.Stop(); return 0; }

        if (depurar && DateTime.UtcNow >= proximoRelatorio)
        {
          proximoRelatorio = DateTime.UtcNow.AddSeconds(1);
          var texto = "picos por canal:";
          for (int c = 0; c < formato.Canais; c++) { texto += " " + picos[c].ToString("0.000"); picos[c] = 0f; }
          Console.Error.WriteLine(texto + " | ganho do Mixer: x" + ganho.ToString("0.00"));
        }
      }

      cliente.Stop();
      destino.Flush();
      return 0;
    }

    // Grava uma amostra float (-1..1) como 16 bits little-endian, cortando o que passar do limite
    static void EscreverAmostra(byte[] destino, int posicao, float valor)
    {
      if (valor > 1f) valor = 1f; else if (valor < -1f) valor = -1f;
      short s = (short)Math.Round(valor * 32767f);
      destino[posicao] = (byte)(s & 0xFF);
      destino[posicao + 1] = (byte)((s >> 8) & 0xFF);
    }
  }
}
