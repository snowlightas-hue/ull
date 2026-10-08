// Type declarations for voice.js (plain browser ES module).
export type VoiceErrorCode =
  | 'not-allowed'
  | 'service-not-allowed'
  | 'audio-capture'
  | 'network'
  | 'no-speech'
  | 'aborted'
  | 'language-not-supported'
  | 'bad-grammar'
  | 'unsupported'
  | 'start-failed'
  | 'busy'
  | 'unknown';

export interface VoiceError {
  code: VoiceErrorCode | string;
  recoverable: boolean;
  messageAr: string;
  offerText: true;
  offline?: boolean;
  proactive?: boolean;
  silentEnd?: boolean;
  [k: string]: unknown;
}

export type ListenEndReason = 'final' | 'no-speech' | 'error' | 'aborted';

export interface ListenHandlers {
  onStart?: (info: { lang: string }) => void;
  onInterim?: (text: string, parts?: { finalText: string; interimText: string }) => void;
  onFinal?: (text: string) => void;
  onEnd?: (reason: ListenEndReason) => void;
  onError?: (err: VoiceError) => void;
}

export interface SpeakResult {
  ok: boolean;
  reason: 'end' | 'cancelled' | 'error' | 'timeout' | 'unsupported' | 'empty' | 'no-arabic-voice' | string;
  startedAt?: number | null;
  endedAt?: number;
  voice?: { name: string; lang: string } | null;
  [k: string]: unknown;
}

export interface VoiceStatus {
  recognition: boolean;
  synthesis: boolean;
  permission: 'granted' | 'denied' | 'prompt' | 'unknown';
  permissionSource: 'query' | 'error' | 'none';
  online: boolean;
  voicesLoaded: boolean;
  hasArabicVoice: boolean;
  voiceName: string | null;
  voiceLang: string | null;
  recLang: string | null;
  listening: boolean;
  speaking: boolean;
  canAutoListen: boolean;
  canSpeak: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface VoiceOptions {
  lang?: string;
  langs?: string[];
  window?: any;
  clock?: Clock;
  guardMs?: number;
  rate?: number;
  keepalive?: boolean | 'auto';
  keepaliveMs?: number;
  maxListenMs?: number;
  endWatchdogMs?: number;
  startWatchdogMs?: number;
  voicesWaitMs?: number;
  speakStartTimeoutMs?: number;
  busyWaitMs?: number;
}

export interface Voice {
  readonly support: { readonly recognition: boolean; readonly synthesis: boolean };
  readonly ready: Promise<VoiceStatus>;
  status(): VoiceStatus;
  subscribe(fn: (status: VoiceStatus) => void): () => void;
  refreshPermission(): Promise<VoiceStatus['permission']>;
  permissionState(): VoiceStatus['permission'];
  hasArabicVoice(): boolean;
  canAutoListen(): boolean;
  canSpeak(): boolean;
  isOnline(): boolean;
  isListening(): boolean;
  isSpeaking(): boolean;
  listen(handlers?: ListenHandlers): Promise<{ started: boolean; lang?: string; reason?: string }>;
  stopListening(): void;
  abortListening(reason?: string): void;
  speak(text: string, opts?: { rate?: number; lang?: string; allowNonArabic?: boolean }): Promise<SpeakResult>;
  stopSpeaking(): void;
  debugLog(): Array<{ t: number; type: string; [k: string]: unknown }>;
  destroy(): void;
}

export const DEFAULT_LANGS: readonly string[];
export const LANG_STORAGE_KEY: string;
export const VOICE_ERRORS: Readonly<Record<string, { recoverable: boolean; messageAr: string }>>;
export function describeVoiceError(code: string, extra?: Record<string, unknown>): VoiceError;
export function normLang(lang: string | null | undefined): string;
export function pickArabicVoice<V extends { lang: string; localService?: boolean }>(voices: V[], prefs?: readonly string[]): V | null;
export function readRecognitionResults(ev: any): { finalText: string; interimText: string };
export function createVoice(options?: VoiceOptions): Voice;
