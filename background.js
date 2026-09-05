import { runAgent } from './src/agent/loop.js';
import { Orchestrator } from './src/agent/orchestrator.js';
import {
  getProviders, getActiveModel, getActiveAgent, getChats, saveChats, getActiveChatId, getRepo, getSettings
} from './src/storage.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// Estado global mantido no Service Worker (Background)
let isRunning = false;
let currentChatId = null;
let currentEvents = [];
let executionHistory = [];

async function broadcast(ev) {
  currentEvents.push(ev);
  try {
    chrome.runtime.sendMessage({ type: 'BG_AGENT_EVENT', event: ev }).catch(() => {});
  } catch {}
}

async function startAgentExecution({ text, teamMode }) {
  if (isRunning) return;
  isRunning = true;
  currentEvents = [];

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
      const orchestrator = new Orchestrator();
      orchestrator.bus.on('*', (ev) => broadcast(ev));
      await orchestrator.run({ userMessage: text });
    } else {
      const providerRef = agent?.modelRef?.providerId || globalActive?.providerId;
      const modelRef = agent?.modelRef?.modelId || globalActive?.modelId;
      const provider = providers.find(p => p.id === providerRef);
      const model = provider?.models?.find(m => m.id === modelRef);

      if (!provider || !model) {
        throw new Error('Provedor ou modelo não configurado.');
      }

      const out = await runAgent({
        provider, model, agent,
        userMessage: text,
        history: executionHistory,
        onEvent: (ev) => broadcast(ev),
        onApproval: async (req) => {
          // Salva pedido de aprovação se necessário
          return true;
        }
      });

      executionHistory = out.messages.filter(m => m.role !== 'system');
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
    await broadcast({ type: 'error', message: err.message });
  } finally {
    isRunning = false;
    await broadcast({ type: 'done' });
  }
}

// Ouve mensagens da interface do painel
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'BG_START_AGENT') {
    startAgentExecution(req);
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
