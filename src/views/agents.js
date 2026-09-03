import { el, clear } from '../util/dom.js';
import {
  getAgents, upsertAgent, removeAgent,
  getActiveAgent, setActiveAgent,
  getProviders,
} from '../storage.js';
import { TOOL_DEFS } from '../agent/tools.js';

const EMOJIS = ['⚡', '🔍', '🏗️', '🤖', '🧠', '🎯', '🚀', '🛠️', '📝', '🔒', '🎨', '🐛', '💡', '🧪', '📦', '🔧'];

// Rótulos legíveis para as ferramentas, para o usuário não precisar decifrar snake_case.
const TOOL_LABELS = {
  list_repo_tree: 'Listar arquivos',
  read_file: 'Ler arquivo',
  write_file: 'Escrever / commitar',
  delete_file: 'Apagar arquivo',
  create_branch: 'Criar branch',
  open_pr: 'Abrir Pull Request',
};

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

function modelLabelFor(providers, modelRef) {
  if (!modelRef) return null;
  const p = providers.find(pp => pp.id === modelRef.providerId);
  const m = p?.models?.find(mm => mm.id === modelRef.modelId);
  if (!p || !m) return null;
  return `${p.name || p.type} · ${m.label || m.id}`;
}

function agentCard(agent, isActive, providers, handlers) {
  const ownModel = modelLabelFor(providers, agent.modelRef);

  return el('div', { class: `agent-card-v2 ${isActive ? 'is-active' : ''}` }, [
    isActive ? el('div', { class: 'agent-active-ribbon' }, 'AGENTE ATIVO NO CHAT') : null,

    el('div', { class: 'agent-card-top' }, [
      el('div', { class: 'agent-avatar-box' }, agent.emoji || '🤖'),
      el('div', { class: 'agent-title-col' }, [
        el('div', { class: 'agent-title' }, agent.name),
        el('div', { class: 'agent-subtitle' }, agent.description || 'Sem descrição definida.'),
      ]),
    ]),

    el('div', { class: 'agent-specs' }, [
      el('div', { class: 'agent-spec-row' }, [
        el('span', { class: 'spec-key' }, 'Modelo'),
        el('span', { class: 'spec-val' }, ownModel || 'Usa o modelo padrão global'),
      ]),
      el('div', { class: 'agent-spec-row' }, [
        el('span', { class: 'spec-key' }, 'Temperatura'),
        el('span', { class: 'spec-val' }, String(agent.temperature ?? 0.2)),
      ]),
      el('div', { class: 'agent-spec-row' }, [
        el('span', { class: 'spec-key' }, 'Permissões'),
        el('span', { class: 'spec-val' }, `${(agent.tools || []).length} de ${TOOL_DEFS.length} ferramentas`),
      ]),
    ]),

    el('div', { class: 'agent-tools-chips' },
      (agent.tools || []).map(t => el('span', { class: 'tool-chip' }, toolLabel(t)))
    ),

    el('div', { class: 'agent-card-actions' }, [
      isActive
        ? el('span', { class: 'agent-active-tag' }, '✓ Em uso')
        : el('button', { class: 'btn btn-select btn-sm', onclick: handlers.onActivate }, 'Usar este agente'),
      el('div', { class: 'action-spacer' }),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: handlers.onEdit }, 'Editar'),
      el('button', { class: 'btn btn-ghost-danger btn-sm', onclick: handlers.onDelete }, 'Excluir'),
    ]),
  ]);
}

function agentEditor(existing, providers, onSave, onCancel) {
  const state = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: 'agent_' + Math.random().toString(36).slice(2, 10),
    name: '',
    emoji: '🤖',
    description: '',
    systemPrompt: '',
    tools: TOOL_DEFS.map(t => t.name),
    modelRef: null,
    temperature: 0.2,
  };

  const wrap = el('div', { class: 'editor-panel' });

  wrap.appendChild(el('div', { class: 'editor-panel-header' }, [
    el('h3', { class: 'editor-panel-title' }, existing ? `Editando: ${existing.name}` : 'Criar novo agente'),
    el('p', { class: 'editor-panel-desc' }, 'Defina identidade, modelo, permissões e instruções deste agente.'),
  ]));

  // --- Identidade
  const emojiBox = el('div', { class: 'emoji-grid' });
  EMOJIS.forEach(e => {
    const b = el('button', {
      class: 'emoji-choice' + (state.emoji === e ? ' is-selected' : ''),
      onclick: () => {
        state.emoji = e;
        emojiBox.querySelectorAll('.emoji-choice').forEach(bb => bb.classList.remove('is-selected'));
        b.classList.add('is-selected');
      },
    }, e);
    emojiBox.appendChild(b);
  });

  const nameInp = el('input', { class: 'input-field', value: state.name, placeholder: 'Ex: Refatorador de Testes' });
  nameInp.addEventListener('input', () => { state.name = nameInp.value; });

  const descInp = el('input', { class: 'input-field', value: state.description, placeholder: 'Ex: Revisa e reescreve testes quebrados' });
  descInp.addEventListener('input', () => { state.description = descInp.value; });

  wrap.appendChild(el('div', { class: 'editor-block' }, [
    el('div', { class: 'editor-block-label' }, 'Identidade'),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Ícone do agente'),
      emojiBox,
    ]),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Nome *'),
      nameInp,
    ]),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Descrição curta'),
      descInp,
      el('div', { class: 'field-hint' }, 'Aparece no card e na tela inicial do chat.'),
    ]),
  ]));

  // --- Modelo e criatividade
  const modelSel = el('select', { class: 'select-field' }, [
    el('option', { value: '' }, 'Usar o modelo padrão global (definido em Config)'),
    ...providers.flatMap(p => (p.models || []).map(m => {
      const val = `${p.id}::${m.id}`;
      const sel = state.modelRef && state.modelRef.providerId === p.id && state.modelRef.modelId === m.id;
      return el('option', { value: val, ...(sel ? { selected: 'selected' } : {}) }, `${p.name || p.type} · ${m.label || m.id}`);
    })),
  ]);
  modelSel.addEventListener('change', () => {
    if (!modelSel.value) { state.modelRef = null; return; }
    const [pid, mid] = modelSel.value.split('::');
    state.modelRef = { providerId: pid, modelId: mid };
  });

  const tempInp = el('input', {
    class: 'range-field', type: 'range', step: '0.1', min: '0', max: '1.5',
    value: String(state.temperature ?? 0.2),
  });
  const tempVal = el('span', { class: 'range-value' }, String(state.temperature ?? 0.2));
  tempInp.addEventListener('input', () => {
    state.temperature = +tempInp.value;
    tempVal.textContent = tempInp.value;
  });

  wrap.appendChild(el('div', { class: 'editor-block' }, [
    el('div', { class: 'editor-block-label' }, 'Modelo'),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Modelo usado por este agente'),
      modelSel,
      providers.length
        ? el('div', { class: 'field-hint' }, 'Deixe no padrão global se quiser trocar o modelo de todos de uma vez.')
        : el('div', { class: 'field-hint field-hint-warn' }, 'Nenhum provider cadastrado ainda. Adicione um em Config.'),
    ]),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Temperatura (0 = preciso, 1.5 = criativo)'),
      el('div', { class: 'range-row' }, [tempInp, tempVal]),
    ]),
  ]));

  // --- Permissões / ferramentas
  const toolsBox = el('div', { class: 'tools-list-v2' });
  TOOL_DEFS.forEach(t => {
    const on = state.tools.includes(t.name);
    const row = el('label', { class: 'tool-row' + (on ? ' is-on' : '') }, [
      el('input', { type: 'checkbox', class: 'tool-checkbox', ...(on ? { checked: 'checked' } : {}) }),
      el('div', { class: 'tool-row-text' }, [
        el('div', { class: 'tool-row-title' }, toolLabel(t.name)),
        el('div', { class: 'tool-row-desc' }, t.description || ''),
      ]),
    ]);
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.tools.includes(t.name)) state.tools.push(t.name);
        row.classList.add('is-on');
      } else {
        state.tools = state.tools.filter(x => x !== t.name);
        row.classList.remove('is-on');
      }
    });
    toolsBox.appendChild(row);
  });

  wrap.appendChild(el('div', { class: 'editor-block' }, [
    el('div', { class: 'editor-block-label' }, 'Permissões'),
    el('div', { class: 'field-hint', style: { marginBottom: '8px' } }, 'O agente só consegue executar o que estiver marcado aqui.'),
    toolsBox,
  ]));

  // --- Instruções
  const spInp = el('textarea', {
    class: 'textarea-field',
    rows: '7',
    placeholder: 'Ex: Você é um engenheiro sênior. Leia os arquivos antes de editar. Faça mudanças mínimas.',
  }, state.systemPrompt);
  spInp.addEventListener('input', () => { state.systemPrompt = spInp.value; });

  wrap.appendChild(el('div', { class: 'editor-block' }, [
    el('div', { class: 'editor-block-label' }, 'Instruções'),
    el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'System prompt'),
      spInp,
      el('div', { class: 'field-hint' }, 'Define o comportamento do agente em cada conversa.'),
    ]),
  ]));

  const err = el('div');
  wrap.appendChild(err);

  wrap.appendChild(el('div', { class: 'editor-panel-footer' }, [
    el('button', { class: 'btn btn-ghost', onclick: onCancel }, 'Cancelar'),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        clear(err);
        if (!state.name.trim()) {
          err.appendChild(el('div', { class: 'error-banner-inline' }, 'Dê um nome ao agente antes de salvar.'));
          nameInp.focus();
          return;
        }
        if (!state.tools.length) {
          err.appendChild(el('div', { class: 'error-banner-inline' }, 'Marque pelo menos uma permissão.'));
          return;
        }
        state.name = state.name.trim();
        onSave(state);
      },
    }, existing ? 'Salvar alterações' : 'Criar agente'),
  ]));

  return wrap;
}

// Renderiza a lista + editor num container qualquer (view principal ou painel lateral).
async function renderAgentsInto(container, rerender) {
  const agents = await getAgents();
  const active = await getActiveAgent();
  const providers = await getProviders();

  const list = el('div', { class: 'agents-list-v2' });
  agents.forEach(a => {
    list.appendChild(agentCard(a, active?.id === a.id, providers, {
      onEdit: () => openEditor(a),
      onActivate: async () => { await setActiveAgent(a.id); rerender(); },
      onDelete: async () => {
        if (agents.length <= 1) {
          alert('É preciso manter pelo menos um agente.');
          return;
        }
        if (!confirm(`Excluir o agente "${a.name}"? Isso não pode ser desfeito.`)) return;
        await removeAgent(a.id);
        rerender();
      },
    }));
  });
  container.appendChild(list);

  let editorBox = null;
  function openEditor(a) {
    if (editorBox) editorBox.remove();
    editorBox = agentEditor(a, providers,
      async (s) => { await upsertAgent(s); rerender(); },
      () => { editorBox.remove(); editorBox = null; },
    );
    container.appendChild(editorBox);
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { openEditor };
}

export async function renderAgents(view) {
  clear(view);

  const header = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Agentes de IA'),
      el('p', { class: 'page-desc' }, 'Cada agente tem seu próprio modelo, permissões e instruções.'),
    ]),
  ]);
  view.appendChild(header);

  const body = el('div');
  view.appendChild(body);

  const api = await renderAgentsInto(body, () => renderAgents(view));

  header.appendChild(el('button', {
    class: 'btn btn-primary',
    onclick: () => api.openEditor(null),
  }, [el('span', { class: 'btn-icon' }, '+'), el('span', {}, 'Novo agente')]));
}

export async function renderAgentsPanel(container, onClose) {
  clear(container);

  container.appendChild(el('div', { class: 'side-panel-header' }, [
    el('div', {}, [
      el('h2', { class: 'side-panel-title' }, 'Agentes de IA'),
      el('p', { class: 'side-panel-desc' }, 'Escolha quem responde no chat.'),
    ]),
    el('button', { class: 'modal-close-btn', title: 'Fechar', onclick: onClose }, '✕'),
  ]));

  const body = el('div', { class: 'side-panel-body' });
  container.appendChild(body);

  const api = await renderAgentsInto(body, () => renderAgentsPanel(container, onClose));

  const newBtn = el('button', {
    class: 'btn btn-primary btn-full',
    onclick: () => api.openEditor(null),
  }, [el('span', { class: 'btn-icon' }, '+'), el('span', {}, 'Novo agente')]);
  body.insertBefore(newBtn, body.firstChild);
}
