import { backendClient } from './client.js';
import { getLicenseStatus } from '../license.js';

const queue = [];
let sending = false;
export class UsageService {
  record(event) { queue.push({ ...event, timestamp: event.timestamp || new Date().toISOString() }); this.flush(); }
  async flush() {
    if (sending || !queue.length || !backendClient.baseUrl) return;
    sending = true;
    try {
      const status = await getLicenseStatus();
      while (queue.length) await backendClient.request('/extension/usage', { method: 'POST', body: { ...queue.shift(), license_id: status.licenseId, device_id: status.deviceId } });
    } catch { /* Telemetria nunca bloqueia extensão; fila tenta depois. */ }
    finally { sending = false; }
  }
}
export const usageService = new UsageService();
