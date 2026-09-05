import { getLicenseStatus, validateLicense, applyLicenseResult, deactivateLicense } from '../license.js';
import { backendClient } from './client.js';

export class LicenseService {
  async validate(key) {
    const status = await getLicenseStatus();
    const targetKey = (key || status.licenseKey || '').trim().toUpperCase();
    if (!targetKey) return false;

    if (!backendClient.baseUrl) {
      return validateLicense(targetKey);
    }

    try {
      const result = await backendClient.request('/extension/license/validate', {
        method: 'POST',
        body: {
          license_key: targetKey,
          key: targetKey,
          device_id: status.deviceId,
          device_name: status.deviceName || navigator.userAgent,
        },
      });
      return applyLicenseResult(targetKey, result);
    } catch (err) {
      if (err.code === 'LICENSE_INVALID' || err.code === 'LICENSE_EXPIRED') {
        await applyLicenseResult(targetKey, { valid: false, message: err.message });
        return false;
      }
      throw err;
    }
  }

  async deactivate() {
    return deactivateLicense();
  }

  async status() {
    return getLicenseStatus();
  }
}

export const licenseService = new LicenseService();

