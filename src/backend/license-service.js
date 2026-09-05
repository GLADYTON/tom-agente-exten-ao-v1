import { getLicenseStatus, validateLicense } from '../license.js';
import { backendClient } from './client.js';

export class LicenseService {
  async validate(key) {
    if (!backendClient.baseUrl) return validateLicense(key);
    const status = await getLicenseStatus();
    const result = await backendClient.request('/extension/license/validate', {
      method: 'POST', body: { license_key: key || status.licenseKey, device_id: status.deviceId },
    });
    if (!result.valid) return false;
    await validateLicense(key || status.licenseKey);
    return true;
  }
  status() { return getLicenseStatus(); }
}
export const licenseService = new LicenseService();
