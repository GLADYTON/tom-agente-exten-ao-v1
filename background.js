import { runAgent } from './src/agent/loop.js';
import { Orchestrator } from './src/agent/orchestrator.js';
import {
  getProviders, getActiveModel, getActiveAgent, getChats, saveChats, getActiveChatId, getRepo, getSettings
} from './src/storage.js';
import { requireLicense } from './src/license.js';
import { syncService, usageService } from './src/backend/index.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

syncService.start().catch(() => {});

// Estado global mantido no Service Worker (Background)
let isRunning = false;
let currentChatId = null;
let currentEvents = [];
let executionHistory = [];
let abortController = null;
let currentOrchestrator = null;

async function broadcast(ev) {
  currentEvents.push(ev);
  try {
    chrome.runtime.sendMessage({ type: 'BG_AGENT_EVENT', event: ev }).catch(() => {});
  } catch {}
}

async function startAgentExecution({ text, teamMode }) {
  if (isRunning) return;
  if (!(await requireLicense())) {
    await broadcast({ type: 'error', message: 'Licença inválida ou expirada. Abra Licença para ativar.' });
    return;
  }
  isRunning = true;
  currentEvents = [];
  abortController = new AbortController();

  currentChatId = await getActiveChatId();
  const allChats = await getChats();
  const activeChat = allChats.find(c => c.id === currentChatId);
  executionHistory = activeChat ? (activeChat.messages || []) : [];

  const [providers, globalActive, agent, repo, settings] = await Promise.all([
    getProviders(), getActiveModel(), getActiveAgent(), getRepo(), getSettings()
  ]);

  await broadcast({ type: 'start', text });

  try {
    if (teamMode) {
      currentOrchestrator = new Orchestrator();
      currentOrchestrator.bus.on('*', (ev) => broadcast(ev));
      await currentOrchestrator.run({ userMessage: text });
    } else {
      const providerRef = agent?.modelRef?.providerId || globalActive?.providerId;
      const modelRef = agent?.modelRef?.modelId || globalActive?.modelId;
      const provider = providers.find(p => p.id === providerRef);
      const model = provider?.models?.find(m => m.id === modelRef);

      if (!provider || !model) {
        throw new Error('Provedor ou modelo não configurado.');
      }

      const startedAt = Date.now();
      const out = await runAgent({
        provider, model, agent,
        userMessage: text,
        history: executionHistory,
        signal: abortController.signal,
        onEvent: (ev) => broadcast(ev),
        onApproval: async (req) => {
          return true;
        }
      });

      executionHistory = out.messages.filter(m => m.role !== 'system');
      usageService.record({ request_id: `agent_${startedAt}`, model_id: model.id, gateway_id: provider.id,
        input_tokens: out.totalIn, output_tokens: out.totalOut, total_tokens: out.totalIn + out.totalOut,
        response_time_ms: Date.now() - startedAt, status: out.stopReason === 'error' ? 'error' : 'success' });
    }

    // Salva o chat atualizado no storage
    if (currentChatId) {
      const chats = await getChats();
      const idx = chats.findIndex(c => c.id === currentChatId);
      const chatObj = {
        id: currentChatId,
        title: executionHistory.find(m => m.role === 'user')?.content?.slice(0, 40) || 'Nova Conversa',
        updatedAt: new Date().toISOString(),
        messages: executionHistory
      };
      if (idx >= 0) chats[idx] = chatObj;
      else chats.unshift(chatObj);
      await saveChats(chats);
    }
  } catch (err) {
    if (abortController?.signal?.aborted) {
      await broadcast({ type: 'cancelled', message: 'Execução interrompida pelo usuário. Nenhum commit realizado.' });
    } else {
      await broadcast({ type: 'error', message: err.message });
    }
  } finally {
    isRunning = false;
    abortController = null;
    currentOrchestrator = null;
    await broadcast({ type: 'done' });
  }
}

function stopAgentExecution() {
  if (!isRunning) return;
  if (abortController) {
    abortController.abort('Parado pelo usuário');
  }
  if (currentOrchestrator) {
    currentOrchestrator.cancel('Parado pelo usuário');
  }
  broadcast({ type: 'cancelled', message: 'Execução interrompida pelo usuário.' });
}

// Ouve mensagens da interface do painel
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'BG_START_AGENT') {
    startAgentExecution(req);
    sendResponse({ ok: true });
  } else if (req.type === 'BG_STOP_AGENT') {
    stopAgentExecution();
    sendResponse({ ok: true });
  } else if (req.type === 'BG_GET_STATUS') {
    sendResponse({
      isRunning,
      currentChatId,
      events: currentEvents,
      history: executionHistory
    });
  }
  return true;
});
