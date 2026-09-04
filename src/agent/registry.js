// Registro dos agentes do sistema.
//
// O Orchestrator e o Dispatcher só conhecem esta interface. Adicionar um agente
// novo (security, database, ux...) nas próximas fases é acrescentar um módulo em
// src/agents/ e registrá-lo aqui — nada mais no pipeline muda.
//
// Isto é separado de storage.getAgents(): aqueles são os agentes que o usuário
// criou para o chat de agente único. Estes são os papéis fixos da equipe.

import frontend from '../agents/frontend.js';
import backend from '../agents/backend.js';
import reviewer from '../agents/reviewer.js';
import { TOOL_DEFS } from './tools.js';

const BUILTIN = [frontend, backend, reviewer];

const VALID_TOOLS = new Set(TOOL_DEFS.map(t => t.name));

// Um agente pedindo tool que não existe ficaria sem ferramenta nenhuma no
// filterTools do loop e travaria sem explicação. Melhor descobrir no load.
function validate(agent) {
  const bad = (agent.tools || []).filter(t => !VALID_TOOLS.has(t));
  if (bad.length) {
    console.warn(`[registry] ${agent.id} declara tools inexistentes: ${bad.join(', ')}`);
  }
  return {
    ...agent,
    tools: (agent.tools || []).filter(t => VALID_TOOLS.has(t)),
  };
}

class AgentRegistry {
  constructor(list = []) {
    this.agents = new Map();
    for (const a of list) this.register(a);
  }

  register(agent) {
    if (!agent?.id) throw new Error('Agente sem id não pode ser registrado.');
    this.agents.set(agent.id, validate(agent));
    return this.agents.get(agent.id);
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  has(id) {
    return this.agents.has(id);
  }

  get all() {
    return [...this.agents.values()];
  }

  // Agentes que o planner pode escolher a partir do pedido do usuário.
  get selectable() {
    return this.all.filter(a => !a.autoOnly);
  }

  byCapability(cap) {
    return this.all.filter(a => (a.capabilities || []).includes(cap));
  }

  // Descrição compacta da equipe para o prompt do planner. Mantida curta de
  // propósito: é contexto em toda chamada de planejamento.
  describeForPlanner() {
    return this.selectable
      .map(a => `- ${a.id} (${a.name}): ${a.description} Especialidades: ${(a.capabilities || []).join(', ')}.`)
      .join('\n');
  }

  // Pontuação por palavra-chave: base do planner heurístico quando o modelo não
  // devolve um plano usável.
  scoreByKeywords(text) {
    const low = String(text || '').toLowerCase();
    return this.selectable
      .map(a => ({
        agent: a,
        score: (a.keywords || []).reduce((n, k) => (low.includes(k) ? n + 1 : n), 0),
      }))
      .sort((x, y) => y.score - x.score);
  }
}

export const registry = new AgentRegistry(BUILTIN);

export const REVIEWER_ID = reviewer.id;

export function getAgent(id) {
  return registry.get(id);
}

export default registry;
