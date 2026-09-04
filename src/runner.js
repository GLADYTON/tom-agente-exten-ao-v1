import { runAgent } from './agent/loop.js';
import { getProviders, getActiveModel, getActiveAgent, getChats, saveChats, getActiveChatId } from './storage.js';

// Estado global da execução do agente (sobrevive à troca de abas)
export const AgentRunner = {
  isRunning: false,
  currentChatId: null,
  history: [],
  events: [], // Fila de eventos do turno atual para re-renderizar se a aba for reaberta
  listeners: new Set(),
  
  subscribe(fn) {
    this.listeners.add(fn);
    // Dispara os eventos passados para a nova view se atualizar
    this.events.forEach(ev => fn(ev));
    return () => this.listeners.delete(fn);
  },

  emit(ev) {
    this.events.push(ev);
    this.listeners.forEach(fn => fn(ev));
  },

  async saveCurrentChat() {
    if (!this.currentChatId) return;
    const allChats = await getChats();
    const idx = allChats.findIndex(c => c.id === this.currentChatId);
    
    const chatObj = {
      id: this.currentChatId,
      title: this.history.find(m => m.role === 'user')?.content?.slice(0, 40) || 'Nova Conversa',
      updatedAt: new Date().toISOString(),
      messages: this.history
    };

    if (idx >= 0) {
      allChats[idx] = chatObj;
    } else {
      allChats.unshift(chatObj);
    }
    await saveChats(allChats);
  },

  async start(text, onApprovalCallback) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.events = []; // Limpa eventos do turno anterior
    
    this.currentChatId = await getActiveChatId();
    const allChats = await getChats();
    const activeChat = allChats.find(c => c.id === this.currentChatId);
    this.history = activeChat ? (activeChat.messages || []) : [];

    const [providers, globalActive, agent] = await Promise.all([
      getProviders(), getActiveModel(), getActiveAgent()
    ]);

    const providerRef = agent?.modelRef?.providerId || globalActive?.providerId;
    const modelRef = agent?.modelRef?.modelId || globalActive?.modelId;
    const provider = providers.find(p => p.id === providerRef);
    const model = provider?.models?.find(m => m.id === modelRef);

    if (!provider || !model) {
      this.emit({ type: 'error', message: 'Provedor ou modelo não encontrado.' });
      this.isRunning = false;
      return;
    }

    this.emit({ type: 'start', text });

    try {
      const out = await runAgent({
        provider, model, agent,
        userMessage: text,
        history: this.history,
        onApproval: async (req) => {
          // Se a view do chat estiver fechada, o onApprovalCallback pode não existir.
          // Precisamos emitir um evento especial e esperar a resposta.
          return new Promise((resolve) => {
            this.emit({ type: 'approval_request', req, resolve });
          });
        },
        onEvent: (ev) => this.emit(ev),
      });
      
      this.history = out.messages.filter(mm => mm.role !== 'system');
      await this.saveCurrentChat();
    } catch (e) {
      this.emit({ type: 'error', message: e.message });
    } finally {
      this.isRunning = false;
      this.emit({ type: 'done' });
    }
  }
};
