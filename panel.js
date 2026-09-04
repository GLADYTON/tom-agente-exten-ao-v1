import { renderChat } from './src/views/chat.js';
import { renderGithub } from './src/views/github.js';
import { renderRepos } from './src/views/repos.js';
import { renderChatHistory } from './src/views/chat-history.js';
import { renderConfig } from './src/views/config.js';
import { renderUsage } from './src/views/usage.js';
import { renderAgentsPanel } from './src/views/agents.js';
import { getActiveModel, getProviders, getGithub, getRepo, getActiveAgent } from './src/storage.js';

const VIEWS = {
  chat: renderChat,
  github: renderGithub,
  repos: renderRepos,
  history: (view) => renderChatHistory(view, () => switchTo('chat')),
  config: renderConfig,
  usage: renderUsage,
};

// O chat controla seu próprio espaçamento interno, então a view fica sem padding.
const FLUSH_VIEWS = new Set(['chat']);

const tabs = document.querySelectorAll('.app-tab');
const view = document.getElementById('view');
const statusEl = document.getElementById('topbar-status');

async function refreshStatus() {
  try {
    const [providers, active, github, repo, agent] = await Promise.all([
      getProviders(), getActiveModel(), getGithub(), getRepo(), getActiveAgent(),
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

    parts.push(github.user ? `@${github.user.login}` : 'sem github');
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

chrome.storage.onChanged?.addListener?.(refreshStatus);

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
