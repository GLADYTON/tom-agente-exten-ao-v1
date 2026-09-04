// Supervisor: vigia o run. Determinístico — nenhuma chamada de modelo, nenhum
// custo. Só olha os eventos e avisa.
//
// O que ele pega:
// - Loop: o mesmo agente repetindo a mesma chamada de ferramenta com os mesmos
//   argumentos. É o modo de falha mais comum e o que mais queima tokens.
// - Parada: tarefa em WORKING sem emitir nada há muito tempo.
// - Conflito de arquivo: dois agentes no mesmo caminho.
// - Deadlock: nada rodando, nada pronto, mas ainda tem tarefa pendente.
//
// Ele avisa e registra. Cancelar é decisão do Orchestrator ou do usuário.

import { EV } from './events.js';

const REPEAT_LIMIT = 3;        // mesma chamada 3x = loop
const STALL_MS = 90000;        // 90s sem evento numa tarefa ativa
const TICK_MS = 15000;

function callSignature(ev) {
  const args = ev.args || {};
  const key = args.path || (Array.isArray(args.paths) ? args.paths.join('|') : '') || args.branch || '';
  return `${ev.agentId}::${ev.name}::${key}`;
}

export class Supervisor {
  constructor({ bus, graph, onIssue = null }) {
    this.bus = bus;
    this.graph = graph;
    this.onIssue = onIssue;
    this.unsub = null;
    this.timer = null;

    this.repeats = new Map();     // assinatura -> contagem
    this.warned = new Set();      // avisos já dados (não repetir)
    this.lastEventAt = new Map(); // taskId -> timestamp
    this.conflicts = new Map();   // caminho -> Set<taskId>
    this.issues = [];
  }

  attach() {
    this.unsub = this.bus.onAny(ev => this.observe(ev));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return this;
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(kind, message, extra = {}) {
    const issue = { kind, message, at: Date.now(), ...extra };
    this.issues.push(issue);
    this.onIssue?.(issue);
    return issue;
  }

  observe(ev) {
    if (ev.taskId) this.lastEventAt.set(ev.taskId, ev.at || Date.now());

    if (ev.type === EV.AGENT_TOOL_CALL) {
      const sig = callSignature(ev);
      const n = (this.repeats.get(sig) || 0) + 1;
      this.repeats.set(sig, n);

      if (n >= REPEAT_LIMIT && !this.warned.has(sig)) {
        this.warned.add(sig);
        const message = `${ev.agentName || ev.agentId} repetiu ${ev.name}${ev.args?.path ? ` em ${ev.args.path}` : ''} ${n} vezes. Pode estar em loop.`;
        this.record('loop', message, { taskId: ev.taskId, agentId: ev.agentId });
        this.bus.emit(EV.LOOP_DETECTED, {
          taskId: ev.taskId, agentId: ev.agentId, agentName: ev.agentName,
          name: ev.name, repeats: n, message,
        });
      }
      return;
    }

    if (ev.type === EV.CONFLICT_DETECTED) {
      const set = this.conflicts.get(ev.path) || new Set();
      set.add(ev.taskId);
      if (ev.otherTaskId) set.add(ev.otherTaskId);
      this.conflicts.set(ev.path, set);
      const key = `conflict:${ev.path}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.record('conflict', ev.message, { path: ev.path });
      }
      return;
    }

    if (ev.type === EV.AGENT_TOOL_ERROR) {
      const key = `toolerr:${ev.agentId}:${ev.name}:${ev.error}`;
      const n = (this.repeats.get(key) || 0) + 1;
      this.repeats.set(key, n);
      if (n >= REPEAT_LIMIT && !this.warned.has(key)) {
        this.warned.add(key);
        this.record('repeated_error', `${ev.agentName || ev.agentId} falhou ${n}x em ${ev.name}: ${ev.error}`, {
          taskId: ev.taskId, agentId: ev.agentId,
        });
      }
      return;
    }

    // Tarefa terminada não precisa mais de vigilância de parada.
    if (ev.type === EV.TASK_COMPLETED || ev.type === EV.TASK_FAILED
      || ev.type === EV.TASK_CANCELLED || ev.type === EV.TASK_BLOCKED) {
      this.lastEventAt.delete(ev.taskId);
    }
  }

  // Verificações que dependem de tempo, não de evento.
  tick() {
    const now = Date.now();

    for (const task of this.graph.running()) {
      const last = this.lastEventAt.get(task.id) || task.startedAt || now;
      const idle = now - last;
      const key = `stall:${task.id}:${Math.floor(idle / STALL_MS)}`;
      if (idle >= STALL_MS && !this.warned.has(key)) {
        this.warned.add(key);
        const message = `${task.agentId} está sem atividade há ${Math.round(idle / 1000)}s.`;
        this.record('stall', message, { taskId: task.id, idleMs: idle });
        this.bus.emit(EV.NOTICE, { taskId: task.id, agentId: task.agentId, level: 'warn', message });
      }
    }

    // Deadlock: sobrou tarefa pendente, nada rodando e nada elegível.
    const pending = this.graph.pending();
    if (pending.length && !this.graph.running().length && !this.graph.ready().length) {
      if (!this.warned.has('deadlock')) {
        this.warned.add('deadlock');
        const cycle = this.graph.findCycle();
        const message = cycle
          ? `Dependência circular entre tarefas: ${cycle.join(' → ')}.`
          : `${pending.length} tarefa(s) sem como executar.`;
        this.record('deadlock', message, { tasks: pending.map(t => t.id) });
        this.bus.emit(EV.NOTICE, { level: 'error', message });
      }
    }
  }

  // Resumo determinístico para o fim do run. Sem inventar nada: só o que foi
  // observado.
  report() {
    const byKind = {};
    for (const i of this.issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    return {
      total: this.issues.length,
      byKind,
      issues: [...this.issues],
      conflictedFiles: [...this.conflicts.keys()],
    };
  }
}

export default Supervisor;
