// ============================================================
// janjacord-audio — captura o som de UM aplicativo do Windows
//
// Usa a API "process loopback" do Windows (10 versão 2004+ e 11), a mesma
// que o Discord e o OBS usam, para pegar só o áudio de um processo (e dos
// processos filhos dele) e escrever PCM cru na saída padrão:
// 48 kHz, 2 canais, 16 bits, intercalado (esquerda, direita, esquerda...).
//
// Uso:
//   janjacord-audio.exe --hwnd <número da janela>   (o programa descobre o processo)
//   janjacord-audio.exe --pid <número do processo>
//   opcionais: --segundos <n> (para após n segundos)  --saida <arquivo> (grava em vez de stdout)
//
// Compilado com o compilador C# que já vem no Windows (csc.exe, .NET Framework 4).
// ============================================================

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace JanjaCordAudio
{
  // Formato de áudio pedido ao Windows (WAVEFORMATEX)
  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  struct WaveFormatEx
  {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  // ---- Interfaces COM do Windows (ordem dos métodos = ordem da tabela virtual) ----

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient
  {
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WaveFormatEx format, IntPtr audioSessionGuid);
    [PreserveSig] int GetBufferSize(out uint bufferFrames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, ref WaveFormatEx format, IntPtr closestMatch);
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
  }

  class Programa
  {
    const short VT_BLOB = 65;
    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int PROCESS_LOOPBACK_ACTIVATION = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    const int INCLUIR_ARVORE_DO_PROCESSO = 0;    // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE

    static int Falhar(string mensagem, int codigo)
    {
      Console.Error.WriteLine("ERRO: " + mensagem);
      return codigo;
    }

    [MTAThread]
    static int Main(string[] args)
    {
      uint pid = 0;
      long hwnd = 0;
      int segundos = 0;
      string arquivoSaida = null;

      for (int i = 0; i + 1 < args.Length; i += 2)
      {
        switch (args[i])
        {
          case "--pid": pid = uint.Parse(args[i + 1]); break;
          case "--hwnd": hwnd = long.Parse(args[i + 1]); break;
          case "--segundos": segundos = int.Parse(args[i + 1]); break;
          case "--saida": arquivoSaida = args[i + 1]; break;
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

      WaveFormatEx formato = new WaveFormatEx();
      formato.wFormatTag = 1; // PCM
      formato.nChannels = 2;
      formato.nSamplesPerSec = 48000;
      formato.wBitsPerSample = 16;
      formato.nBlockAlign = 4;
      formato.nAvgBytesPerSec = 192000;
      formato.cbSize = 0;

      hr = cliente.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, ref formato, IntPtr.Zero);
      if (hr != 0) return Falhar("Initialize devolveu 0x" + hr.ToString("X8"), 6);

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

      Stream destino = arquivoSaida != null ? (Stream)File.Create(arquivoSaida) : Console.OpenStandardOutput();
      DateTime fim = segundos > 0 ? DateTime.UtcNow.AddSeconds(segundos) : DateTime.MaxValue;
      byte[] buffer = new byte[192000];

      while (DateTime.UtcNow < fim)
      {
        Nativo.WaitForSingleObject(evento, 500);

        uint pacote;
        while (captura.GetNextPacketSize(out pacote) == 0 && pacote > 0)
        {
          IntPtr dados;
          uint quadros, sinais;
          ulong posicao, relogio;
          if (captura.GetBuffer(out dados, out quadros, out sinais, out posicao, out relogio) != 0) break;

          int bytes = (int)quadros * 4;
          if (bytes > buffer.Length) buffer = new byte[bytes];
          if ((sinais & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buffer, 0, bytes);
          else Marshal.Copy(dados, buffer, 0, bytes);

          try { destino.Write(buffer, 0, bytes); }
          catch { cliente.Stop(); return 0; } // quem lia o áudio fechou: encerra em silêncio

          captura.ReleaseBuffer(quadros);
        }
        try { destino.Flush(); } catch { cliente.Stop(); return 0; }
      }

      cliente.Stop();
      destino.Flush();
      return 0;
    }
  }
}
