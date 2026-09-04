import { el, clear, renderInlineMd, fmtCost, fmtTokens } from '../util/dom.js';
import {
  getProviders, getActiveModel, getRepo, getChats, saveChats, getActiveAgent,
  getSettings, setSettings,
} from '../storage.js';
import { runAgent } from '../agent/loop.js';
import { resolveModel } from '../agent/model.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { EV } from '../agent/events.js';
import { createRunView } from './runview.js';

let history = [];

function bubble(role, contentNode) {
  return el('div', { class: `msg ${role}` }, [
    el('div', { class: 'role' }, role === 'user' ? 'você' : role),
    contentNode,
  ]);
}

function fmtArgs(a) {
  try { return JSON.stringify(a, null, 2); } catch { return String(a); }
}

function openAgents() {
  if (window._openAgentsPanel) window._openAgentsPanel();
}

// Alterna entre agente único e equipe. Persiste na hora: o usuário não deveria
// precisar ir em Config para escolher como quer trabalhar.
function modeToggle(teamMode, onChange) {
  const soloBtn = el('button', { class: teamMode ? '' : 'active', title: 'Um agente executa o pedido inteiro' }, '👤 Solo');
  const teamBtn = el('button', { class: teamMode ? 'active' : '', title: 'Orquestrador divide o pedido entre agentes especialistas' }, '👥 Equipe');
  soloBtn.addEventListener('click', () => onChange(false));
  teamBtn.addEventListener('click', () => onChange(true));
  return el('div', { class: 'mode-toggle' }, [soloBtn, teamBtn]);
}

// Header fixo do chat: identidade do agente + modo + botão do painel de agentes.
function chatHeader(agent, teamMode, onModeChange) {
  return el('div', { class: 'chat-top-header' }, [
    teamMode
      ? el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
        el('span', { class: 'chat-agent-emoji' }, '👥'),
        el('span', { class: 'chat-agent-name' }, 'Equipe'),
        el('span', { class: 'chat-agent-badge' }, '3 agentes'),
      ])
      : el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
        el('span', { class: 'chat-agent-emoji' }, agent?.emoji || '🤖'),
        el('span', { class: 'chat-agent-name' }, agent?.name || 'Sem agente'),
        el('span', { class: 'chat-agent-badge' }, 'ativo'),
      ]),
    el('div', { class: 'chat-header-actions' }, [
      modeToggle(teamMode, onModeChange),
      el('button', { class: 'btn-agents-toggle', onclick: openAgents }, [
        el('span', {}, '🤖'),
        el('span', {}, 'Agentes'),
      ]),
    ]),
  ]);
}

function emptyView(icon, title, text) {
  return el('div', { class: 'empty-card' }, [
    el('div', { class: 'empty-icon-wrap' }, icon),
    el('h3', { class: 'empty-title' }, title),
    el('p', { class: 'empty-text' }, text),
  ]);
}

export async function renderChat(view) {
  clear(view);

  const [providers, globalActive, repo, agent, settings] = await Promise.all([
    getProviders(), getActiveModel(), getRepo(), getActiveAgent(), getSettings(),
  ]);

  const teamMode = settings.teamMode === true;

  async function changeMode(next) {
    if (next === teamMode) return;
    await setSettings({ teamMode: next });
    renderChat(view);
  }

  const shell = el('div', { class: 'chat-shell-v2' });
  shell.appendChild(chatHeader(agent, teamMode, changeMode));
  view.appendChild(shell);

  // Estados de bloqueio: sem provider ou sem modelo resolvido.
  if (!providers.length) {
    const box = el('div', { class: 'chat-messages-scroll' });
    box.appendChild(emptyView('🔌', 'Nenhum modelo configurado',
      'Vá na aba Modelos e adicione um provider de IA. Vários funcionam de graça.'));
    shell.appendChild(box);
    return;
  }

  const { provider, model } = resolveModel(providers, agent, globalActive);
  if (!model) {
    const box = el('div', { class: 'chat-messages-scroll' });
    box.appendChild(emptyView('🎯', 'Escolha um modelo',
      'Defina o modelo padrão na aba Modelos, ou dê um modelo próprio a este agente em Agentes.'));
    shell.appendChild(box);
    return;
  }

  // Barra de contexto: modelo, repo e contadores da sessão.
  const pillsBar = el('div', { class: 'chat-pills-bar' });
  pillsBar.appendChild(el('span', { class: 'pill accent' }, `${provider.name || provider.type} · ${model.label || model.id}`));
  pillsBar.appendChild(repo
    ? el('span', { class: 'pill' }, `${repo.fullName} @ ${repo.branch}`)
    : el('span', { class: 'pill warn' }, 'nenhum repo selecionado'));
  const tokPill = el('span', { class: 'pill' }, '0 tk');
  const costPill = el('span', { class: 'pill' }, '$0.0000');
  pillsBar.appendChild(tokPill);
  pillsBar.appendChild(costPill);
  shell.appendChild(pillsBar);

  const msgsBox = el('div', { class: 'chat-messages-scroll' });
  shell.appendChild(msgsBox);

  const priorChats = await getChats();
  history = priorChats[0]?.messages || [];

  if (!history.length) {
    msgsBox.appendChild(teamMode
      ? el('div', { class: 'welcome-box' }, [
        el('div', { class: 'welcome-avatar' }, '👥'),
        el('div', { class: 'welcome-title' }, 'Modo equipe'),
        el('div', { class: 'welcome-desc' },
          'Descreva o que você quer. O orquestrador divide entre 🎨 Frontend, ⚙️ Backend e 🧪 Code Reviewer. As mudanças ficam em staging até você aprovar o commit.'),
      ])
      : el('div', { class: 'welcome-box' }, [
        el('div', { class: 'welcome-avatar' }, agent?.emoji || '🤖'),
        el('div', { class: 'welcome-title' }, `Olá, sou o ${agent?.name || 'agente'}`),
        el('div', { class: 'welcome-desc' }, agent?.description || 'Descreva o que você quer fazer no seu repositório.'),
      ]));
  }

  history.forEach(m => {
    if (m.role === 'system' || m.role === 'tool') return;
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return;
    msgsBox.appendChild(bubble(m.role, el('div', { html: renderInlineMd(m.content || '') })));
  });

  // Área de input.
  const input = el('textarea', {
    class: 'chat-textarea',
    rows: '2',
    placeholder: `Diga ao ${agent?.name || 'agente'} o que fazer...`,
  });

  const sendBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Enviar');
  const clearBtn = el('button', { class: 'btn btn-ghost btn-sm', title: 'Limpar histórico' }, 'Limpar');

  const inputArea = el('div', { class: 'chat-input-area' }, [
    el('div', { class: 'chat-textarea-box' }, [input]),
    el('div', { class: 'chat-bottom-actions' }, [
      el('span', { class: 'kbd-hint' }, 'Ctrl+Enter envia'),
      el('div', { class: 'chat-header-actions' }, [clearBtn, sendBtn]),
    ]),
  ]);
  shell.appendChild(inputArea);

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Limpar o histórico desta conversa?')) return;
    history = [];
    await saveChats([{ messages: [] }]);
    renderChat(view);
  });

  let totalCost = 0, totalTk = 0;

  function trackUsage(inTk, outTk, cost) {
    totalTk += (inTk || 0) + (outTk || 0);
    totalCost += cost || 0;
    tokPill.textContent = fmtTokens(totalTk) + ' tk';
    costPill.textContent = fmtCost(totalCost);
  }

  async function sendSolo(text, assistantNode, thinkingHtml) {
    try {
      const out = await runAgent({
        provider, model, agent,
        userMessage: text,
        history,
        onEvent: (ev) => {
          if (ev.type === 'thinking') {
            assistantNode.className = 'thinking';
            assistantNode.innerHTML = thinkingHtml;
          } else if (ev.type === 'assistant_text' && ev.text) {
            assistantNode.className = '';
            assistantNode.innerHTML = renderInlineMd(ev.text);
          } else if (ev.type === 'tool_call') {
            msgsBox.appendChild(el('div', { class: 'msg tool' }, [
              el('div', { class: 'role' }, `→ ${ev.name}`),
              el('pre', {}, fmtArgs(ev.args)),
            ]));
          } else if (ev.type === 'tool_result') {
            msgsBox.appendChild(el('div', { class: 'msg tool ok' }, [
              el('div', { class: 'role' }, `✓ ${ev.name}`),
              el('pre', {}, fmtArgs(ev.result).slice(0, 2000)),
            ]));
          } else if (ev.type === 'tool_error') {
            msgsBox.appendChild(el('div', { class: 'msg tool err' }, [
              el('div', { class: 'role' }, `✗ ${ev.name}`),
              el('div', { class: 'error-banner-inline' }, ev.error),
            ]));
          } else if (ev.type === 'usage') {
            trackUsage(ev.usage.input, ev.usage.output, ev.cost);
          } else if (ev.type === 'error') {
            assistantNode.className = '';
            assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, ev.message));
          }
          msgsBox.scrollTop = msgsBox.scrollHeight;
        },
      });
      history = out.messages.filter(mm => mm.role !== 'system');
      await saveChats([{ messages: history }]);
    } catch (e) {
      assistantNode.className = '';
      clear(assistantNode);
      assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
    }
  }

  // --- Modo equipe: orquestrador + cards + timeline + commit manual.
  async function sendTeam(text, assistantNode) {
    const orch = new Orchestrator();
    const runView = createRunView();
    const detach = runView.attach(orch.bus);

    // A bolha do assistente vira o container do run: os cards ficam no lugar
    // onde a resposta apareceria.
    assistantNode.className = '';
    clear(assistantNode);
    assistantNode.appendChild(runView.root);

    orch.bus.onAny(() => { msgsBox.scrollTop = msgsBox.scrollHeight; });
    orch.bus.on(EV.USAGE, (ev) => trackUsage(ev.usage?.input, ev.usage?.output, ev.cost));

    try {
      await orch.run({ userMessage: text });
      if (orch.stagedFiles.length) {
        assistantNode.appendChild(commitBar(orch, runView));
      }
      // O histórico do chat guarda o pedido e o resumo, não o run inteiro:
      // reabrir o painel não deve tentar reconstruir cards de uma execução morta.
      history = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: teamSummaryText(orch) },
      ];
      await saveChats([{ messages: history }]);
    } catch (e) {
      assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
    } finally {
      detach();
    }
  }

  function teamSummaryText(orch) {
    const tasks = orch.graph.all;
    const lines = tasks.map(t => {
      const mark = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏹️';
      return `${mark} ${t.agentId}: ${t.result ? t.result.slice(0, 400) : (t.error || t.status)}`;
    });
    const staged = orch.stagedFiles;
    if (staged.length) {
      lines.push('', `**${staged.length} arquivo(s) em staging, aguardando commit:** ${staged.map(s => s.path).join(', ')}`);
    }
    return lines.join('\n');
  }

  // Barra de commit: a única porta de saída do staging no modo equipe. Nada
  // commita sem o usuário clicar aqui.
  function commitBar(orch, runView) {
    const staged = orch.stagedFiles;
    const bar = el('div', { class: 'commit-bar' });
    const text = el('div', { class: 'commit-bar-text' }, [
      el('strong', {}, `${staged.length} arquivo(s) em staging`),
      el('span', {}, ` · ${repo.fullName} @ ${repo.branch}. Nada foi commitado ainda.`),
    ]);
    const commitBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Commitar');
    const discardBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Descartar');

    commitBtn.addEventListener('click', async () => {
      const list = orch.stagedFiles.map(s => `- ${s.path} (+${s.added}/-${s.removed})`).join('\n');
      if (!confirm(`Commitar em ${repo.fullName} @ ${repo.branch}?\n\n${list}`)) return;
      commitBtn.disabled = true;
      discardBtn.disabled = true;
      try {
        const commits = await orch.commitStaged({ confirmed: true });
        clear(bar);
        bar.appendChild(el('div', { class: 'commit-bar-text' }, [
          el('strong', {}, '✅ Commitado: '),
          el('span', {}, commits.map(c => c.sha?.slice(0, 7)).join(', ')),
        ]));
      } catch (e) {
        commitBtn.disabled = false;
        discardBtn.disabled = false;
        bar.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
      }
    });

    discardBtn.addEventListener('click', () => {
      if (!confirm('Descartar as mudanças em staging? Elas serão perdidas.')) return;
      const n = orch.discardStaged();
      clear(bar);
      bar.appendChild(el('div', { class: 'commit-bar-text' }, `${n} mudança(s) descartada(s).`));
    });

    bar.appendChild(text);
    bar.appendChild(el('div', { class: 'commit-bar-actions' }, [discardBtn, commitBtn]));
    return bar;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    if (teamMode && !repo) {
      msgsBox.appendChild(el('div', { class: 'error-banner-inline' },
        'O modo equipe precisa de um repositório ativo. Selecione um na aba Repos.'));
      msgsBox.scrollTop = msgsBox.scrollHeight;
      return;
    }

    input.value = '';
    sendBtn.disabled = true;

    msgsBox.querySelector('.welcome-box')?.remove();
    msgsBox.appendChild(bubble('user', el('div', { html: renderInlineMd(text) })));
    msgsBox.scrollTop = msgsBox.scrollHeight;

    const thinkingHtml = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    const assistantNode = el('div', { class: 'thinking', html: thinkingHtml });
    msgsBox.appendChild(bubble('assistant', assistantNode));

    try {
      if (teamMode) await sendTeam(text, assistantNode);
      else await sendSolo(text, assistantNode, thinkingHtml);
    } finally {
      sendBtn.disabled = false;
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  msgsBox.scrollTop = msgsBox.scrollHeight;
}
