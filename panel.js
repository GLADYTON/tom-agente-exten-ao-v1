import { renderChat } from './src/views/chat.js';
import { renderGithub } from './src/views/github.js';
import { renderRepos } from './src/views/repos.js';
import { renderChatHistory } from './src/views/chat-history.js';
import { renderConfig } from './src/views/config.js';
import { renderUsage } from './src/views/usage.js';
import { renderLicense } from './src/views/license.js';
import { renderAgentsPanel } from './src/views/agents.js';
import { getActiveModel, getProviders, getGithub, getRepo, getActiveAgent } from './src/storage.js';
import { getLicenseStatus, requireLicense, validateLicense } from './src/license.js';
import { syncService } from './src/backend/index.js';

const VIEWS = {
  chat: renderChat,
  github: renderGithub,
  repos: renderRepos,
  history: (view) => renderChatHistory(view, () => switchTo('chat')),
  config: renderConfig,
  usage: renderUsage,
  license: renderLicense,
};

// O chat controla seu próprio espaçamento interno, então a view fica sem padding.
const FLUSH_VIEWS = new Set(['chat']);

const tabs = document.querySelectorAll('.app-tab');
const view = document.getElementById('view');
const statusEl = document.getElementById('topbar-status');
const licenseTimerEl = document.getElementById('topbar-license-timer');
let licenseGate = null;

function updateLicenseTimer() {
  getLicenseStatus().then(status => {
    if (!status.isActivated || !status.expiresAt) {
      licenseTimerEl.textContent = '';
      return;
    }
    const remaining = Math.max(0, new Date(status.expiresAt).getTime() - Date.now());
    const totalSeconds = Math.floor(remaining / 1000);
    const months = Math.floor(totalSeconds / 2592000);
    const days = Math.floor((totalSeconds % 2592000) / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    licenseTimerEl.textContent = `Licença${status.plan ? ` ${status.plan}` : ''}: ${months}m ${days}d ${hours}h ${minutes}min ${seconds}s`;
  }).catch(() => { licenseTimerEl.textContent = ''; });
}

function showLicenseGate(message) {
  if (!licenseGate) {
    licenseGate = document.createElement('div');
    licenseGate.className = 'license-gate';
    document.body.appendChild(licenseGate);
  }
  licenseGate.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'license-gate-card';
  card.append(
    Object.assign(document.createElement('div'), { className: 'license-gate-icon', textContent: '🔒' }),
    Object.assign(document.createElement('h2'), { textContent: 'Ative sua licença' }),
    Object.assign(document.createElement('p'), { textContent: message }),
  );
  const input = Object.assign(document.createElement('input'), {
    className: 'input-field', placeholder: 'XXXX-XXXX-XXXX-XXXX', maxLength: 19,
  });
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).replace(/(.{4})/g, '$1-').replace(/-$/, '');
  });
  const error = document.createElement('div');
  const button = Object.assign(document.createElement('button'), { className: 'btn btn-primary', textContent: 'Ativar Licença' });
  button.addEventListener('click', async () => {
    if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(input.value)) {
      error.className = 'error-banner-inline'; error.textContent = 'Use formato XXXX-XXXX-XXXX-XXXX.'; return;
    }
    button.disabled = true; button.textContent = 'Validando...'; error.textContent = '';
    try {
      if (!(await validateLicense(input.value))) throw new Error('Key inválida, expirada ou revogada.');
      licenseGate.remove(); licenseGate = null; switchTo('chat');
    } catch (err) {
      error.className = 'error-banner-inline'; error.textContent = err.message;
      button.disabled = false; button.textContent = 'Ativar Licença';
    }
  });
  card.append(input, error, button);
  licenseGate.appendChild(card);
}

async function enforceLicenseGate() {
  const status = await getLicenseStatus();
  if (!status.licenseKey) return showLicenseGate('Informe key válida no servidor Supabase.');
  const valid = await requireLicense();
  if (!valid) return showLicenseGate('Key inválida, expirada, revogada ou servidor indisponível.');
  if (licenseGate) { licenseGate.remove(); licenseGate = null; }
}

async function refreshStatus() {
  try {
    const [providers, active, repo, agent] = await Promise.all([
      getProviders(), getActiveModel(), getRepo(), getActiveAgent(),
    ]);

    const parts = [];
    parts.push(`${agent?.emoji || '🤖'} ${agent?.name || 'sem agente'}`);

    if (active) {
      const p = providers.find(pp => pp.id === active.providerId);
      const m = p?.models?.find(mm => mm.id === active.modelId);
      parts.push(`${p?.name || '?'} · ${m?.label || '?'}`);
    } else {
      parts.push('sem modelo');
    }

    if (repo) parts.push(repo.fullName);

    statusEl.textContent = parts.join('  ·  ');
  } catch (err) {
    console.error('Error refreshing status:', err);
    statusEl.textContent = 'Erro ao carregar status';
  }
}

async function switchTo(name) {
  try {
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.view === name ? 'true' : 'false'));
    view.classList.toggle('view-flush', FLUSH_VIEWS.has(name));
    await VIEWS[name](view);
    refreshStatus();
  } catch (err) {
    console.error(`Error switching to view ${name}:`, err);
    view.innerHTML = `<div class="error-banner">Erro ao carregar a aba: ${err.message}</div>`;
  }
}

tabs.forEach(t => t.addEventListener('click', () => switchTo(t.dataset.view)));

chrome.storage.onChanged?.addListener?.((changes) => {
  refreshStatus();
  if (changes['tom.is_activated']?.newValue === true && licenseGate) {
    licenseGate.remove();
    licenseGate = null;
    switchTo('chat');
  }
});

export function openAgentsPanel() {
  const panel = document.getElementById('agents-panel');
  const inner = document.getElementById('agents-panel-inner');
  panel.classList.remove('hidden');
  renderAgentsPanel(inner, closeAgentsPanel);
}

export function closeAgentsPanel() {
  document.getElementById('agents-panel').classList.add('hidden');
  // Reaplica a view de chat para refletir troca de agente feita no painel.
  const activeTab = document.querySelector('.app-tab[aria-selected="true"]');
  if (activeTab?.dataset.view === 'chat') switchTo('chat');
}

document.getElementById('agents-panel')?.addEventListener('click', (e) => {
  if (e.target.id === 'agents-panel') closeAgentsPanel();
});

window._openAgentsPanel = openAgentsPanel;

switchTo('chat');
syncService.subscribe(() => {
  refreshStatus();
  const activeTab = document.querySelector('.app-tab[aria-selected="true"]');
  if (activeTab) switchTo(activeTab.dataset.view);
});
syncService.start().catch(() => {});
window.addEventListener('online', () => syncService.sync().catch(() => {}));
updateLicenseTimer();
setInterval(updateLicenseTimer, 1000);
enforceLicenseGate().catch(() => showLicenseGate('Não foi possível validar licença.'));
setInterval(() => enforceLicenseGate().catch(() => showLicenseGate('Não foi possível validar licença.')), 5 * 60 * 1000);
