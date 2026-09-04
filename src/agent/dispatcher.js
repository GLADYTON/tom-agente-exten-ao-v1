// Dispatcher: tira do grafo as tarefas prontas e roda os agentes nelas.
//
// O que ele garante:
// - Respeita dependências — só inicia o que o TaskGraph disser que está pronto.
// - Paraleliza o que é independente, com teto (maxParallel).
// - Um arquivo por vez: duas tarefas que declaram o mesmo arquivo não rodam
//   juntas, senão a segunda escreveria por cima do staging da primeira.
// - Timeout por agente, cancelável.
// - NUNCA commita. O staging é compartilhado e a decisão de commit é do usuário.

import { EV } from './events.js';
import { TaskStatus, taskDuration } from './task.js';
import { registry } from './registry.js';
import { resolveModel } from './model.js';
import { runAgent } from './loop.js';

const DEFAULT_TIMEOUT = 240000;

// Só metadados vão para a timeline. Conteúdo de arquivo, old_str/new_str e
// qualquer corpo de texto ficam fora: log de UI não é lugar para o conteúdo dos
// arquivos do usuário.
function summarizeArgs(args = {}) {
  const out = {};
  if (args.path) out.path = args.path;
  if (Array.isArray(args.paths)) out.paths = args.paths;
  if (args.branch) out.branch = args.branch;
  if (args.title) out.title = String(args.title).slice(0, 120);
  if (args.message) out.message = String(args.message).slice(0, 120);
  return out;
}

function lastAssistantText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return '';
}

export class Dispatcher {
  constructor({ bus, graph, stage, providers, globalActive, maxParallel = 2, treeCache = new Map() }) {
    this.bus = bus;
    this.graph = graph;
    this.stage = stage;
    this.providers = providers;
    this.globalActive = globalActive;
    this.maxParallel = Math.max(1, maxParallel);
    this.treeCache = treeCache;
    this.running = new Map();   // taskId -> { task, signal, promise, timer }
    this.locks = new Map();     // caminho -> taskId
    this.touched = new Map();   // caminho -> taskId (detecção de conflito)
    this.cancelled = false;
  }

  // Arquivos que a tarefa declarou. Se outra tarefa em execução já pegou algum,
  // esta espera — evita duas escritas concorrentes no mesmo arquivo do staging.
  canLock(task) {
    return (task.files || []).every(p => !this.locks.has(p) || this.locks.get(p) === task.id);
  }

  lock(task) {
    for (const p of task.files || []) this.locks.set(p, task.id);
  }

  unlock(task) {
    for (const p of task.files || []) {
      if (this.locks.get(p) === task.id) this.locks.delete(p);
    }
  }

  // Traduz os eventos do loop.js para eventos do bus, já carimbados com a tarefa
  // e o agente. É aqui que card e timeline recebem tudo.
  makeRelay(task, agentDef) {
    const bus = this.bus;
    const base = { taskId: task.id, agentId: agentDef.id, agentName: agentDef.name, emoji: agentDef.emoji };

    return (ev) => {
      switch (ev.type) {
        case 'thinking':
          task.activity = 'analisando';
          bus.emit(EV.AGENT_PROGRESS, { ...base, activity: task.activity, iter: ev.iter });
          break;

        case 'assistant_text':
          // Texto parcial do agente. Não é raciocínio interno: é a resposta.
          bus.emit(EV.AGENT_TEXT, { ...base, text: ev.text });
          break;

        case 'tool_call': {
          task.toolCalls += 1;
          const args = summarizeArgs(ev.args);
          task.activity = args.path ? `${ev.name} · ${args.path}` : ev.name;
          bus.emit(EV.AGENT_TOOL_CALL, { ...base, name: ev.name, args, activity: task.activity });
          break;
        }

        case 'tool_result':
          bus.emit(EV.AGENT_TOOL_RESULT, { ...base, name: ev.name });
          break;

        case 'tool_error':
          bus.emit(EV.AGENT_TOOL_ERROR, { ...base, name: ev.name, error: ev.error });
          break;

        case 'file_change': {
          const path = ev.path;
          if (path && !task.filesTouched.includes(path)) task.filesTouched.push(path);
          // Dois agentes no mesmo arquivo: não bloqueia, mas o reviewer precisa saber.
          const prev = this.touched.get(path);
          if (path && prev && prev !== task.id) {
            bus.emit(EV.CONFLICT_DETECTED, {
              ...base, path, otherTaskId: prev,
              message: `${path} foi alterado por mais de uma tarefa.`,
            });
          }
          if (path) this.touched.set(path, task.id);
          bus.emit(EV.FILE_CHANGED, {
            ...base,
            path,
            branch: ev.branch,
            added: ev.added,
            removed: ev.removed,
            kind: ev.kind,
            message: ev.message ? String(ev.message).slice(0, 120) : '',
          });
          bus.emit(EV.STAGE_UPDATED, { size: this.stage?.size || 0 });
          break;
        }

        case 'usage':
          task.usage.input += ev.usage?.input || 0;
          task.usage.output += ev.usage?.output || 0;
          task.usage.cost += ev.cost || 0;
          bus.emit(EV.USAGE, { ...base, usage: ev.usage, cost: ev.cost });
          break;

        case 'retry':
          bus.emit(EV.NOTICE, { ...base, level: 'warn', message: `${ev.message} (${ev.attempt}/${ev.of})` });
          break;

        case 'error':
          bus.emit(EV.NOTICE, { ...base, level: 'error', message: ev.message });
          break;

        default:
          break;
      }
    };
  }

  // Roda uma tarefa até o fim. Não lança: falha vira status FAILED na tarefa,
  // porque uma tarefa quebrada não pode derrubar o run inteiro.
  async runTask(task) {
    const agentDef = registry.get(task.agentId);
    if (!agentDef) {
      this.graph.update(task.id, {
        status: TaskStatus.FAILED,
        error: `Agente "${task.agentId}" não existe no registry.`,
        completedAt: Date.now(),
      });
      this.bus.emit(EV.TASK_FAILED, { taskId: task.id, error: task.error });
      return task;
    }

    const { provider, model } = resolveModel(this.providers, agentDef, this.globalActive);
    if (!model) {
      this.graph.update(task.id, {
        status: TaskStatus.FAILED,
        error: 'Nenhum modelo resolvido para este agente.',
        completedAt: Date.now(),
      });
      this.bus.emit(EV.TASK_FAILED, { taskId: task.id, agentId: agentDef.id, error: task.error });
      return task;
    }

    const base = { taskId: task.id, agentId: agentDef.id, agentName: agentDef.name, emoji: agentDef.emoji };

    this.graph.update(task.id, { status: TaskStatus.WORKING, startedAt: Date.now(), activity: 'iniciando' });
    this.lock(task);
    this.bus.emit(EV.TASK_STARTED, { ...base, description: task.description });
    this.bus.emit(EV.AGENT_STARTED, { ...base, description: task.description, files: task.files });

    // AbortController próprio: o timeout e o cancel do supervisor usam o mesmo canal.
    const ac = new AbortController();
    const timeoutMs = agentDef.timeoutMs || DEFAULT_TIMEOUT;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      ac.signal.reason = `tempo limite de ${Math.round(timeoutMs / 1000)}s`;
      this.bus.emit(EV.AGENT_TIMEOUT, { ...base, timeoutMs });
    }, timeoutMs);

    this.running.set(task.id, { task, abort: () => ac.abort(), signal: ac.signal });

    try {
      const out = await runAgent({
        provider,
        model,
        agent: agentDef,
        userMessage: task.description,
        history: [],
        signal: ac.signal,
        stage: this.stage,
        overrides: {
          autoCommit: false,
          autoReview: false,
          maxIterations: agentDef.maxIterations,
          treeCache: this.treeCache,
          extraSystem: task.contextNote || '',
        },
        onEvent: this.makeRelay(task, agentDef),
      });

      const text = lastAssistantText(out.messages);

      if (timedOut) {
        this.graph.update(task.id, {
          status: TaskStatus.FAILED,
          error: `Interrompido por tempo limite (${Math.round(timeoutMs / 1000)}s).`,
          result: text || null,
          progress: 100,
          completedAt: Date.now(),
          activity: '',
        });
        this.bus.emit(EV.TASK_FAILED, { ...base, error: task.error });
        this.bus.emit(EV.AGENT_FAILED, { ...base, error: task.error });
      } else if (out.stopReason === 'cancelled') {
        this.graph.update(task.id, {
          status: TaskStatus.CANCELLED, result: text || null, completedAt: Date.now(), activity: '',
        });
        this.bus.emit(EV.TASK_CANCELLED, { ...base });
      } else {
        this.graph.update(task.id, {
          status: TaskStatus.COMPLETED,
          result: text || '(sem resumo do agente)',
          progress: 100,
          completedAt: Date.now(),
          activity: '',
          stopReason: out.stopReason,
        });
        this.bus.emit(EV.TASK_COMPLETED, {
          ...base, result: task.result, stopReason: out.stopReason,
          files: task.filesTouched, durationMs: taskDuration(task),
        });
        this.bus.emit(EV.AGENT_COMPLETED, {
          ...base, result: task.result, files: task.filesTouched,
          usage: task.usage, durationMs: taskDuration(task),
        });
      }
    } catch (e) {
      this.graph.update(task.id, {
        status: TaskStatus.FAILED, error: e.message, completedAt: Date.now(), activity: '',
      });
      this.bus.emit(EV.TASK_FAILED, { ...base, error: e.message });
      this.bus.emit(EV.AGENT_FAILED, { ...base, error: e.message });
    } finally {
      clearTimeout(timer);
      this.running.delete(task.id);
      this.unlock(task);
      // Dependentes de uma tarefa que morreu não podem esperar para sempre.
      this.graph.settleBlocked().forEach(t => {
        this.bus.emit(EV.TASK_BLOCKED, { taskId: t.id, agentId: t.agentId, reason: t.error });
      });
    }

    return task;
  }

  // Laço principal: enquanto houver tarefa não terminal, preenche as vagas
  // livres com o que está pronto e espera a primeira terminar.
  async run() {
    const inflight = new Map();   // taskId -> Promise

    while (!this.cancelled) {
      const pending = this.graph.pending();
      if (!pending.length) break;

      let launched = 0;
      for (const task of this.graph.ready()) {
        if (inflight.size >= this.maxParallel) break;
        if (!this.canLock(task)) continue;

        const p = this.runTask(task).finally(() => inflight.delete(task.id));
        inflight.set(task.id, p);
        launched += 1;
      }

      if (inflight.size === 0) {
        // Nada rodando e nada lançado: ou é ciclo, ou é lock impossível de
        // satisfazer. Em vez de girar em falso, marca e sai.
        if (!launched) {
          const stuck = this.graph.pending();
          const cycle = this.graph.findCycle();
          if (cycle) {
            this.graph.breakCycles();
            this.bus.emit(EV.NOTICE, {
              level: 'warn',
              message: `Dependência circular resolvida: ${cycle.join(' → ')}`,
            });
            continue;
          }
          for (const t of stuck) {
            this.graph.update(t.id, {
              status: TaskStatus.BLOCKED,
              error: 'Não foi possível executar: dependências ou arquivos travados.',
              completedAt: Date.now(),
            });
            this.bus.emit(EV.TASK_BLOCKED, { taskId: t.id, agentId: t.agentId, reason: t.error });
          }
          break;
        }
        continue;
      }

      await Promise.race(inflight.values());
    }

    // Cancelamento: espera as em voo terminarem em vez de deixar promise órfã
    // escrevendo no staging depois do run.
    if (inflight.size) await Promise.allSettled(inflight.values());

    return this.graph.summary();
  }

  cancel(reason = 'cancelado pelo usuário') {
    this.cancelled = true;
    for (const { task, abort, signal } of this.running.values()) {
      signal.reason = reason;
      abort();
      this.bus.emit(EV.NOTICE, { taskId: task.id, level: 'warn', message: `Cancelando ${task.agentId}: ${reason}` });
    }
    for (const t of this.graph.pending()) {
      if (t.status === TaskStatus.WORKING) continue;
      this.graph.update(t.id, { status: TaskStatus.CANCELLED, completedAt: Date.now() });
      this.bus.emit(EV.TASK_CANCELLED, { taskId: t.id, agentId: t.agentId, reason });
    }
  }
}

export default Dispatcher;