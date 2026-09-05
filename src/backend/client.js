import { BACKEND_BASE_URL, BACKEND_CONFIG } from './config.js';

export const BACKEND_ERRORS = {
  LICENSE_INVALID: 'LICENSE_INVALID',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  CONFIG_SYNC_ERROR: 'CONFIG_SYNC_ERROR',
  MODEL_NOT_AVAILABLE: 'MODEL_NOT_AVAILABLE',
  SKILL_NOT_AVAILABLE: 'SKILL_NOT_AVAILABLE',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
};

function publicError(code, message) {
  const error = new Error(message || 'Serviço remoto indisponível.');
  error.code = code;
  return error;
}

export class BackendClient {
  constructor(baseUrl = BACKEND_BASE_URL) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
  }

  setBaseUrl(url) {
    this.baseUrl = (url || '').replace(/\/$/, '');
  }

  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (!this.baseUrl) {
      throw publicError(BACKEND_ERRORS.BACKEND_UNAVAILABLE, 'Backend não configurado.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${path.replace(/^\//, '')}`, {
        method,
        signal: signal || controller.signal,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        let code = BACKEND_ERRORS.BACKEND_UNAVAILABLE;
        if (response.status === 401 || data.code === 'LICENSE_INVALID') code = BACKEND_ERRORS.LICENSE_INVALID;
        else if (response.status === 403 || data.code === 'LICENSE_EXPIRED') code = BACKEND_ERRORS.LICENSE_EXPIRED;
        else if (data.code === 'DEVICE_LIMIT_REACHED') code = BACKEND_ERRORS.DEVICE_LIMIT_REACHED;
        else if (data.code) code = data.code;
        throw publicError(code, data.message || data.error);
      }
      return data;
    } catch (error) {
      if (error.code) throw error;
      throw publicError(BACKEND_ERRORS.NETWORK_ERROR, 'Não foi possível conectar ao backend.');
    } finally {
      clearTimeout(timer);
    }
  }
}

export const backendClient = new BackendClient();

