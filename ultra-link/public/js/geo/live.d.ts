// Type declarations for live.js (plain browser ES module).

export type LiveState = 'idle' | 'starting' | 'sharing' | 'stopped' | 'denied' | 'unavailable' | 'error';

export interface LiveStatus {
  state: LiveState;
  labelAr: string;
  noteAr: string;
  sent: number;
  startedAt: number | null;
  lastSentAt: number | null;
  errorAr: string | null;
  hidden: boolean;
  autoStopAt: number | null;
}

export interface LiveApi {
  post(path: string, body?: unknown): Promise<unknown>;
  del?(path: string, body?: unknown): Promise<unknown>;
}

export interface GeolocationLike {
  watchPosition(ok: (pos: { coords: Partial<GeolocationCoordinates> }) => void, err?: (e: { code: number; message?: string }) => void, opts?: PositionOptions): number;
  clearWatch(id: number): void;
}

export interface LiveOptions {
  minIntervalMs: number;
  minMoveM: number;
  serverFloorMs: number;
  heartbeatMs: number;
  retryMs: number;
  maxDurationMs: number;
  maxAccuracyM: number;
}

export interface LiveSharing {
  start(): Promise<LiveStatus>;
  stop(o?: { reason?: 'user' | 'timeout' | 'denied' | 'error'; errorAr?: string | null; notifyServer?: boolean }): Promise<LiveStatus>;
  readonly status: LiveStatus;
}

export const LIVE_NOTE_AR: string;
export const LIVE_DEFAULTS: Readonly<LiveOptions>;
export const LIVE_LABELS_AR: Readonly<Record<LiveState, string>>;
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number;
export function createLiveSharing(o: {
  api: LiveApi;
  intentId: string;
  onStatus?: (s: LiveStatus) => void;
  geolocation?: GeolocationLike | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  doc?: { visibilityState?: string; addEventListener?: Function; removeEventListener?: Function } | null;
  keepaliveFetch?: (url: string) => void;
  options?: Partial<LiveOptions>;
}): LiveSharing;
