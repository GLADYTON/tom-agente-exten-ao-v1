// Barramento de eventos da execução multiagente.
//
// O loop.js já emitia eventos via onEvent, mas cada chamada tinha um único
// consumidor: a view que a disparou. Com vários agentes rodando ao mesmo tempo,
// o mesmo evento precisa chegar em lugares diferentes (card do agente, timeline,
// contador de custo, supervisor). O EventBus resolve isso sem que o dispatcher
// precise conhecer a UI.
//
// Não é global: cada execução cria o seu, então duas execuções não se misturam
// e o log morre junto com a execução.

export const EV = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_COMPLETED: 'RUN_COMPLETED',
  RUN_FAILED: 'RUN_FAILED',
  RUN_CANCELLED: 'RUN_CANCELLED',

  PLAN_STARTED: 'PLAN_STARTED',
  PLAN_READY: 'PLAN_READY',
  PLAN_FALLBACK: 'PLAN_FALLBACK',

  TASK_CREATED: 'TASK_CREATED',
  TASK_STARTED: 'TASK_STARTED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_FAILED: 'TASK_FAILED',
  TASK_CANCELLED: 'TASK_CANCELLED',
  TASK_BLOCKED: 'TASK_BLOCKED',

  AGENT_STARTED: 'AGENT_STARTED',
  AGENT_PROGRESS: 'AGENT_PROGRESS',
  AGENT_TEXT: 'AGENT_TEXT',
  AGENT_TOOL_CALL: 'AGENT_TOOL_CALL',
  AGENT_TOOL_RESULT: 'AGENT_TOOL_RESULT',
  AGENT_TOOL_ERROR: 'AGENT_TOOL_ERROR',
  AGENT_COMPLETED: 'AGENT_COMPLETED',
  AGENT_FAILED: 'AGENT_FAILED',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',

  FILE_CHANGED: 'FILE_CHANGED',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  LOOP_DETECTED: 'LOOP_DETECTED',

  USAGE: 'USAGE',
  STAGE_UPDATED: 'STAGE_UPDATED',
  COMMIT_READY: 'COMMIT_READY',
  COMMIT_START: 'COMMIT_START',
  COMMIT_DONE: 'COMMIT_DONE',
  COMMIT_ERROR: 'COMMIT_ERROR',

  NOTICE: 'NOTICE',
};

const ALL = '*';

export class EventBus {
  constructor({ keepLog = 500 } = {}) {
    this.listeners = new Map();  // tipo -> Set<fn>
    this.log = [];
    this.keepLog = keepLog;
    this.seq = 0;
  }

  on(type, fn) {
    const key = type || ALL;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.off(key, fn);
  }

  // Recebe tudo. É o que a timeline e o supervisor usam.
  onAny(fn) {
    return this.on(ALL, fn);
  }

  off(type, fn) {
    this.listeners.get(type || ALL)?.delete(fn);
  }

  emit(type, payload = {}) {
    const ev = { type, at: Date.now(), seq: ++this.seq, ...payload };

    this.log.push(ev);
    if (this.log.length > this.keepLog) this.log.splice(0, this.log.length - this.keepLog);

    // Um listener que estoura não pode derrubar a execução nem impedir os
    // outros listeners de receberem o evento.
    for (const key of [type, ALL]) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try { fn(ev); } catch (e) { console.error('[EventBus]', type, e); }
      }
    }
    return ev;
  }

  history(filter) {
    if (!filter) return [...this.log];
    const types = new Set(Array.isArray(filter) ? filter : [filter]);
    return this.log.filter(e => types.has(e.type));
  }

  clear() {
    this.log = [];
  }
}
