import { runAgent } from './src/agent/loop.js';
import { Orchestrator } from './src/agent/orchestrator.js';
import {
  getProviders, getActiveModel, getActiveAgent, getChats, saveChats, getActiveChatId, getRepo, getSettings,
} from './src/storage.js';
import { requireLicense } from './src/license.js';
import { syncService, usageService } from './src/backend/index.js';

const APPROVAL_TTL_MS = 90_000;
const pendingApprovals = new Map();
let panelConnectionId = null;
let sessionId = `session_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

function safeApprovalRequest(req) {
  return {
    requestId: req.requestId,
    sessionId,
    panelConnectionId,
    kind: req.kind,
    repositoryId: req.repositoryId || req.repo || undefined,
    branch: req.branch,
    fromBranch: req.fromBranch,
    base: req.base,
    baseSha: req.baseSha,
    operationDigest: req.operationDigest,
    summary: typeof req.summary === 'string' ? req.summary.slice(0, 500) : '',
    reason: typeof req.reason === 'string' ? req.reason.slice(0, 500) : '',
    title: typeof req.title === 'string' ? req.title.slice(0, 256) : undefined,
    files: (req.files || []).map(f => ({
      path: f.path,
      action: f.action,
      added: f.added,
      removed: f.removed,
    })),
    diff: typeof req.diff === 'string' ? req.diff.slice(0, 30_000) : undefined,
    body: typeof req.body === 'string' ? req.body.slice(0, 20_000) : undefined,
    expiresAt: req.expiresAt,
  };
}

async function digestApprovalRequest(req) {
  if (req.operationDigest) return req.operationDigest;
  const payload = JSON.stringify({
    kind: req.kind,
    branch: req.branch,
    fromBranch: req.fromBranch,
    base: req.base,
    title: req.title,
    body: req.body,
    files: req.files || [],
    summary: req.summary,
  });
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function broadcast(ev) {
  currentEvents.push(ev);
  try {
    await chrome.runtime.sendMessage({ type: 'BG_AGENT_EVENT', event: ev });
  } catch {
    // Painel pode estar fechado. Aprovações pendentes são negadas no disconnect.
  }
}

function rejectApprovals(reason = 'sessão encerrada') {
  for (const [id, pending] of pendingApprovals) {
    clearTimeout(pending.timer);
    pending.resolve(false);
    pendingApprovals.delete(id);
    broadcast({ type: 'approval_cancelled', requestId: id, reason }).catch(() => {});
  }
}

async function requestApproval(req) {
  if (!panelConnectionId) return false;
  const operationDigest = await digestApprovalRequest(req);
  const requestId = `approval_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  const pendingRequest = {
    ...req,
    requestId,
    operationDigest,
    sessionId,
    panelConnectionId,
    expiresAt,
  };

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve(false);
      broadcast({ type: 'approval_expired', requestId }).catch(() => {});
    }, APPROVAL_TTL_MS);
    pendingApprovals.set(requestId, {
      ...pendingRequest,
      resolve,
      timer,
      consumed: false,
    });
    broadcast({ type: 'approval_request', req: safeApprovalRequest(pendingRequest) }).catch(() => {});
  });
}

function respondApproval(req) {
  const pending = pendingApprovals.get(req.requestId);
  if (!pending || pending.consumed) return false;
  if (pending.sessionId !== sessionId || pending.panelConnectionId !== panelConnectionId) return false;
  if (Date.now() >= pending.expiresAt || req.operationDigest !== pending.operationDigest) return false;
  if (req.decision !== 'approve' && req.decision !== 'deny') return false;

  pending.consumed = true;
  clearTimeout(pending.timer);
  pendingApprovals.delete(req.requestId);
  pending.resolve(req.decision === 'approve');
  broadcast({ type: 'approval_resolved', requestId: req.requestId, decision: req.decision }).catch(() => {});
  return true;
}

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

async function startAgentExecution({ text, teamMode }) {
  if (isRunning) return;
  if (!(await requireLicense())) {
    await broadcast({ type: 'error', message: 'Licença inválida ou expirada. Abra Licença para ativar.' });
    return;
  }

  isRunning = true;
  currentEvents = [];
  abortController = new AbortController();

  try {
    currentChatId = await getActiveChatId();
    const allChats = await getChats();
    const activeChat = allChats.find(c => c.id === currentChatId);
    executionHistory = activeChat ? (activeChat.messages || []) : [];

    const [providers, globalActive, agent, repo, settings] = await Promise.all([
      getProviders(), getActiveModel(), getActiveAgent(), getRepo(), getSettings(),
    ]);

    await broadcast({ type: 'start', text });

    if (teamMode) {
      currentOrchestrator = new Orchestrator();
      currentOrchestrator.bus.on('*', (ev) => broadcast(ev));
      await currentOrchestrator.run({ userMessage: text });
    } else {
      const providerRef = agent?.modelRef?.providerId || globalActive?.providerId;
      const modelRef = agent?.modelRef?.modelId || globalActive?.modelId;
      const provider = providers.find(p => p.id === providerRef);
      const model = provider?.models?.find(m => m.id === modelRef);

      if (!provider || !model) throw new Error('Provedor ou modelo não configurado.');

      const startedAt = Date.now();
      const out = await runAgent({
        provider,
        model,
        agent,
        userMessage: text,
        history: executionHistory,
        signal: abortController.signal,
        onEvent: (ev) => broadcast(ev),
        onApproval: (req) => requestApproval(req),
      });

      executionHistory = out.messages.filter(m => m.role !== 'system');
      usageService.record({
        request_id: `agent_${startedAt}`,
        model_id: model.id,
        gateway_id: provider.id,
        input_tokens: out.totalIn,
        output_tokens: out.totalOut,
        total_tokens: out.totalIn + out.totalOut,
        response_time_ms: Date.now() - startedAt,
        status: out.stopReason === 'error' ? 'error' : 'success',
      });
    }

    if (currentChatId) {
      const chats = await getChats();
      const idx = chats.findIndex(c => c.id === currentChatId);
      const chatObj = {
        id: currentChatId,
        title: executionHistory.find(m => m.role === 'user')?.content?.slice(0, 40) || 'Nova Conversa',
        updatedAt: new Date().toISOString(),
        messages: executionHistory,
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
  abortController?.abort('Parado pelo usuário');
  currentOrchestrator?.cancel('Parado pelo usuário');
  broadcast({ type: 'cancelled', message: 'Execução interrompida pelo usuário.' });
}

// Toda aprovação retorna apenas dados serializáveis. A Promise vive no worker.
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'BG_PANEL_CONNECT') {
    if (panelConnectionId && panelConnectionId !== req.connectionId) rejectApprovals('painel reconectado');
    panelConnectionId = req.connectionId || `panel_${Date.now()}`;
    sendResponse({ ok: true, connectionId: panelConnectionId });
  } else if (req.type === 'BG_PANEL_DISCONNECT') {
    if (!req.connectionId || req.connectionId === panelConnectionId) {
      panelConnectionId = null;
      rejectApprovals('painel fechado ou recarregado');
    }
    sendResponse({ ok: true });
  } else if (req.type === 'BG_APPROVAL_RESPONSE') {
    sendResponse({ ok: respondApproval(req, sender) });
  } else if (req.type === 'BG_START_AGENT') {
    if (!panelConnectionId) panelConnectionId = req.connectionId || `panel_${Date.now()}`;
    startAgentExecution(req);
    sendResponse({ ok: true });
  } else if (req.type === 'BG_STOP_AGENT') {
    stopAgentExecution();
    rejectApprovals('execução interrompida');
    sendResponse({ ok: true });
  } else if (req.type === 'BG_GET_STATUS') {
    sendResponse({
      isRunning,
      currentChatId,
      events: currentEvents,
      history: executionHistory,
      pendingApprovals: [...pendingApprovals.values()].map(safeApprovalRequest),
      sessionId,
      panelConnectionId,
    });
  }
  return true;
});

chrome.runtime.onConnect?.addListener?.((port) => {
  if (port.name !== 'tom-panel') return;
  const connectionId = `port_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  panelConnectionId = connectionId;
  port.onDisconnect.addListener(() => {
    if (panelConnectionId === connectionId) {
      panelConnectionId = null;
      rejectApprovals('painel desconectado');
    }
  });
});

self.addEventListener('unload', () => rejectApprovals('service worker encerrado'));
