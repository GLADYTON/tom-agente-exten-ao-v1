import { runAgent } from './agent/loop.js';
import { Orchestrator } from './agent/orchestrator.js';
import {
  getProviders, getActiveModel, getActiveAgent, getChats, saveChats, getActiveChatId, getRepo, getSettings
} from './storage.js';
import { requireLicense } from './license.js';
import { usageService } from './backend/index.js';

let webAbortController = null;
let webOrchestrator = null;

export const AgentRunner = {
  isRunning: false,
  currentChatId: null,
  history: [],
  events: [],
  listeners: new Set(),
  messageQueue: [],

  init() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'BG_GET_STATUS' }, (res) => {
          if (chrome.runtime?.lastError || !res) return;
          this.isRunning = res.isRunning;
          this.currentChatId = res.currentChatId;
          this.events = res.events || [];
          this.history = res.history || [];
          this.events.forEach(ev => this.listeners.forEach(fn => fn(ev)));
        });

        chrome.runtime.onMessage.addListener((msg) => {
          if (msg.type === 'BG_AGENT_EVENT') {
            if (msg.event.type === 'start') this.isRunning = true;
            if (msg.event.type === 'done' || msg.event.type === 'error' || msg.event.type === 'cancelled') {
              this.isRunning = false;
            }
            this.events.push(msg.event);
            this.listeners.forEach(fn => fn(msg.event));
            
            // Auto-process queue if done
            if (!this.isRunning && this.messageQueue.length > 0) {
              const next = this.messageQueue.shift();
              // Pequeno delay para garantir que a UI tenha tempo de renderizar o done anterior
              setTimeout(() => this.start(next.text, next.teamMode), 100);
            }
          }
        });
      }
    } catch {}
  },

  subscribe(fn) {
    this.listeners.add(fn);
    this.events.forEach(ev => fn(ev));
    return () => this.listeners.delete(fn);
  },

  emit(ev) {
    this.events.push(ev);
    this.listeners.forEach(fn => fn(ev));
  },

  async start(text, teamMode = false) {
    if (this.isRunning) {
      this.messageQueue.push({ text, teamMode });
      this.emit({ type: 'queue_add', text, queueCount: this.messageQueue.length });
      return;
    }

    this.isRunning = true;
    this.events = [];

    // Se estiver no ambiente de extensão Chrome
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'BG_START_AGENT',
        text,
        teamMode
      }).catch(err => {
        this.isRunning = false;
        this.emit({ type: 'error', message: 'Erro de comunicação com o background da extensão. Por favor, feche este painel e abra novamente, ou recarregue a extensão no chrome://extensions.' });
      });
      return;
    }

    // Fallback: Execução Web direta no navegador
    if (!(await requireLicense())) {
      this.emit({ type: 'error', message: 'Licença inválida ou expirada. Ative sua licença nas configurações.' });
      this.isRunning = false;
      this.emit({ type: 'done' });
      return;
    }

    webAbortController = new AbortController();
    this.currentChatId = await getActiveChatId();
    const allChats = await getChats();
    const activeChat = allChats.find(c => c.id === this.currentChatId);
    this.history = activeChat ? (activeChat.messages || []) : [];

    const [providers, globalActive, agent, repo, settings] = await Promise.all([
      getProviders(), getActiveModel(), getActiveAgent(), getRepo(), getSettings()
    ]);

    this.emit({ type: 'start', text });

    try {
      if (teamMode) {
        webOrchestrator = new Orchestrator();
        webOrchestrator.bus.on('*', (ev) => this.emit(ev));
        await webOrchestrator.run({ userMessage: text });
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
          history: this.history,
          signal: webAbortController.signal,
          onEvent: (ev) => this.emit(ev),
          onApproval: async (req) => true,
        });

        this.history = out.messages.filter(m => m.role !== 'system');
        usageService.record({
          request_id: `web_agent_${startedAt}`,
          model_id: model.id,
          gateway_id: provider.id,
          input_tokens: out.totalIn,
          output_tokens: out.totalOut,
          total_tokens: out.totalIn + out.totalOut,
          response_time_ms: Date.now() - startedAt,
          status: out.stopReason === 'error' ? 'error' : 'success',
        });
      }

      if (this.currentChatId) {
        const chats = await getChats();
        const idx = chats.findIndex(c => c.id === this.currentChatId);
        const chatObj = {
          id: this.currentChatId,
          title: this.history.find(m => m.role === 'user')?.content?.slice(0, 40) || 'Nova Conversa',
          updatedAt: new Date().toISOString(),
          messages: this.history,
        };
        if (idx >= 0) chats[idx] = chatObj;
        else chats.unshift(chatObj);
        await saveChats(chats);
      }
    } catch (err) {
      if (webAbortController?.signal?.aborted) {
        this.emit({ type: 'cancelled', message: 'Execução interrompida pelo usuário.' });
      } else {
        this.emit({ type: 'error', message: err.message });
      }
    } finally {
      this.isRunning = false;
      webAbortController = null;
      webOrchestrator = null;
      this.emit({ type: 'done' });
      
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift();
        setTimeout(() => this.start(next.text, next.teamMode), 100);
      }
    }
  },

  stop() {
    if (!this.isRunning) return;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'BG_STOP_AGENT' });
      } catch {}
    }
    if (webAbortController) webAbortController.abort('Parado pelo usuário');
    if (webOrchestrator) webOrchestrator.cancel('Parado pelo usuário');
    this.isRunning = false;
    this.emit({ type: 'cancelled', message: 'Execução interrompida pelo usuário.' });
  }
};

AgentRunner.init();

