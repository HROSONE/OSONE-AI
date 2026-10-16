export interface AIProfile {
  name: string;
  personality: string;
  writingStyle: string;
  obsidianConfig?: {
    baseUrl: string;
    apiKey: string;
    vaultName?: string;
  };
}

export interface User {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  isLocal?: boolean;
}

export interface ApiKeys {
  gemini: string;
  googleHomeId?: string;
  googleHomeToken?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsVoiceId2?: string;
  elevenLabsVoiceId3?: string;
  elevenLabsActiveVoice?: 'voice1' | 'voice2' | 'voice3';
  elevenLabsStability?: number;
  elevenLabsSimilarityBoost?: number;
  elevenLabsStyle?: number;
  elevenLabsSpeakerBoost?: boolean;
  elevenLabsModel?: string;
  geminiModel?: 'gemini-3.7-flash' | 'gemini-3.6-flash' | 'gemini-3.5-flash-lite' | 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
  googleCustomSearchApiKey?: string;
  googleCustomSearchCx?: string;
  tavilyApiKey?: string;
  localAgentToken?: string;
  osoneCodeProvider?: 'gemini' | 'openai' | 'anthropic' | 'ollama';
  osoneCodeOpenAiApiKey?: string;
  osoneCodeOpenAiModel?: string;
  osoneCodeAnthropicApiKey?: string;
  osoneCodeAnthropicModel?: string;
  /** Modelo local baixado pelo Ollama (ex.: 'qwen2.5-coder:1.5b'). Só tem sentido com o provedor 'ollama'. */
  osoneCodeOllamaModel?: string;
  /** Endereço do Ollama na máquina do usuário. Vazio = http://127.0.0.1:11434. */
  osoneCodeOllamaUrl?: string;
}

export type OrbStyle = 'classic' | 'superintelligence' | 'neural' | 'shadow' | 'wave' | 'jarvis' | 'smoke';
export type AppTheme = 'her' | 'cyberpunk' | 'monochrome' | 'nature';

export type WorkspaceMode = 'home' | 'writing' | 'code' | 'ide' | 'sounds' | 'canvas' | 'wellness' | 'local_control' | 'whatsapp' | 'map' | 'rag' | 'creator' | 'tiktok' | 'sensus_evolution' | 'memory_book' | 'smarthome' | 'vision_control' | 'cowork' | 'hear' | 'cameras' | 'web_research';

/**
 * Uma cena: o estado desejado de aparelhos REAIS da conta Tuya, guardado pelo usuário.
 *
 * SmartDevice e SmartHomeConfig foram removidos junto com o simulador. O SmartDevice descrevia
 * um aparelho inventado guardado no navegador, e o SmartHomeConfig guardava credenciais de
 * Tuya/Hue/SmartThings no lado do cliente — as credenciais reais da Tuya vivem só no servidor, e
 * Hue/SmartThings nunca chegaram a ter integração nenhuma. O aparelho real é descrito pelo que a
 * Tuya devolve, e não por um tipo nosso.
 */
export interface SmartRoutine {
  id: string;
  name: string;
  icon: string;
  actions: {
    deviceId: string;
    targetState: boolean;
    targetValue?: number;
    targetColor?: string;
  }[];
}

export interface CodeRepositoryFile {
  id: string;
  name: string;
  language: string;
  content: string;
  updatedAt: number;
  isMain?: boolean;
}

export interface MemoryBookEntry {
  id: string;
  date: string; // Formato "YYYY-MM-DD" para ordenamento
  title: string;
  summary: string;
  keyPoints: string[];
  topics: string[];
  createdAt: number;
}

export interface RagFile {
  id: string;
  name: string;
  path: string;
  content: string;
  size: number;
  type: string;
  isActive: boolean;
}

export interface DrawingObject {
  id: string;
  type: 'line' | 'rect' | 'circle' | 'text' | 'image';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  color?: string;
  text?: string;
  fontSize?: number;
  points?: number[]; // For lines/polygons
  stroke?: string;
  fill?: string;
  opacity?: number;
}

export interface SoundEffect {
  id: string;
  name: string;
  category: string;
  url: string;
  tipo?: 'efeito' | 'musica' | 'ambiente';
  origem?: string;
}

export interface Character {
  id: string;
  name: string;
  characteristics: string;
  imageUrl?: string;
}

export interface WebtoonPanel {
  id: string;
  imageUrl?: string;
  dialogue: string;
  narration: string;
  panelNumber: number;
  imagePrompt?: string;
}

export interface WebtoonProject {
  id: string;
  title: string;
  idea: string;
  characters: Character[];
  style: string;
  language: string;
  panels: WebtoonPanel[];
  createdAt: number;
}

export interface VirtualFile {
  id: string;
  name: string;
  content: string;
  type: 'file';
}

export interface VirtualFolder {
  id: string;
  name: string;
  children: FileSystemItem[];
  type: 'folder';
}

export type FileSystemItem = VirtualFile | VirtualFolder;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
}

export interface SkeletonPlan {
  id: string;
  title: string;
  content: string; // Markdown
  status: 'pending' | 'approved' | 'rejected';
}

export interface LiveState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export interface VoiceModulation {
  pitch: number;
  rate: number;
  distortion: number;
}

export interface WritingProject {
  id: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}
