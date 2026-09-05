import { backendClient } from './client.js';
import { getLicenseStatus } from '../license.js';

const queue = [];

function safeEvent(event, status) {
  const { cost, price, authorization, license_id, device_id, ...safe } = event || {};
  return { ...safe, license_id: status.licenseId, device_id: status.deviceId };
}
let sending = false;
export class UsageService {
  record(event) { queue.push({ ...event, timestamp: event.timestamp || new Date().toISOString() }); this.flush(); }
  async flush() {
    if (sending || !queue.length || !backendClient.baseUrl) return;
    sending = true;
    try {
      const status = await getLicenseStatus();
      while (queue.length) await backendClient.request('/extension/usage', { method: 'POST', body: safeEvent(queue.shift(), status) });
    } catch { /* Telemetria nunca bloqueia extensão; fila tenta depois. */ }
    finally { sending = false; }
  }
}
export const usageService = new UsageService();
