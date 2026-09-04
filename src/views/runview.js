// UI de uma execução multiagente: Agent Cards + Activity Timeline.
//
// Assina o EventBus do run e vai atualizando os nós no lugar. Nada de re-render
// completo a cada evento: com 3 agentes escrevendo ao mesmo tempo isso pisca.
//
// Mostra ação, decisão, evidência, resultado, erro e progresso. Não mostra
// raciocínio interno do modelo.

import { el, clear, renderInlineMd, fmtCost, fmtTokens } from '../util/dom.js';
import { EV } from '../agent/events.js';
import { TaskStatus } from '../agent/task.js';

const STATUS_LABEL = {
  [TaskStatus.QUEUED]: 'na fila',
  [TaskStatus.WAITING_DEPENDENCY]: 'aguardando',
  [TaskStatus.WORKING]: 'trabalhando',
  [TaskStatus.COMPLETED]: 'concluído',
  [TaskStatus.FAILED]: 'falhou',
  [TaskStatus.CANCELLED]: 'cancelado',
  [TaskStatus.BLOCKED]: 'bloqueado',
};

const STATUS_CLASS = {
  [TaskStatus.QUEUED]: 'queued',
  [TaskStatus.WAITING_DEPENDENCY]: 'queued',
  [TaskStatus.WORKING]: 'working',
  [TaskStatus.COMPLETED]: 'ok',
  [TaskStatus.FAILED]: 'err',
  [TaskStatus.CANCELLED]: 'muted',
  [TaskStatus.BLOCKED]: 'err',
};

function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function shortTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function createRunView() {
  const cardsWrap = el('div', { class: 'agent-cards' });
  const timelineList = el('div', { class: 'timeline-list' });

  const timelineCount = el('span', { class: 'pill' }, '0 eventos');
  const timelineBox = el('details', { class: 'timeline-box' }, [
    el('summary', { class: 'timeline-summary' }, [
      el('span', {}, '📡 Atividade'),
      timelineCount,
    ]),
    timelineList,
  ]);

  const planNote = el('div', { class: 'run-plan hidden' });
  const footer = el('div', { class: 'run-footer hidden' });

  const root = el('div', { class: 'run-view' }, [planNote, cardsWrap, timelineBox, footer]);

  const cards = new Map();   // taskId -> { node, refs }

  // --- Agent Card: um por tarefa.
  function buildCard(ev) {
    const statusPill = el('span', { class: 'ac-status queued' }, STATUS_LABEL[TaskStatus.QUEUED]);
    const activity = el('div', { class: 'ac-activity' }, 'na fila');
    const bar = el('div', { class: 'ac-bar-fill' });
    const filesBox = el('div', { class: 'ac-files' });
    const resultBox = el('div', { class: 'ac-result hidden' });
    const metaBox = el('div', { class: 'ac-meta' });

    const node = el('div', { class: 'agent-card', 'data-task': ev.taskId }, [
      el('div', { class: 'ac-head' }, [
        el('span', { class: 'ac-emoji' }, ev.emoji || '🤖'),
        el('div', { class: 'ac-ident' }, [
          el('div', { class: 'ac-name' }, ev.agentName || ev.agentId),
          el('div', { class: 'ac-task' }, ev.description || ''),
        ]),
        statusPill,
      ]),
      el('div', { class: 'ac-bar' }, [bar]),
      activity,
      filesBox,
      resultBox,
      metaBox,
    ]);

    const refs = { statusPill, activity, bar, filesBox, resultBox, metaBox, files: new Set() };
    cards.set(ev.taskId, { node, refs });
    cardsWrap.appendChild(node);
    return refs;
  }

  function card(taskId) {
    return cards.get(taskId)?.refs || null;
  }

  function setStatus(taskId, status, activityText) {
    const c = card(taskId);
    if (!c) return;
    c.statusPill.textContent = STATUS_LABEL[status] || status;
    c.statusPill.className = `ac-status ${STATUS_CLASS[status] || 'queued'}`;
    if (activityText != null) c.activity.textContent = activityText;
  }

  // Sem progresso real do modelo, a barra reflete atividade: cada chamada de
  // ferramenta avança um pouco, e o fim crava 100%. Melhor que barra falsa.
  function bumpProgress(taskId) {
    const c = card(taskId);
    if (!c) return;
    const cur = parseFloat(c.bar.dataset.p || '8');
    const next = Math.min(88, cur + 9);
    c.bar.dataset.p = String(next);
    c.bar.style.width = `${next}%`;
  }

  function addFile(taskId, ev) {
    const c = card(taskId);
    if (!c || !ev.path) return;
    if (c.files.has(ev.path)) return;
    c.files.add(ev.path);
    c.filesBox.appendChild(el('span', { class: 'ac-file', title: ev.path }, [
      el('span', { class: 'ac-file-path' }, ev.path),
      el('span', { class: 'ac-file-diff' }, `+${ev.added || 0}/-${ev.removed || 0}`),
    ]));
  }

  // --- Activity Timeline: linha por evento relevante.
  let events = 0;

  function line(icon, text, cls = '', who = '') {
    events += 1;
    timelineCount.textContent = `${events} evento${events === 1 ? '' : 's'}`;
    const row = el('div', { class: `tl-row ${cls}` }, [
      el('span', { class: 'tl-time' }, shortTime(Date.now())),
      el('span', { class: 'tl-icon' }, icon),
      who ? el('span', { class: 'tl-who' }, who) : null,
      el('span', { class: 'tl-text' }, text),
    ]);
    timelineList.appendChild(row);
    // Só cresce até um limite: a timeline de um run longo não pode virar leak.
    while (timelineList.childElementCount > 200) timelineList.removeChild(timelineList.firstChild);
    timelineList.scrollTop = timelineList.scrollHeight;
    return row;
  }

  // --- Assinatura do bus. Um handler por tipo; o resto é ignorado de propósito.
  function attach(bus) {
    const off = [];
    let totalCost = 0, totalTk = 0;

    off.push(bus.on(EV.RUN_STARTED, (ev) => {
      line('🚀', `Execução iniciada em ${ev.repo} @ ${ev.branch}`, 'accent');
    }));

    off.push(bus.on(EV.PLAN_STARTED, () => line('🧭', 'Planejando e dividindo o trabalho...')));

    off.push(bus.on(EV.PLAN_READY, (ev) => {
      const n = ev.tasks?.length || 0;
      line('🧭', `Plano: ${n} tarefa${n === 1 ? '' : 's'}${ev.source === 'heuristic' ? ' (divisão por área)' : ''}`, 'accent');
      if (ev.intent) {
        planNote.classList.remove('hidden');
        planNote.textContent = ev.intent;
      }
    }));

    off.push(bus.on(EV.PLAN_FALLBACK, (ev) => line('⚠️', ev.reason, 'warn')));

    off.push(bus.on(EV.TASK_CREATED, (ev) => {
      buildCard(ev);
      const waiting = ev.dependencies?.length;
      setStatus(ev.taskId, waiting ? TaskStatus.WAITING_DEPENDENCY : TaskStatus.QUEUED,
        waiting ? 'aguardando outra tarefa' : 'na fila');
      line('📋', `${ev.agentName || ev.agentId}: ${ev.description}`, '', ev.emoji);
    }));

    off.push(bus.on(EV.TASK_STARTED, (ev) => {
      setStatus(ev.taskId, TaskStatus.WORKING, 'iniciando');
      const c = card(ev.taskId);
      if (c) { c.bar.dataset.p = '8'; c.bar.style.width = '8%'; }
      line('▶️', `${ev.agentName || ev.agentId} começou`, 'accent', ev.emoji);
    }));

    off.push(bus.on(EV.AGENT_PROGRESS, (ev) => setStatus(ev.taskId, TaskStatus.WORKING, ev.activity || 'analisando')));

    off.push(bus.on(EV.AGENT_TOOL_CALL, (ev) => {
      setStatus(ev.taskId, TaskStatus.WORKING, ev.activity || ev.name);
      bumpProgress(ev.taskId);
      const target = ev.args?.path || (ev.args?.paths?.length ? `${ev.args.paths.length} arquivos` : '');
      line('🔧', `${ev.name}${target ? ` · ${target}` : ''}`, '', ev.emoji);
    }));

    off.push(bus.on(EV.AGENT_TOOL_ERROR, (ev) => {
      line('✗', `${ev.name} falhou: ${ev.error}`, 'err', ev.emoji);
    }));

    off.push(bus.on(EV.FILE_CHANGED, (ev) => {
      addFile(ev.taskId, ev);
      line('📝', `${ev.path} (+${ev.added || 0}/-${ev.removed || 0})`, 'ok', ev.emoji);
    }));

    off.push(bus.on(EV.CONFLICT_DETECTED, (ev) => line('⚠️', ev.message, 'warn', ev.emoji)));

    off.push(bus.on(EV.LOOP_DETECTED, (ev) => line('🔁', ev.message, 'warn', ev.emoji)));

    off.push(bus.on(EV.USAGE, (ev) => {
      totalTk += (ev.usage?.input || 0) + (ev.usage?.output || 0);
      totalCost += ev.cost || 0;
      const c = card(ev.taskId);
      if (c) c.metaBox.textContent = `${fmtTokens((ev.usage?.input || 0) + (ev.usage?.output || 0))} tk neste passo`;
      footer.dataset.cost = String(totalCost);
      footer.dataset.tk = String(totalTk);
    }));

    off.push(bus.on(EV.TASK_COMPLETED, (ev) => {
      setStatus(ev.taskId, TaskStatus.COMPLETED, '');
      const c = card(ev.taskId);
      if (c) {
        c.bar.style.width = '100%';
        c.bar.dataset.p = '100';
        if (ev.result) {
          c.resultBox.classList.remove('hidden');
          c.resultBox.innerHTML = renderInlineMd(ev.result);
        }
        const parts = [];
        if (ev.files?.length) parts.push(`${ev.files.length} arquivo(s)`);
        if (ev.durationMs) parts.push(fmtDur(ev.durationMs));
        c.metaBox.textContent = parts.join(' · ');
      }
      line('✅', `${ev.agentName || ev.agentId} concluiu${ev.durationMs ? ` em ${fmtDur(ev.durationMs)}` : ''}`, 'ok', ev.emoji);
    }));

    off.push(bus.on(EV.TASK_FAILED, (ev) => {
      setStatus(ev.taskId, TaskStatus.FAILED, ev.error || 'falhou');
      const c = card(ev.taskId);
      if (c) { c.bar.style.width = '100%'; c.bar.classList.add('err'); }
      line('❌', `${ev.agentName || ev.agentId}: ${ev.error}`, 'err', ev.emoji);
    }));

    off.push(bus.on(EV.TASK_BLOCKED, (ev) => {
      setStatus(ev.taskId, TaskStatus.BLOCKED, ev.reason || 'bloqueado');
      line('⛔', `Tarefa bloqueada: ${ev.reason || ''}`, 'err');
    }));

    off.push(bus.on(EV.TASK_CANCELLED, (ev) => {
      setStatus(ev.taskId, TaskStatus.CANCELLED, 'cancelado');
      line('⏹️', `${ev.agentName || ev.agentId || 'tarefa'} cancelado`, 'muted');
    }));

    off.push(bus.on(EV.AGENT_TIMEOUT, (ev) => {
      line('⏱️', `${ev.agentName || ev.agentId} passou do tempo limite`, 'warn', ev.emoji);
    }));

    off.push(bus.on(EV.NOTICE, (ev) => {
      line(ev.level === 'error' ? '❗' : 'ℹ️', ev.message, ev.level === 'error' ? 'err' : 'warn');
    }));

    off.push(bus.on(EV.RUN_COMPLETED, (ev) => {
      line('🏁', `Execução concluída · ${ev.summary?.completed || 0} ok, ${ev.summary?.failed || 0} com problema`, 'accent');
      footer.classList.remove('hidden');
      clear(footer);
      footer.appendChild(el('span', { class: 'pill' }, `${fmtTokens(totalTk)} tk`));
      footer.appendChild(el('span', { class: 'pill' }, fmtCost(totalCost)));
      footer.appendChild(el('span', { class: ev.staged ? 'pill warn' : 'pill' },
        ev.staged ? `${ev.staged} arquivo(s) em staging` : 'nada alterado'));
    }));

    off.push(bus.on(EV.RUN_FAILED, (ev) => line('❗', ev.message, 'err')));
    off.push(bus.on(EV.RUN_CANCELLED, (ev) => line('⏹️', `Execução cancelada: ${ev.reason}`, 'muted')));

    return () => off.forEach(fn => fn());
  }

  return { root, attach, cardsWrap, timelineBox, footer };
}
