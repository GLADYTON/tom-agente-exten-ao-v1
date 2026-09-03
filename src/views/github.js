import { el, clear } from '../util/dom.js';
import * as gh from '../github.js';
import {
  getGithubAccounts, addGithubAccount, removeGithubAccount,
  getActiveGithubAccount, setActiveGithubAccount,
  getRepo, setRepo,
} from '../storage.js';

export async function renderGithub(view) {
  clear(view);

  const accounts = await getGithubAccounts();
  const activeAccount = await getActiveGithubAccount();
  const activeRepo = await getRepo();

  // Header
  const header = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Contas GitHub'),
      el('p', { class: 'page-desc' }, 'Gerencie múltiplas contas e selecione o repositório de trabalho.'),
    ]),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => showAddAccountModal(),
    }, [
      el('span', { class: 'btn-icon' }, '+'),
      el('span', {}, 'Conectar Conta'),
    ]),
  ]);
  view.appendChild(header);

  const notifyBox = el('div', { class: 'notify-container' });
  view.appendChild(notifyBox);

  // Sem contas
  if (!accounts.length) {
    const emptyState = el('div', { class: 'empty-card' }, [
      el('div', {
        class: 'empty-icon-wrap',
        html: '<svg viewBox="0 0 24 24" fill="none" width="28" height="28" stroke="currentColor" stroke-width="1.5"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.49.5.09.66-.22.66-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0112 6.8c.85 0 1.71.11 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.16.58.67.48A10.01 10.01 0 0022 12c0-5.52-4.48-10-10-10z"/></svg>',
      }),
      el('h3', { class: 'empty-title' }, 'Nenhuma conta conectada'),
      el('p', { class: 'empty-text' }, 'Adicione um token de acesso pessoal (PAT) do GitHub para carregar seus repositórios.'),
      el('button', {
        class: 'btn btn-primary',
        style: { marginTop: '12px' },
        onclick: () => showAddAccountModal(),
      }, 'Adicionar Primeira Conta'),
    ]);
    view.appendChild(emptyState);
    return;
  }

  // Seletor/Grade de Contas Conectadas
  const accountsWrap = el('div', { class: 'accounts-section' }, [
    el('div', { class: 'section-title-row' }, [
      el('span', { class: 'section-tag' }, `CONTAS CONECTADAS (${accounts.length})`),
      el('span', { class: 'section-sub-tag' }, 'Clique para trocar a conta ativa'),
    ]),
  ]);

  const accountsGrid = el('div', { class: 'accounts-grid' });
  accounts.forEach(acc => {
    const isActive = activeAccount && activeAccount.id === acc.id;
    const card = el('div', {
      class: `account-pill-card ${isActive ? 'is-active' : ''}`,
      onclick: async (e) => {
        if (e.target.closest('.account-del-btn')) return;
        if (!isActive) {
          await setActiveGithubAccount(acc.id);
          renderGithub(view);
        }
      },
    }, [
      acc.user?.avatar
        ? el('img', { src: acc.user.avatar, class: 'account-avatar-img', alt: acc.user?.login })
        : el('div', { class: 'account-avatar-placeholder' }, (acc.user?.login || '?').slice(0, 2).toUpperCase()),
      el('div', { class: 'account-meta-col' }, [
        el('div', { class: 'account-login-name' }, `@${acc.user?.login || 'desconhecido'}`),
        el('div', { class: 'account-status-label' }, isActive ? '● Conta Ativa' : 'Clique para ativar'),
      ]),
      el('button', {
        class: 'account-del-btn',
        title: `Desconectar @${acc.user?.login}`,
        onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Remover conta @${acc.user?.login}?`)) return;
          await removeGithubAccount(acc.id);
          renderGithub(view);
        },
      }, [
        el('span', {
          html: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        }),
      ]),
    ]);
    accountsGrid.appendChild(card);
  });
  accountsWrap.appendChild(accountsGrid);
  view.appendChild(accountsWrap);

  // Repositório Atualmente Selecionado (Hero Banner)
  if (activeRepo) {
    const activeRepoBanner = el('div', { class: 'active-repo-banner' }, [
      el('div', { class: 'active-repo-badge' }, 'REPOSITÓRIO SELECIONADO'),
      el('div', { class: 'active-repo-content' }, [
        el('div', { class: 'active-repo-icon' }, '📦'),
        el('div', { class: 'active-repo-info' }, [
          el('div', { class: 'active-repo-title' }, activeRepo.fullName),
          el('div', { class: 'active-repo-meta' }, [
            el('span', { class: 'branch-pill' }, `branch: ${activeRepo.branch}`),
            el('span', { class: 'repo-status-dot' }, 'Pronto para uso no Chat e Commit'),
          ]),
        ]),
        el('button', {
          class: 'btn btn-ghost-danger btn-sm',
          title: 'Desmarcar repositório',
          onclick: async () => {
            await setRepo(null);
            renderGithub(view);
          },
        }, 'Desmarcar'),
      ]),
    ]);
    view.appendChild(activeRepoBanner);
  }

  // Barra de Busca de Repos
  const searchWrap = el('div', { class: 'search-bar-wrap' });
  const searchInput = el('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Filtrar repositórios por nome...',
  });
  searchWrap.appendChild(el('span', { class: 'search-icon' }, '🔍'));
  searchWrap.appendChild(searchInput);
  view.appendChild(searchWrap);

  // Container para lista de repositórios agrupados por conta
  const reposContainer = el('div', { class: 'repos-grouped-container' });
  view.appendChild(reposContainer);

  // Carrega repos de todas as contas em paralelo
  const accountsReposMap = new Map();

  async function loadAllRepos() {
    clear(reposContainer);
    reposContainer.appendChild(el('div', { class: 'loading-box' }, [
      el('div', { class: 'spinner' }),
      el('span', {}, 'Carregando repositórios das contas...'),
    ]));

    try {
      await Promise.all(accounts.map(async (acc) => {
        try {
          const list = await gh.listReposForToken(acc.token, 100);
          accountsReposMap.set(acc.id, { ok: true, repos: list });
        } catch (e) {
          accountsReposMap.set(acc.id, { ok: false, error: e.message, repos: [] });
        }
      }));
      renderReposGrouped();
    } catch (e) {
      clear(reposContainer);
      reposContainer.appendChild(el('div', { class: 'error-banner' }, `Erro ao listar repositórios: ${e.message}`));
    }
  }

  function renderReposGrouped() {
    clear(reposContainer);
    const query = searchInput.value.trim().toLowerCase();
    let totalFound = 0;

    accounts.forEach(acc => {
      const data = accountsReposMap.get(acc.id) || { ok: false, repos: [] };
      if (!data.ok) {
        const errorCard = el('div', { class: 'account-group-block' }, [
          el('div', { class: 'account-group-header' }, [
            el('span', { class: 'group-account-name' }, `@${acc.user?.login}`),
            el('span', { class: 'badge badge-err' }, 'Falha na autenticação'),
          ]),
          el('div', { class: 'error-banner-inline' }, `Token expirado ou inválido: ${data.error || 'Erro'}`),
        ]);
        reposContainer.appendChild(errorCard);
        return;
      }

      const filtered = data.repos.filter(r => !query || r.full_name.toLowerCase().includes(query) || (r.description && r.description.toLowerCase().includes(query)));
      totalFound += filtered.length;

      const isCurrentActiveAccount = activeAccount && activeAccount.id === acc.id;

      const groupBlock = el('div', { class: 'account-group-block' });
      const groupHeader = el('div', { class: 'account-group-header' }, [
        el('div', { class: 'group-header-left' }, [
          acc.user?.avatar ? el('img', { src: acc.user.avatar, class: 'group-avatar-mini' }) : null,
          el('span', { class: 'group-account-name' }, `@${acc.user?.login}`),
          isCurrentActiveAccount ? el('span', { class: 'badge badge-ok' }, 'ativa') : null,
          el('span', { class: 'group-count' }, `${filtered.length} ${filtered.length === 1 ? 'repositório' : 'repositórios'}`),
        ]),
      ]);
      groupBlock.appendChild(groupHeader);

      if (!filtered.length) {
        groupBlock.appendChild(el('div', { class: 'group-empty-hint' }, query ? 'Nenhum repositório corresponde à busca nesta conta.' : 'Nenhum repositório encontrado.'));
      } else {
        const listEl = el('div', { class: 'repo-items-list' });
        filtered.forEach(r => {
          const isSelected = activeRepo && activeRepo.fullName === r.full_name;
          const repoRow = el('div', { class: `repo-item-row ${isSelected ? 'is-selected' : ''}` }, [
            el('div', { class: 'repo-item-main' }, [
              el('div', { class: 'repo-item-title-row' }, [
                el('span', { class: 'repo-item-name' }, r.name),
                r.private ? el('span', { class: 'badge badge-dim' }, 'privado') : el('span', { class: 'badge badge-dim' }, 'público'),
                r.language ? el('span', { class: 'badge badge-lang' }, r.language) : null,
              ]),
              r.description ? el('div', { class: 'repo-item-desc' }, r.description) : null,
              el('div', { class: 'repo-item-meta' }, [
                el('span', {}, `Padrão: ${r.default_branch}`),
                r.updated_at ? el('span', {}, `Atualizado: ${new Date(r.updated_at).toLocaleDateString()}`) : null,
              ]),
            ]),
            el('div', { class: 'repo-item-action' }, [
              isSelected
                ? el('span', { class: 'badge badge-selected' }, '✓ Selecionado')
                : el('button', {
                    class: 'btn btn-select btn-sm',
                    onclick: async () => {
                      // Se for de outra conta, ativa a conta correspondente também
                      if (!isCurrentActiveAccount) {
                        await setActiveGithubAccount(acc.id);
                      }
                      await setRepo({
                        fullName: r.full_name,
                        branch: r.default_branch,
                        defaultBranch: r.default_branch,
                      });
                      renderGithub(view);
                    },
                  }, 'Selecionar'),
            ]),
          ]);
          listEl.appendChild(repoRow);
        });
        groupBlock.appendChild(listEl);
      }

      reposContainer.appendChild(groupBlock);
    });

    if (query && totalFound === 0) {
      clear(reposContainer);
      reposContainer.appendChild(el('div', { class: 'empty-card' }, [
        el('div', { class: 'empty-icon-wrap' }, '🔍'),
        el('h3', { class: 'empty-title' }, 'Nenhum resultado'),
        el('p', { class: 'empty-text' }, `Nenhum repositório encontrado para "${query}".`),
      ]));
    }
  }

  searchInput.addEventListener('input', renderReposGrouped);
  loadAllRepos();

  // Modal para adicionar nova conta
  function showAddAccountModal() {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal-box' });

    modal.appendChild(el('div', { class: 'modal-header' }, [
      el('div', {}, [
        el('h3', { class: 'modal-title' }, 'Adicionar Conta GitHub'),
        el('p', { class: 'modal-subtitle' }, 'Conecte via Personal Access Token (PAT)'),
      ]),
      el('button', { class: 'modal-close-btn', onclick: () => backdrop.remove() }, '✕'),
    ]));

    const stepGuide = el('div', { class: 'modal-guide-step' }, [
      el('div', { class: 'guide-step-text' }, [
        el('strong', {}, 'Passo 1: '),
        document.createTextNode('Gere um token clássico com escopos '),
        el('code', {}, 'repo, read:user, read:org'),
      ]),
      el('button', {
        class: 'btn btn-secondary btn-sm',
        style: { marginTop: '8px' },
        onclick: () => {
          window.open('https://github.com/settings/tokens/new?scopes=repo,read:user,read:org&description=Agente%20Tom', '_blank');
        },
      }, 'Abrir GitHub para Criar Token ↗'),
    ]);
    modal.appendChild(stepGuide);

    const tokenInput = el('input', {
      class: 'input-field',
      type: 'password',
      placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxx',
      style: { marginTop: '10px' },
    });

    const errorDiv = el('div');

    modal.appendChild(el('div', { style: { marginTop: '12px' } }, [
      el('label', { class: 'input-label' }, 'Cole o Token do GitHub'),
      tokenInput,
      errorDiv,
    ]));

    const modalFooter = el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => backdrop.remove() }, 'Cancelar'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          clear(errorDiv);
          const val = tokenInput.value.trim();
          if (!val) {
            errorDiv.appendChild(el('div', { class: 'error-banner-inline' }, 'Por favor, cole um token antes de prosseguir.'));
            return;
          }
          const submitBtn = modalFooter.querySelector('.btn-primary');
          submitBtn.disabled = true;
          submitBtn.textContent = 'Validando token...';
          try {
            const user = await gh.testToken(val);
            await addGithubAccount({
              id: String(user.id),
              token: val,
              user: { login: user.login, avatar: user.avatar_url, id: user.id },
            });
            backdrop.remove();
            renderGithub(view);
          } catch (e) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Conectar Conta';
            errorDiv.appendChild(el('div', { class: 'error-banner-inline' }, `Falha ao validar token: ${e.message}`));
          }
        },
      }, 'Conectar Conta'),
    ]);

    modal.appendChild(modalFooter);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    tokenInput.focus();
  }
}
