// Runner que sincroniza a UI com o Service Worker em background
export const AgentRunner = {
  isRunning: false,
  currentChatId: null,
  history: [],
  events: [],
  listeners: new Set(),

  init() {
    // Sincroniza estado com o background ao abrir o painel
    chrome.runtime.sendMessage({ type: 'BG_GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      this.isRunning = res.isRunning;
      this.currentChatId = res.currentChatId;
      this.events = res.events || [];
      this.history = res.history || [];
      this.events.forEach(ev => this.listeners.forEach(fn => fn(ev)));
    });

    // Ouve eventos contínuos do background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'BG_AGENT_EVENT') {
        if (msg.event.type === 'start') this.isRunning = true;
        if (msg.event.type === 'done' || msg.event.type === 'error') this.isRunning = false;
        this.events.push(msg.event);
        this.listeners.forEach(fn => fn(msg.event));
      }
    });
  },

  subscribe(fn) {
    this.listeners.add(fn);
    this.events.forEach(ev => fn(ev));
    return () => this.listeners.delete(fn);
  },

  start(text, teamMode = false) {
    this.isRunning = true;
    this.events = [];
    chrome.runtime.sendMessage({
      type: 'BG_START_AGENT',
      text,
      teamMode
    });
  }
};

AgentRunner.init();
