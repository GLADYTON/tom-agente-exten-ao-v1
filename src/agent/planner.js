// Planner: transforma o pedido do usuário em tarefas com agente definido.
//
// Duas vias, na ordem:
// 1. O modelo devolve um plano em JSON (rápido, entende contexto).
// 2. Se o JSON vier quebrado, vazio ou com agente inexistente, cai na heurística
//    por palavra-chave. O run nunca falha por causa do planejamento.
//
// O planner não executa nada e não decide commit.

import { callModel, estimateCost } from '../providers/client.js';
import { addUsage } from '../storage.js';
import { registry } from './registry.js';
import { createTask } from './task.js';
import { EV } from './events.js';

const MAX_TASKS = 4;

function plannerSystem() {
  return `Você é o Planner de uma equipe de agentes de engenharia de software. Sua única função é dividir o pedido do usuário em tarefas e escolher quem faz cada uma.

Equipe disponível:
${registry.describeForPlanner()}

Responda APENAS com um objeto JSON, sem texto antes ou depois, sem cercas de código:

{
  "intent": "resumo do pedido em uma frase",
  "tasks": [
    {
      "agentId": "id exato de um agente da lista",
      "description": "instrução completa e autossuficiente para aquele agente, em português",
      "dependsOn": [],
      "priority": 1
    }
  ]
}

Regras:
- No máximo ${MAX_TASKS} tarefas. Menos é melhor. Pedido simples de uma área = UMA tarefa.
- Não divida por arquivo. Divida por especialidade.
- "description" precisa se sustentar sozinha: o agente não vê o pedido original nem as outras tarefas.
- "dependsOn" usa o índice (base 0) de outra tarefa desta lista. Só use quando a tarefa realmente precisar do resultado da outra. Tarefas de áreas diferentes normalmente são independentes e devem rodar em paralelo.
- "priority": 1 é o mais importante.
- Não crie tarefa de revisão: isso é automático.
- Se o pedido for só uma pergunta sobre o código, crie UMA tarefa de investigação para o agente da área.`;
}

function stripFence(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : t).trim();
}

// Modelos às vezes acrescentam uma frase antes do JSON. Pega o primeiro objeto
// balanceado em vez de desistir.
function extractJson(text) {
  const raw = stripFence(text);
  try { return JSON.parse(raw); } catch { /* tenta recortar */ }

  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Heurística: divide o pedido por área quando o modelo não colabora. Não tenta
// ser inteligente — só garante que alguém competente pegue o trabalho.
export function heuristicPlan(userMessage) {
  const scored = registry.scoreByKeywords(userMessage);
  const hits = scored.filter(s => s.score > 0);

  // Duas áreas claramente citadas: duas tarefas paralelas com o pedido inteiro.
  // Cada agente tem no system prompt a instrução de ficar no seu escopo.
  if (hits.length >= 2 && hits[1].score >= 2) {
    return hits.slice(0, 2).map((s, i) => createTask({
      agentId: s.agent.id,
      description: userMessage,
      priority: i + 1,
      contextNote: 'Outro agente está cuidando das outras áreas deste mesmo pedido em paralelo. Faça apenas a parte que é do seu escopo.',
    }));
  }

  const winner = hits[0]?.agent || registry.selectable[0];
  return [createTask({ agentId: winner.id, description: userMessage, priority: 1 })];
}

function normalizeTasks(plan, userMessage) {
  const raw = Array.isArray(plan?.tasks) ? plan.tasks.slice(0, MAX_TASKS) : [];
  const valid = raw.filter(t => t?.agentId && registry.has(t.agentId) && !registry.get(t.agentId).autoOnly);
  if (!valid.length) return null;

  // Primeiro cria todas (para ter os ids), depois liga as dependências por índice.
  const tasks = valid.map((t, i) => createTask({
    agentId: t.agentId,
    description: String(t.description || userMessage).trim() || userMessage,
    priority: Number.isFinite(t.priority) ? t.priority : i + 1,
    files: Array.isArray(t.files) ? t.files.filter(f => typeof f === 'string') : [],
  }));

  valid.forEach((t, i) => {
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    tasks[i].dependencies = deps
      .map(d => tasks[Number(d)])
      .filter(dep => dep && dep.id !== tasks[i].id)
      .map(dep => dep.id);
  });

  return tasks;
}

export async function plan({ provider, model, userMessage, repo, bus }) {
  bus?.emit(EV.PLAN_STARTED, { message: userMessage });

  const messages = [
    { role: 'system', content: plannerSystem() },
    {
      role: 'user',
      content: `${repo ? `Repositório: ${repo.fullName} (branch ${repo.branch}).\n\n` : ''}Pedido do usuário:\n${userMessage}`,
    },
  ];

  try {
    const res = await callModel({ provider, model, messages, tools: [], opts: { temperature: 0 } });
    const cost = estimateCost(model, res.usage);
    await addUsage(provider.id, model.id, res.usage.input, res.usage.output, cost);
    bus?.emit(EV.USAGE, { usage: res.usage, cost, agentName: 'Planner', agentId: 'planner' });

    const parsed = extractJson(res.text);
    const tasks = normalizeTasks(parsed, userMessage);

    if (tasks) {
      bus?.emit(EV.PLAN_READY, {
        intent: parsed.intent || '',
        tasks: tasks.map(t => ({ id: t.id, agentId: t.agentId, description: t.description, dependencies: t.dependencies })),
      });
      return { tasks, intent: parsed.intent || '', source: 'model' };
    }

    bus?.emit(EV.PLAN_FALLBACK, { reason: 'O planejamento do modelo não veio utilizável; usando divisão por área.' });
  } catch (e) {
    bus?.emit(EV.PLAN_FALLBACK, { reason: `Planejamento falhou (${e.message}); usando divisão por área.` });
  }

  const tasks = heuristicPlan(userMessage);
  bus?.emit(EV.PLAN_READY, {
    intent: '',
    source: 'heuristic',
    tasks: tasks.map(t => ({ id: t.id, agentId: t.agentId, description: t.description, dependencies: t.dependencies })),
  });
  return { tasks, intent: '', source: 'heuristic' };
}
