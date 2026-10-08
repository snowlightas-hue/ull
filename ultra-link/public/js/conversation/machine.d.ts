// Type declarations for machine.js (plain browser ES module).
import type { ListenHandlers, SpeakResult } from './voice.js';

export type ConversationState =
  | 'ready'
  | 'listening'
  | 'reviewing'
  | 'processing'
  | 'asking'
  | 'speaking'
  | 'awaiting_answer'
  | 'saving'
  | 'searching'
  | 'results'
  | 'saved_no_results'
  | 'error';

export type MachineEventType =
  | 'LISTEN'
  | 'INTERIM'
  | 'STOP'
  | 'FINAL'
  | 'VOICE_EMPTY'
  | 'VOICE_ERROR'
  | 'EDIT'
  | 'EDIT_TEXT'
  | 'SEND'
  | 'SUBMIT_TEXT'
  | 'CANCEL'
  | 'TURN_ASK'
  | 'TURN_SAVED'
  | 'TURN_CANCELLED'
  | 'TURN_FAILED'
  | 'SPEAK'
  | 'SPEAK_SKIPPED'
  | 'SPOKEN'
  | 'REPEAT'
  | 'SEARCH'
  | 'MATCH_DONE'
  | 'MATCH_FAILED'
  | 'RETRY'
  | 'DISMISS'
  | 'RESUME'
  | 'RESET';

export interface QuestionLike {
  id: string;
  field: string;
  text: string;
  speech: string;
  options?: { value: string; label: string }[];
  attempt?: number;
  client?: boolean;
  [k: string]: unknown;
}

export interface TurnBody {
  text: string;
  modality: 'voice' | 'text';
  clientTurnId: string;
}

export interface ConversationApi {
  ensureConversation(): Promise<{ id: string }>;
  sendTurn(conversationId: string, body: TurnBody): Promise<any>;
  runMatch(intentId: string): Promise<any>;
  cancelConversation?(conversationId: string): Promise<unknown>;
}

export interface VoiceLike {
  listen(handlers: ListenHandlers): unknown;
  speak(text: string): Promise<SpeakResult> | SpeakResult;
  stopSpeaking?(): void;
  stopListening?(): void;
  abortListening?(reason?: string): void;
  isSpeaking?(): boolean;
  canAutoListen?(): boolean;
  canSpeak?(): boolean;
  subscribe?(fn: (status: any) => void): () => void;
}

export interface MachineError {
  kind: 'voice' | 'turn' | 'match';
  code: string;
  status?: number;
  recoverable: boolean;
  messageAr: string;
  offerText: boolean;
  origin?: string;
  [k: string]: unknown;
}

export interface ConversationContext {
  conversationId: string | null;
  transcript: string;
  interim: string;
  question: QuestionLike | null;
  lastTurn: any;
  intent: any;
  matchRun: any;
  error: MachineError | null;
  seq: number;
  origin: 'ready' | 'awaiting_answer';
  review: { deadline: number | null; autoSendMs: number; editing: boolean; original: string; modality: 'voice' | 'text' } | null;
  pendingTurn: TurnBody | null;
  modality: 'voice' | 'text' | null;
  micLive: boolean;
  speech: { status: string; text?: string; reason?: string } | null;
  notice: { kind: string; messageAr: string } | null;
  canAutoListen: boolean;
  savedConversationId: string | null;
}

export interface MachineEvent {
  type: MachineEventType | 'MIC_LIVE' | 'VOICE_STATUS';
  from: ConversationState;
  to: ConversationState;
  info?: Record<string, unknown>;
}

export interface LogEntry {
  i: number;
  t: number;
  seq: number;
  event: string;
  from: ConversationState;
  to: ConversationState | null;
  ok: boolean;
  reason?: string;
  info?: Record<string, unknown>;
}

export interface MachineOptions {
  api: ConversationApi;
  voice?: VoiceLike | null;
  clock?: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  autoSendMs?: number;
  savingMs?: number;
  autoListen?: boolean;
  autoListenAfterText?: boolean;
  speakQuestions?: boolean;
  announce?: 'voice' | 'always' | 'never';
  optionText?: (option: { value: string; label: string }) => string;
  uuid?: () => string;
  logLimit?: number;
  isOffline?: () => boolean;
}

export interface ConversationMachine {
  readonly state: ConversationState;
  readonly context: Readonly<ConversationContext>;
  subscribe(fn: (state: ConversationState, context: Readonly<ConversationContext>, event: MachineEvent) => void): () => void;
  can(event: MachineEventType): boolean;
  pressMic(): boolean;
  startListening(): boolean;
  stopListening(): boolean;
  sendNow(text?: string): boolean;
  edit(): boolean;
  updateDraft(text: string): boolean;
  cancel(): boolean;
  submitText(text: string): boolean;
  chooseOption(option: { value: string; label: string }): boolean;
  retry(): boolean;
  dismissError(): boolean;
  repeatQuestion(): boolean;
  reset(): boolean;
  resume(conversation: { id: string; question?: QuestionLike | null }, question?: QuestionLike | null): boolean;
  getLog(): LogEntry[];
  destroy(): void;
}

export const STATES: readonly ConversationState[];
export const TRANSITIONS: Readonly<Record<ConversationState, Partial<Record<MachineEventType, ConversationState[]>>>>;
export const MESSAGES_AR: Readonly<Record<string, string>>;
export function resultsMessageAr(n: number): string;
export function randomUuid(): string;
export function createConversationMachine(options: MachineOptions): ConversationMachine;
