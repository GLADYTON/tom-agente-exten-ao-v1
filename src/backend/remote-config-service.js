import { backendClient, BACKEND_ERRORS } from './client.js';
import { BACKEND_CONFIG } from './config.js';
import { getLicenseStatus } from '../license.js';
import { getRemoteConfig, saveRemoteConfig } from '../storage.js';

export class RemoteConfigService {
  async fetch() {
    if (!backendClient.baseUrl) {
      return this.cached();
    }
    const status = await getLicenseStatus();
    if (!status.licenseKey) {
      throw Object.assign(new Error('Licença não encontrada.'), { code: BACKEND_ERRORS.LICENSE_INVALID });
    }

    try {
      const data = await backendClient.request('/extension/config', {
        headers: {
          'X-License-Key': status.licenseKey,
          'X-Device-ID': status.deviceId,
        },
      });

      if (data && data.license?.valid === false) {
        throw Object.assign(new Error(data.license.message || 'Licença inválida ou expirada.'), {
          code: BACKEND_ERRORS.LICENSE_INVALID,
        });
      }

      await saveRemoteConfig(data);
      return data;
    } catch (err) {
      // Se houver falha de rede/servidor indisponível, verifica se o cache local ainda está dentro do período de tolerância
      if (err.code === BACKEND_ERRORS.NETWORK_ERROR || err.code === BACKEND_ERRORS.BACKEND_UNAVAILABLE) {
        const cachedWrap = await getRemoteConfig();
        if (cachedWrap?.syncedAt && (Date.now() - cachedWrap.syncedAt) < BACKEND_CONFIG.offlineGraceMs) {
          return cachedWrap.data;
        }
      }
      throw err;
    }
  }

  async cached() {
    const wrap = await getRemoteConfig();
    return wrap?.data || null;
  }

  async getCacheMeta() {
    const wrap = await getRemoteConfig();
    return {
      syncedAt: wrap?.syncedAt || null,
      version: wrap?.version || wrap?.data?.version || null,
    };
  }
}

export const remoteConfigService = new RemoteConfigService();

