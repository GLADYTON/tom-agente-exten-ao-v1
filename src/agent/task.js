// Modelo de tarefa e grafo de dependências.
//
// Uma Task é a unidade que o Orchestrator cria e o Dispatcher executa. Ela
// carrega o agente responsável, as dependências e o resultado. O TaskGraph
// responde a única pergunta que o Dispatcher faz em loop: "o que pode rodar
// agora?".

export const TaskStatus = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  WORKING: 'working',
  WAITING_DEPENDENCY: 'waiting_dependency',
  WAITING_PERMISSION: 'waiting_permission',
  REVIEWING: 'reviewing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
};

// Estados em que a tarefa não vai mais mudar sozinha.
const TERMINAL = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.BLOCKED,
]);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

let counter = 0;

export function newTaskId() {
  counter += 1;
  return `task_${Date.now().toString(36)}_${counter}`;
}

export function createTask({
  id,
  parentTaskId = null,
  description,
  agentId,
  priority = 5,
  dependencies = [],
  files = [],
  risk = 'medium',
  kind = 'work',
  label = null,
  contextNote = '',
} = {}) {
  return {
    id: id || newTaskId(),
    parentTaskId,
    description: String(description || '').trim(),
    agentId,
    label,
    kind,                       // 'work' | 'review'
    status: TaskStatus.QUEUED,
    priority,
    dependencies: [...dependencies],
    files: [...files],
    risk,
    // Instrução extra injetada no system prompt do agente (ex.: o que os outros
    // agentes já mudaram). Fica separado da description para o card mostrar só
    // o pedido em si.
    contextNote,
    progress: 0,
    activity: '',               // última ação legível, mostrada no card
    toolCalls: 0,
    filesTouched: [],
    result: null,
    error: null,
    usage: { input: 0, output: 0, cost: 0 },
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
}

export function taskDuration(task) {
  if (!task.startedAt) return 0;
  return (task.completedAt || Date.now()) - task.startedAt;
}

export class TaskGraph {
  constructor(tasks = []) {
    this.tasks = new Map();
    for (const t of tasks) this.add(t);
  }

  add(task) {
    this.tasks.set(task.id, task);
    return task;
  }

  get(id) {
    return this.tasks.get(id);
  }

  get all() {
    return [...this.tasks.values()];
  }

  get size() {
    return this.tasks.size;
  }

  update(id, patch) {
    const t = this.tasks.get(id);
    if (!t) return null;
    Object.assign(t, patch);
    return t;
  }

  // Dependências satisfeitas = todas COMPLETED. Se alguma falhou/foi cancelada,
  // a tarefa não fica esperando para sempre: vira BLOCKED (ver settleBlocked).
  isReady(task) {
    if (task.status !== TaskStatus.QUEUED && task.status !== TaskStatus.WAITING_DEPENDENCY) return false;
    return task.dependencies.every(depId => {
      const dep = this.tasks.get(depId);
      // Dependência inexistente não travaria nada: trata como satisfeita.
      return !dep || dep.status === TaskStatus.COMPLETED;
    });
  }

  ready() {
    return this.all
      .filter(t => this.isReady(t))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  }

  // Tarefas cuja dependência morreu: marca BLOCKED e propaga em cascata.
  settleBlocked() {
    const blocked = [];
    let changed = true;

    while (changed) {
      changed = false;
      for (const t of this.all) {
        if (isTerminal(t.status) || t.status === TaskStatus.WORKING) continue;
        const dead = t.dependencies
          .map(id => this.tasks.get(id))
          .filter(dep => dep && dep.status !== TaskStatus.COMPLETED && isTerminal(dep.status));
        if (dead.length) {
          t.status = TaskStatus.BLOCKED;
          t.error = `Dependência não concluída: ${dead.map(d => d.id).join(', ')}`;
          t.completedAt = Date.now();
          blocked.push(t);
          changed = true;
        }
      }
    }
    return blocked;
  }

  running() {
    return this.all.filter(t => t.status === TaskStatus.WORKING);
  }

  pending() {
    return this.all.filter(t => !isTerminal(t.status));
  }

  get done() {
    return this.all.every(t => isTerminal(t.status));
  }

  // Dependência circular deixaria o Dispatcher sem tarefas prontas e sem
  // tarefas rodando — trava silenciosa. Detecta antes de executar.
  findCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(this.all.map(t => [t.id, WHITE]));
    const stack = [];
    let found = null;

    const visit = (id) => {
      if (found) return;
      const task = this.tasks.get(id);
      if (!task) return;
      color.set(id, GRAY);
      stack.push(id);
      for (const dep of task.dependencies) {
        if (!this.tasks.has(dep)) continue;
        if (color.get(dep) === GRAY) {
          found = [...stack.slice(stack.indexOf(dep)), dep];
          return;
        }
        if (color.get(dep) === WHITE) visit(dep);
        if (found) return;
      }
      stack.pop();
      color.set(id, BLACK);
    };

    for (const t of this.all) {
      if (color.get(t.id) === WHITE) visit(t.id);
      if (found) break;
    }
    return found;
  }

  // Quebra ciclos removendo a aresta que fecha o laço. Melhor rodar em ordem
  // possivelmente errada que travar a execução inteira.
  breakCycles() {
    const broken = [];
    let cycle = this.findCycle();
    let guard = 0;
    while (cycle && guard++ < 50) {
      const from = this.tasks.get(cycle[cycle.length - 2]);
      const to = cycle[cycle.length - 1];
      if (!from) break;
      from.dependencies = from.dependencies.filter(d => d !== to);
      broken.push({ from: from.id, to });
      cycle = this.findCycle();
    }
    return broken;
  }

  summary() {
    const by = {};
    for (const t of this.all) by[t.status] = (by[t.status] || 0) + 1;
    return {
      total: this.size,
      byStatus: by,
      completed: by[TaskStatus.COMPLETED] || 0,
      failed: (by[TaskStatus.FAILED] || 0) + (by[TaskStatus.BLOCKED] || 0),
    };
  }
}
