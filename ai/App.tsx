
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Blob } from '@google/genai';
import { Waveform } from './components/Waveform';
import { ConnectionStatus, Message, VOICES } from './types';

// Extend window for AI Studio helpers
// Define the AIStudio interface explicitly to resolve naming conflicts with existing global declarations.
interface AIStudio {
  hasSelectedApiKey: () => Promise<boolean>;
  openSelectKey: () => Promise<void>;
}

declare global {
  interface Window {
    aistudio: AIStudio;
  }
}

// Helper for Base64 Decoding
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Helper for Base64 Encoding
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper to decode raw PCM to AudioBuffer
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0].id);
  const [isListening, setIsListening] = useState(false);
  const [isAssistantTalking, setIsAssistantTalking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs for audio processing
  const audioContextRef = useRef<{
    input: AudioContext;
    output: AudioContext;
  } | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptRef = useRef<{ user: string; assistant: string }>({ user: '', assistant: '' });

  // Initialize Audio Contexts
  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = {
        input: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 }),
        output: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 }),
      };
    }
    // Browser autoplay policy fix
    await audioContextRef.current.input.resume();
    await audioContextRef.current.output.resume();
    return audioContextRef.current;
  };

  const createBlob = (data: Float32Array): Blob => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      int16[i] = data[i] * 32768;
    }
    return {
      data: encode(new Uint8Array(int16.buffer)),
      mimeType: 'audio/pcm;rate=16000',
    };
  };

  const handleKeySelection = async () => {
    if (typeof window.aistudio !== 'undefined') {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        return true; // Proceed assuming selection success
      }
    }
    return true;
  };

  const connect = async () => {
    try {
      setStatus('connecting');
      setErrorMessage(null);

      // 1. Ensure API Key is ready
      await handleKeySelection();

      // 2. Setup Audio
      const { input: inputCtx, output: outputCtx } = await ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // 3. Initialize AI Client right before connection to ensure current API Key is used
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus('connected');
            setIsListening(true);
            
            // Start streaming from mic
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              // Use sessionPromise from closure to avoid stale refs and ensure correct connection state
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              transcriptRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptRef.current.assistant += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (transcriptRef.current.user || transcriptRef.current.assistant) {
                const newMessages: Message[] = [];
                if (transcriptRef.current.user) {
                  newMessages.push({ role: 'user', text: transcriptRef.current.user, timestamp: Date.now() });
                }
                if (transcriptRef.current.assistant) {
                  newMessages.push({ role: 'assistant', text: transcriptRef.current.assistant, timestamp: Date.now() + 1 });
                }
                setMessages(prev => [...prev, ...newMessages]);
                transcriptRef.current = { user: '', assistant: '' };
              }
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsAssistantTalking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const sourceNode = outputCtx.createBufferSource();
              sourceNode.buffer = buffer;
              const gain = outputCtx.createGain();
              sourceNode.connect(gain);
              gain.connect(outputCtx.destination);
              
              sourceNode.addEventListener('ended', () => {
                sourcesRef.current.delete(sourceNode);
                if (sourcesRef.current.size === 0) {
                  setIsAssistantTalking(false);
                }
              });

              sourceNode.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(sourceNode);
            }

            if (message.serverContent?.interrupted) {
              for (const s of sourcesRef.current.values()) {
                try { s.stop(); } catch(e) {}
              }
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAssistantTalking(false);
            }
          },
          onerror: (e: any) => {
            console.error('Gemini Live error:', e);
            setStatus('error');
            const errorText = e?.message || '';
            if (errorText.includes("Requested entity was not found")) {
              setErrorMessage('API Key or Project mismatch. Please re-select your key.');
              window.aistudio?.openSelectKey();
            } else {
              setErrorMessage('Network error: Connection to Aura lost. Check your API key and connection.');
            }
          },
          onclose: () => {
            setStatus('disconnected');
            setIsListening(false);
            setIsAssistantTalking(false);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          systemInstruction: 'You are Aura, a witty, futuristic, and high-performance AI voice assistant. Keep responses brief, engaging, and fast. Provide accurate, real-time assistance with a professional yet human-like tone.',
        },
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      console.error('Connection logic failed:', err);
      setStatus('error');
      setErrorMessage(err.message || 'Initialization failed. Ensure mic permissions are granted.');
    }
  };

  const disconnect = () => {
    sessionPromiseRef.current?.then((session) => {
      session.close();
    });
    setStatus('disconnected');
    setIsListening(false);
    setIsAssistantTalking(false);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto p-4 md:p-8">
      {/* Header */}
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/50">
            <i className="fas fa-microchip text-white text-xl"></i>
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-cyan-300">
              AURA AI
            </h1>
            <p className="text-xs text-slate-400 font-medium tracking-widest uppercase">Live Session Engine</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1 glass rounded-full border border-white/10 shadow-inner">
            <div className={`w-2 h-2 rounded-full transition-colors ${
              status === 'connected' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 
              status === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
            }`}></div>
            <span className="text-xs font-bold text-slate-300 capitalize">{status}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col gap-6 overflow-hidden">
        {/* Visualizer Orb */}
        <div className="flex flex-col items-center justify-center py-6 relative">
          <div className={`w-48 h-48 rounded-full flex items-center justify-center relative z-10 transition-all duration-700 ${
            status === 'connected' ? 'scale-110' : 'scale-100 opacity-60'
          }`}>
            <div className={`absolute inset-0 rounded-full blur-[40px] opacity-20 transition-colors duration-500 ${
              isAssistantTalking ? 'bg-blue-400 scale-125' : isListening ? 'bg-cyan-400 scale-110' : 'bg-slate-800'
            }`}></div>
            <div className={`absolute inset-0 border-4 rounded-full transition-all duration-1000 ${
              isAssistantTalking ? 'border-blue-500 scale-105 animate-pulse' : 
              isListening ? 'border-cyan-500 scale-100' : 'border-slate-800'
            }`}></div>
            
            <div className="w-32 h-32 flex items-center justify-center">
              {status === 'connected' ? (
                <Waveform isActive={isAssistantTalking || isListening} color={isAssistantTalking ? '#60a5fa' : '#22d3ee'} />
              ) : (
                <i className="fas fa-bolt text-4xl text-slate-700 animate-pulse"></i>
              )}
            </div>
          </div>
          
          <div className="mt-6 flex flex-col items-center gap-1">
            <p className="text-sm font-bold text-slate-300 tracking-widest uppercase">
              {status === 'connected' 
                ? (isAssistantTalking ? "Broadcasting" : "Monitoring Input") 
                : "Aura Offline"}
            </p>
            <p className="text-[10px] text-slate-500 font-medium">
               {status === 'connected' ? "Connection active @ 16kHz PCM" : "Select voice and initialize below"}
            </p>
          </div>
        </div>

        {/* Transcription Panel */}
        <div className="flex-1 flex flex-col glass rounded-2xl overflow-hidden border border-white/5 shadow-2xl relative">
          <div className="px-6 py-4 border-b border-white/5 flex justify-between items-center bg-white/5">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping"></span>
              Live Feed
            </h2>
            <button 
              onClick={() => setMessages([])}
              className="text-[10px] font-bold text-slate-500 hover:text-slate-300 transition-colors uppercase border border-slate-700 px-2 py-0.5 rounded"
            >
              Clear Logs
            </button>
          </div>
          
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin scrollbar-thumb-slate-800"
          >
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-2 opacity-50">
                <i className="fas fa-terminal text-2xl"></i>
                <p className="text-xs font-mono uppercase tracking-tighter">System awaiting voice prompt...</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm transition-all animate-in fade-in slide-in-from-bottom-2 ${
                  msg.role === 'user' 
                    ? 'bg-blue-600/90 text-white rounded-tr-none shadow-lg shadow-blue-900/20' 
                    : 'bg-slate-800/80 text-slate-200 rounded-tl-none border border-white/10'
                }`}>
                  <p className="leading-relaxed font-medium">{msg.text}</p>
                  <span className="text-[9px] opacity-40 mt-1 block">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Controls */}
      <footer className="mt-8 flex flex-col gap-6">
        {errorMessage && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4 text-red-400 text-sm animate-in zoom-in-95">
            <div className="bg-red-500/20 p-2 rounded-lg">
              <i className="fas fa-triangle-exclamation"></i>
            </div>
            <p className="font-semibold">{errorMessage}</p>
            <button 
              onClick={() => window.aistudio?.openSelectKey()}
              className="ml-auto text-xs bg-red-500 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-red-600 transition-colors"
            >
              Update Key
            </button>
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-4 items-center justify-between glass p-2 rounded-2xl border border-white/5">
          <div className="flex items-center gap-4 w-full md:w-auto px-4">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Speaker Profile</label>
            <select 
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              disabled={status !== 'disconnected'}
              className="bg-slate-900 text-slate-300 text-xs font-bold rounded-lg px-4 py-2 border border-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500/50 appearance-none transition-all disabled:opacity-50"
            >
              {VOICES.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-4 w-full md:w-auto">
            {status === 'connected' ? (
              <button 
                onClick={disconnect}
                className="w-full md:w-56 py-3.5 rounded-xl bg-red-600/90 hover:bg-red-500 text-white font-black uppercase tracking-widest text-xs flex items-center justify-center gap-3 transition-all shadow-xl shadow-red-900/30 group active:scale-95"
              >
                <i className="fas fa-power-off group-hover:rotate-90 transition-transform"></i>
                Terminate Link
              </button>
            ) : (
              <button 
                onClick={connect}
                disabled={status === 'connecting'}
                className="w-full md:w-56 py-3.5 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-black uppercase tracking-widest text-xs flex items-center justify-center gap-3 transition-all shadow-xl shadow-blue-500/20 group active:scale-95 disabled:opacity-50"
              >
                {status === 'connecting' ? (
                  <>
                    <i className="fas fa-circle-notch fa-spin"></i>
                    Syncing...
                  </>
                ) : (
                  <>
                    <i className="fas fa-plug transition-transform group-hover:scale-125"></i>
                    Initialize Aura
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        
        <div className="flex justify-center items-center gap-4 opacity-30 grayscale hover:grayscale-0 transition-all">
          <div className="h-[1px] w-12 bg-slate-500"></div>
          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-[0.3em]">Gemini 2.5 Multi-Modal Live Protocol</p>
          <div className="h-[1px] w-12 bg-slate-500"></div>
        </div>
      </footer>
    </div>
  );
};

export default App;
