import { BACKEND_BASE_URL, BACKEND_CONFIG } from './config.js';

export const BACKEND_ERRORS = {
  LICENSE_INVALID: 'LICENSE_INVALID', LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED', NETWORK_ERROR: 'NETWORK_ERROR',
  CONFIG_SYNC_ERROR: 'CONFIG_SYNC_ERROR', BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
};

function publicError(code, message) {
  const error = new Error(message || 'Serviço remoto indisponível.');
  error.code = code;
  return error;
}

export class BackendClient {
  constructor(baseUrl = BACKEND_BASE_URL) { this.baseUrl = baseUrl.replace(/\/$/, ''); }

  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (!this.baseUrl) throw publicError(BACKEND_ERRORS.BACKEND_UNAVAILABLE, 'Backend não configurado.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${path.replace(/^\//, '')}`, {
        method, signal: signal || controller.signal,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw publicError(response.status === 401 ? BACKEND_ERRORS.LICENSE_INVALID : BACKEND_ERRORS.BACKEND_UNAVAILABLE, data.message);
      return data;
    } catch (error) {
      if (error.code) throw error;
      throw publicError(BACKEND_ERRORS.NETWORK_ERROR, 'Não foi possível conectar ao backend.');
    } finally { clearTimeout(timer); }
  }
}

export const backendClient = new BackendClient();
