
export interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface VoiceOption {
  id: string;
  name: string;
}

export const VOICES: VoiceOption[] = [
  { id: 'Zephyr', name: 'Zephyr' },
  { id: 'Puck', name: 'Puck' },
  { id: 'Charon', name: 'Charon' },
  { id: 'Kore', name: 'Kore' },
  { id: 'Fenrir', name: 'Fenrir' }
];
