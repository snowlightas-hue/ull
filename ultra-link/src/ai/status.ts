// Honest, process-wide status of the Jev integration (served by GET /api/ai/status).
//
// - mode: the engine expected to answer the next turn: 'jev' (live client, not currently failing),
//   'jev-sim' (local simulation), or 'rules' (deterministic parser only).
// - verified: true ONLY after a real successful response from the official base URL
//   (https://api.typesafe.ai). A mock or a custom URL never sets it.
// - lastError: short sanitized string (never the key, never user text).

import { isOfficialBaseUrl, makeRedactor } from './jev-client.ts';
import type { JevError, JevOutcome } from './jev-client.ts';

export type JevMode = 'jev' | 'rules' | 'jev-sim';
export type JevSetting = 'live' | 'simulate' | 'off';

export interface JevStatus {
  mode: JevMode;
  keyConfigured: boolean;
  verified: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  model: string | null;
  labelAr: string;
}

export interface JevStatusConfig {
  setting: JevSetting;
  keyConfigured: boolean;
  /** a client exists (key present / simulate URL valid) */
  clientReady: boolean;
  baseUrl: string | null;
  model: string | null;
  /** why the client could not be built (sanitized), e.g. 'no_key' */
  reason?: string | null;
}

export const LABELS_AR = {
  connected: 'Jev متصل',
  connectedCustom: 'Jev متصل عبر عنوان مخصّص (غير موثّق)',
  keyUntested: 'مفتاح Jev موجود — لم يُختبر الاتصال بعد',
  keyFailing: 'مفتاح Jev موجود لكن الاتصال فشل — يعمل المحلّل المحلي',
  simulation: 'محاكاة Jev (ليست اتصالًا فعليًا)',
  simulationFailing: 'محاكاة Jev لا تستجيب — يعمل المحلّل المحلي',
  rulesOnly: 'المحلّل المحلي فقط',
  rulesOnlyDisabled: 'المحلّل المحلي فقط (Jev معطّل من الإعدادات)',
  rulesOnlyMisconfigured: 'المحلّل المحلي فقط (إعدادات Jev غير صالحة)',
} as const;

const redactShort = makeRedactor([]);

function sanitizeError(e: JevError | string): string {
  const s = typeof e === 'string' ? e : e.short;
  return redactShort(s).slice(0, 160);
}

export class JevStatusTracker {
  private cfg: JevStatusConfig = { setting: 'off', keyConfigured: false, clientReady: false, baseUrl: null, model: null, reason: null };
  private lastSuccessMs: number | null = null;
  private lastFailureMs: number | null = null;
  private lastErrorText: string | null = null;
  private lastLatency: number | null = null;
  private lastModel: string | null = null;
  private verifiedFlag = false;
  private lastSuccessOfficial = false;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** (Re)configure; clears runtime observations. */
  configure(cfg: JevStatusConfig): void {
    this.cfg = { ...cfg, reason: cfg.reason ? redactShort(cfg.reason).slice(0, 160) : null };
    this.lastSuccessMs = null;
    this.lastFailureMs = null;
    this.lastErrorText = this.cfg.reason ?? null;
    this.lastLatency = null;
    this.lastModel = null;
    this.verifiedFlag = false;
    this.lastSuccessOfficial = false;
  }

  recordSuccess(r: { latencyMs: number; model?: string | null; baseUrl: string }): void {
    const t = this.clock();
    this.lastSuccessMs = t;
    this.lastLatency = Math.round(r.latencyMs);
    if (r.model) this.lastModel = r.model;
    this.lastSuccessOfficial = isOfficialBaseUrl(r.baseUrl) && this.cfg.setting === 'live';
    if (this.lastSuccessOfficial) this.verifiedFlag = true;
  }

  recordFailure(r: { error: JevError | string; latencyMs?: number }): void {
    this.lastFailureMs = this.clock();
    this.lastErrorText = sanitizeError(r.error);
    if (r.latencyMs != null) this.lastLatency = Math.round(r.latencyMs);
  }

  /** Hook to pass as `onOutcome` to createJevClient. */
  readonly onOutcome = (o: JevOutcome): void => {
    if (o.ok) this.recordSuccess({ latencyMs: o.latencyMs, model: o.model ?? null, baseUrl: o.baseUrl });
    else if (o.error) this.recordFailure({ error: o.error, latencyMs: o.latencyMs });
  };

  private failing(): boolean {
    return this.lastFailureMs !== null && (this.lastSuccessMs === null || this.lastFailureMs >= this.lastSuccessMs);
  }

  snapshot(): JevStatus {
    const base = {
      keyConfigured: this.cfg.keyConfigured,
      verified: this.verifiedFlag,
      lastSuccessAt: this.lastSuccessMs === null ? null : new Date(this.lastSuccessMs).toISOString(),
      lastError: this.lastErrorText,
      lastLatencyMs: this.lastLatency,
      model: this.lastModel ?? this.cfg.model,
    };
    if (!this.cfg.clientReady || this.cfg.setting === 'off') {
      const labelAr =
        this.cfg.setting === 'off' && this.cfg.keyConfigured
          ? LABELS_AR.rulesOnlyDisabled
          : this.cfg.reason && this.cfg.reason !== 'no_key' && !this.cfg.reason.startsWith('no_key')
            ? LABELS_AR.rulesOnlyMisconfigured
            : LABELS_AR.rulesOnly;
      return { ...base, mode: 'rules', verified: this.verifiedFlag, labelAr };
    }
    if (this.cfg.setting === 'simulate') {
      return this.failing()
        ? { ...base, mode: 'rules', verified: false, labelAr: LABELS_AR.simulationFailing }
        : { ...base, mode: 'jev-sim', verified: false, labelAr: LABELS_AR.simulation };
    }
    // live
    if (this.failing()) return { ...base, mode: 'rules', labelAr: LABELS_AR.keyFailing };
    if (this.lastSuccessMs !== null) {
      return { ...base, mode: 'jev', labelAr: this.lastSuccessOfficial ? LABELS_AR.connected : LABELS_AR.connectedCustom };
    }
    return { ...base, mode: 'jev', labelAr: LABELS_AR.keyUntested };
  }
}

/** Process-wide singleton. */
export const jevStatus = new JevStatusTracker();

export function getJevStatus(): JevStatus {
  return jevStatus.snapshot();
}
