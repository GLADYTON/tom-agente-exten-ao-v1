const KEYS = {
  licenseKey: 'tom.license_key',
  deviceSalt: 'tom.device_salt',
  expirationDate: 'tom.expiration_date',
  isActivated: 'tom.is_activated',
  lastValidation: 'tom.last_validation',
  config: 'tom.license_config',
};

const DEFAULT_CONFIG = {
  validateUrl: 'https://rrsehmxgvhomvxopjhcd.supabase.co/functions/v1/validate-license',
  deactivateUrl: '',
  purchaseUrl: '',
  renewUrl: '',
};

async function get(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] === undefined ? fallback : result[key];
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function getLicenseConfig() {
  return { ...DEFAULT_CONFIG, ...(await get(KEYS.config, {})) };
}

export async function setLicenseConfig(config) {
  await chrome.storage.local.set({ [KEYS.config]: { ...(await getLicenseConfig()), ...config } });
}

export async function getOrCreateDeviceId() {
  let salt = await get(KEYS.deviceSalt, '');
  if (!salt) {
    salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await chrome.storage.local.set({ [KEYS.deviceSalt]: salt });
  }
  return sha256(`${chrome.runtime.id}:${salt}`);
}

export async function getLicenseStatus() {
  const [licenseKey, deviceId, expiresAt, isActivated, lastValidation] = await Promise.all([
    get(KEYS.licenseKey, ''), getOrCreateDeviceId(), get(KEYS.expirationDate, ''),
    get(KEYS.isActivated, false), get(KEYS.lastValidation, 0),
  ]);
  return { licenseKey, deviceId, expiresAt, isActivated, lastValidation, deviceName: navigator.userAgent };
}

async function request(url, body) {
  const origin = new URL(url).origin + '/*';
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error('Permissão para servidor de licença negada.');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.error || data.message || data.details || '';
    } catch {
      try { detail = await response.text(); } catch { /* resposta sem corpo */ }
    }
    throw new Error(`Servidor de licença ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

export async function validateLicense(licenseKey) {
  const config = await getLicenseConfig();
  const key = (licenseKey || await get(KEYS.licenseKey, '')).trim().toUpperCase();
  if (!key) return false;
  if (!config.validateUrl) throw new Error('Configure URL de validação da licença.');

  const deviceId = await getOrCreateDeviceId();
  const result = await request(config.validateUrl, {
    license_key: key,
    device_id: deviceId,
    device_name: navigator.userAgent,
  });
  const valid = result.valid === true;
  await chrome.storage.local.set({
    [KEYS.isActivated]: valid,
    [KEYS.lastValidation]: Date.now(),
    [KEYS.expirationDate]: valid ? (result.expires_at || '') : '',
    ...(valid ? { [KEYS.licenseKey]: key } : {}),
  });
  return valid;
}

export async function requireLicense() {
  const status = await getLicenseStatus();
  if (!status.licenseKey) return false;
  try { return await validateLicense(); } catch { return false; }
}

export async function deactivateLicense() {
  const [config, status] = await Promise.all([getLicenseConfig(), getLicenseStatus()]);
  if (config.deactivateUrl && status.licenseKey) {
    await request(config.deactivateUrl, { license_key: status.licenseKey, device_id: status.deviceId });
  }
  await chrome.storage.local.remove([KEYS.licenseKey, KEYS.expirationDate, KEYS.isActivated, KEYS.lastValidation]);
}
