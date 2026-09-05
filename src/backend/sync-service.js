import { BACKEND_CONFIG } from './config.js';
import { licenseService } from './license-service.js';
import { remoteConfigService } from './remote-config-service.js';

let inFlight = null;
let timer = null;
const listeners = new Set();

export class SyncService {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  async sync() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const valid = await licenseService.validate();
      if (!valid) throw Object.assign(new Error('Licença inválida ou expirada.'), { code: 'LICENSE_INVALID' });
      const config = await remoteConfigService.fetch();
      listeners.forEach(listener => listener(config));
      return config;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  start() { if (!timer) timer = setInterval(() => this.sync().catch(() => {}), BACKEND_CONFIG.syncIntervalMs); return this.sync(); }
  stop() { clearInterval(timer); timer = null; }
}
export const syncService = new SyncService();
