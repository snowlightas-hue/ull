// Thin JSON client for the Ultra Link API. Errors are thrown as {status, code, messageAr}.
const BASE = '';

export class ApiError extends Error {
  constructor(status, code, messageAr) { super(messageAr); this.status = status; this.code = code; this.messageAr = messageAr; }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'تعذّر الاتصال بالخادم. تحقّق من الشبكة وحاول مجددًا.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'http_' + res.status, data?.messageAr ?? 'حدث خطأ غير متوقع.');
  return data;
}

export const get = (path) => req('GET', path);
export const post = (path, body) => req('POST', path, body);
export const patch = (path, body) => req('PATCH', path, body);

export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
