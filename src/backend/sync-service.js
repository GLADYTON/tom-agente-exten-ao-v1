import { BACKEND_CONFIG } from './config.js';
import { licenseService } from './license-service.js';
import { remoteConfigService } from './remote-config-service.js';
import { usageService } from './usage-service.js';

let inFlight = null;
let timer = null;
const listeners = new Set();
let lastSyncState = {
  lastSyncAt: null,
  lastError: null,
  inProgress: false,
};

export class SyncService {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  getState() {
    return { ...lastSyncState };
  }

  async sync() {
    if (inFlight) return inFlight;
    lastSyncState.inProgress = true;

    inFlight = (async () => {
      try {
        const valid = await licenseService.validate();
        if (!valid) {
          const err = Object.assign(new Error('Licença inválida ou expirada.'), { code: 'LICENSE_INVALID' });
          lastSyncState.lastError = err.message;
          throw err;
        }

        const config = await remoteConfigService.fetch();
        lastSyncState.lastSyncAt = Date.now();
        lastSyncState.lastError = null;

        // Tenta desovar a fila de estatísticas pendentes
        usageService.flush().catch(() => {});

        listeners.forEach(listener => {
          try { listener(config, lastSyncState); } catch (e) { console.error('Error in sync listener:', e); }
        });
        return config;
      } catch (err) {
        lastSyncState.lastError = err.message || 'Erro na sincronização';
        listeners.forEach(listener => {
          try { listener(null, lastSyncState); } catch (e) { console.error('Error in sync listener:', e); }
        });
        throw err;
      } finally {
        lastSyncState.inProgress = false;
        inFlight = null;
      }
    })();

    return inFlight;
  }

  start() {
    if (!timer) {
      timer = setInterval(() => this.sync().catch(() => {}), BACKEND_CONFIG.syncIntervalMs);
    }
    return this.sync().catch(() => {});
  }

  stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Hook para atualizações em tempo real (Supabase Realtime/WebSocket)
  onRealtimeUpdate(updatePayload) {
    this.sync().catch(() => {});
  }
}

export const syncService = new SyncService();

