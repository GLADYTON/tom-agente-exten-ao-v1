import { backendClient } from './client.js';
import { getLicenseStatus } from '../license.js';

let queue = [];
let sending = false;

function safeEvent(event, status) {
  const { cost, price, authorization, license_id, device_id, ...safe } = event || {};
  return {
    request_id: safe.request_id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    license_id: status.licenseId || status.licenseKey || '',
    device_id: status.deviceId || '',
    model_id: safe.model_id || '',
    gateway_id: safe.gateway_id || '',
    skill_id: safe.skill_id || null,
    input_tokens: safe.input_tokens || 0,
    output_tokens: safe.output_tokens || 0,
    total_tokens: safe.total_tokens || ((safe.input_tokens || 0) + (safe.output_tokens || 0)),
    response_time_ms: safe.response_time_ms || 0,
    status: safe.status || 'success',
    timestamp: safe.timestamp || new Date().toISOString(),
  };
}

export class UsageService {
  record(event) {
    if (!event) return;
    queue.push({ ...event, timestamp: event.timestamp || new Date().toISOString() });
    this.flush().catch(() => {});
  }

  async flush() {
    if (sending || !queue.length || !backendClient.baseUrl) return;
    sending = true;
    try {
      const status = await getLicenseStatus();
      while (queue.length > 0) {
        const item = queue[0];
        const payload = safeEvent(item, status);
        await backendClient.request('/extension/usage', { method: 'POST', body: payload });
        queue.shift(); // Remove da fila após envio bem-sucedido
      }
    } catch {
      // Falha de telemetria nunca bloqueia extensão; a fila permanece para tentar posteriormente.
    } finally {
      sending = false;
    }
  }

  getPendingCount() {
    return queue.length;
  }
}

export const usageService = new UsageService();

