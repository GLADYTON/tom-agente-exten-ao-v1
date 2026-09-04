// Orchestrator: dono do run multiagente.
//
// Fluxo: pedido → Planner → TaskGraph → Dispatcher (paralelo) → Code Review →
// staging pronto para o usuário decidir.
//
// Regras que ele garante e que ninguém abaixo dele pode contornar:
// - UM staging para todos os agentes do run.
// - NENHUM commit automático. No fim emite COMMIT_READY e para. Commitar é ação
//   explícita do usuário na UI.
// - A revisão só entra se houve escrita de verdade.

import { EventBus, EV } from './events.js';
import { TaskGraph, TaskStatus, createTask, isTerminal } from './task.js';
import { Dispatcher } from './dispatcher.js';
import { registry, REVIEWER_ID } from './registry.js';
import { Stage, changeKindLabel, buildCommitMessage } from './stage.js';
import { plan as planTasks } from './planner.js';
import { Supervisor } from './supervisor.js';
import * as gh from '../github.js';
import { getProviders, getActiveModel, getRepo, getSettings } from '../storage.js';
import { resolveModel } from './model.js';

export class Orchestrator {
  constructor({ bus } = {}) {
    this.bus = bus || new EventBus();
    this.graph = new TaskGraph();
    this.stage = null;
    this.dispatcher = null;
    this.supervisor = null;
    this.repo = null;
    this.running = false;
  }

  cancel(reason = 'cancelado pelo usuário') {
    this.dispatcher?.cancel(reason);
    this.bus.emit(EV.RUN_CANCELLED, { reason });
  }

  // Contexto que o revisor recebe: o que mudou e quem mudou, sem conteúdo de
  // arquivo. Ele lê os arquivos por conta própria (e vê o staging).
  buildReviewDescription(workTasks) {
    const changes = this.stage.summary()
      .map(c => `- ${c.path} (${changeKindLabel(c.kind)}, +${c.added}/-${c.removed})`)
      .join('\n');

    const done = workTasks
      .filter(t => t.status === TaskStatus.COMPLETED)
      .map(t => `- ${registry.get(t.agentId)?.name || t.agentId}: ${t.description}`)
      .join('\n');

    const conflicts = this.bus.history(EV.CONFLICT_DETECTED)
      .map(e => `- ${e.path} foi tocado por mais de um agente.`)
      .join('\n');

    return [
      'Revise as mudanças que a equipe acabou de fazer neste repositório.',
      '',
      'O que foi pedido a cada agente:',
      done || '- (sem tarefas concluídas)',
      '',
      'Arquivos alterados (em staging, não commitados):',
      changes || '- (nenhum)',
      conflicts ? `\nAtenção:\n${conflicts}` : '',
      '',
      'Leia os arquivos alterados com read_file antes de opinar. Não invente problemas.',
    ].filter(Boolean).join('\n');
  }

  async run({ userMessage, maxParallel } = {}) {
    if (this.running) throw new Error('Já existe uma execução em andamento.');
    this.running = true;

    const [providers, globalActive, repo, settings] = await Promise.all([
      getProviders(), getActiveModel(), getRepo(), getSettings(),
    ]);
    this.repo = repo;

    const { provider, model } = resolveModel(providers, null, globalActive);
    if (!model) {
      this.running = false;
      const message = 'Nenhum modelo ativo. Escolha um na aba Modelos.';
      this.bus.emit(EV.RUN_FAILED, { message });
      throw new Error(message);
    }
    if (!repo) {
      this.running = false;
      const message = 'Nenhum repositório ativo. Selecione um na aba Repos.';
      this.bus.emit(EV.RUN_FAILED, { message });
      throw new Error(message);
    }

    this.stage = new Stage(repo.branch);
    const treeCache = new Map();

    this.bus.emit(EV.RUN_STARTED, {
      message: userMessage,
      repo: repo.fullName,
      branch: repo.branch,
      model: model.label || model.id,
    });

    this.supervisor = new Supervisor({ bus: this.bus, graph: this.graph });
    this.supervisor.attach();

    try {
      // --- Planejamento
      const { tasks, intent, source } = await planTasks({
        provider, model, userMessage, repo, bus: this.bus,
      });

      for (const t of tasks) {
        this.graph.add(t);
        const def = registry.get(t.agentId);
        this.bus.emit(EV.TASK_CREATED, {
          taskId: t.id, agentId: t.agentId,
          agentName: def?.name, emoji: def?.emoji,
          description: t.description, dependencies: t.dependencies,
        });
      }

      this.dispatcher = new Dispatcher({
        bus: this.bus,
        graph: this.graph,
        stage: this.stage,
        providers,
        globalActive,
        treeCache,
        maxParallel: maxParallel || settings.maxParallelAgents || 2,
      });

      // --- Execução das tarefas de trabalho
      await this.dispatcher.run();

      const workTasks = this.graph.all.filter(t => t.kind === 'work');

      // --- Revisão: só faz sentido se algo foi realmente escrito.
      const wrote = this.stage.size > 0;
      const reviewEnabled = settings.autoReview !== false;

      if (wrote && reviewEnabled && !this.dispatcher.cancelled) {
        const reviewTask = createTask({
          agentId: REVIEWER_ID,
          kind: 'review',
          description: this.buildReviewDescription(workTasks),
          // Só as concluídas. Se uma tarefa falhou mas outra escreveu, a revisão
          // ainda precisa acontecer — depender da que falhou marcaria o review
          // como BLOCKED e deixaria código sem revisão no staging.
          dependencies: workTasks.filter(t => t.status === TaskStatus.COMPLETED).map(t => t.id),
          priority: 9,
          risk: 'low',
        });
        this.graph.add(reviewTask);
        const def = registry.get(REVIEWER_ID);
        this.bus.emit(EV.TASK_CREATED, {
          taskId: reviewTask.id, agentId: REVIEWER_ID,
          agentName: def?.name, emoji: def?.emoji,
          description: 'Revisar as mudanças em staging',
          dependencies: reviewTask.dependencies,
        });
        // O reviewer roda sozinho: precisa ver o staging completo.
        this.dispatcher.maxParallel = 1;
        await this.dispatcher.run();
      }

      // --- Fim. O staging fica pendente; commitar é decisão do usuário.
      const summary = this.graph.summary();
      const staged = this.stage.summary();

      if (staged.length) {
        this.bus.emit(EV.COMMIT_READY, {
          count: staged.length,
          files: staged,
          branch: repo.branch,
          repo: repo.fullName,
        });
      }

      this.bus.emit(EV.RUN_COMPLETED, {
        intent, planSource: source, summary,
        staged: staged.length,
        cost: this.graph.all.reduce((a, t) => a + (t.usage?.cost || 0), 0),
      });

      return { summary, staged, tasks: this.graph.all, intent };
    } catch (e) {
      this.bus.emit(EV.RUN_FAILED, { message: e.message });
      throw e;
    } finally {
      this.supervisor?.detach();
      this.running = false;
    }
  }

  get pendingTasks() {
    return this.graph.all.filter(t => !isTerminal(t.status));
  }

  get stagedFiles() {
    return this.stage ? this.stage.summary() : [];
  }

  // Commit do staging. Só roda a partir de ação explícita do usuário na UI: o
  // Orchestrator nunca chama isto por conta própria, e sem `confirmed` recusa.
  async commitStaged({ confirmed = false } = {}) {
    if (!this.stage?.size) return [];
    if (!confirmed) throw new Error('Commit requer confirmação explícita do usuário.');

    const [owner, repoName] = this.repo.fullName.split('/');
    const groups = this.stage.byBranch();
    const done = [];

    for (const [branch, entries] of groups) {
      const files = entries.map(e => e.action === 'delete'
        ? { path: e.path, action: 'delete' }
        : { path: e.path, content: e.content });

      this.bus.emit(EV.COMMIT_START, { branch, count: files.length });
      try {
        const res = await gh.createCommit(owner, repoName, branch, files, buildCommitMessage(entries));
        this.stage.clear(entries.map(e => e.path));
        this.stage.commits.push(res);
        for (const e of entries) {
          if (e.action === 'delete') this.stage.cache.delete(e.path);
          else this.stage.remember(e.path, { text: e.content, sha: undefined, existed: true });
        }
        done.push(res);
        this.bus.emit(EV.COMMIT_DONE, {
          sha: res.sha, url: res.url, branch,
          count: files.length, files: entries.map(e => e.path),
        });
      } catch (e) {
        // Staging preservado: o usuário pode tentar de novo.
        this.bus.emit(EV.COMMIT_ERROR, { branch, error: e.message, count: files.length });
        throw e;
      }
    }
    return done;
  }

  discardStaged() {
    const n = this.stage?.size || 0;
    this.stage?.clear();
    this.bus.emit(EV.STAGE_UPDATED, { size: 0, discarded: n });
    return n;
  }
}

export default Orchestrator;
