import { backendClient } from './client.js';
import { getLicenseStatus } from '../license.js';
import { getRemoteConfig, saveRemoteConfig } from '../storage.js';

export class RemoteConfigService {
  async fetch() {
    const status = await getLicenseStatus();
    const data = await backendClient.request('/extension/config', {
      headers: { 'X-License-Key': status.licenseKey, 'X-Device-ID': status.deviceId },
    });
    if (!data || data.license?.valid !== true) throw new Error('Licença não autorizada para configuração.');
    await saveRemoteConfig(data);
    return data;
  }
  cached() { return getRemoteConfig(); }
}
export const remoteConfigService = new RemoteConfigService();
