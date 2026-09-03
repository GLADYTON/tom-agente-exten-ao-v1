import { el, clear } from '../util/dom.js';
import * as gh from '../github.js';
import { getGithub, getRepo, setRepo } from '../storage.js';

function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return 'agora mesmo';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min atrás`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h atrás`;
  const diffDays = Math.floor(diffSec / 86400);
  if (diffDays === 1) return 'ontem';
  if (diffDays < 30) return `${diffDays} dias atrás`;
  return date.toLocaleDateString();
}

export async function renderRepos(view) {
  clear(view);
  const github = await getGithub();
  const repo = await getRepo();

  if (!github.token) {
    view.appendChild(el('div', { class: 'empty-card' }, [
      el('div', { class: 'empty-icon-wrap' }, '🔗'),
      el('h3', { class: 'empty-title' }, 'GitHub não conectado'),
      el('p', { class: 'empty-text' }, 'Vá na aba GitHub e conecte sua conta para poder interagir com repositórios.'),
    ]));
    return;
  }

  if (!repo) {
    view.appendChild(el('div', { class: 'empty-card' }, [
      el('div', { class: 'empty-icon-wrap' }, '📂'),
      el('h3', { class: 'empty-title' }, 'Nenhum repositório selecionado'),
      el('p', { class: 'empty-text' }, 'Vá na aba GitHub e selecione o repositório que deseja gerenciar.'),
    ]));
    return;
  }

  const [owner, repoName] = repo.fullName.split('/');

  // Header do Repositório Selecionado
  const headerCard = el('div', { class: 'repo-detail-header-card' }, [
    el('div', { class: 'repo-detail-icon' }, '📦'),
    el('div', { class: 'repo-detail-info' }, [
      el('div', { class: 'repo-detail-title-row' }, [
        el('h2', { class: 'repo-detail-name' }, repo.fullName),
      ]),
      el('div', { class: 'repo-detail-meta-row' }, [
        el('span', { class: 'branch-pill' }, [
          el('span', { class: 'branch-icon' }, '🌿'),
          el('span', {}, repo.branch || 'main'),
        ]),
        el('a', {
          href: `https://github.com/${repo.fullName}`,
          target: '_blank',
          class: 'repo-link-external',
        }, 'Abrir no GitHub ↗'),
      ]),
    ]),
    el('button', {
      class: 'btn btn-ghost-danger btn-sm',
      title: 'Desmarcar repositório atual',
      onclick: async () => {
        await setRepo(null);
        renderRepos(view);
      },
    }, 'Trocar Repo'),
  ]);
  view.appendChild(headerCard);

  // Sub-abas dentro de Repos: [Histórico de Commits] e [Fazer Commit Direto]
  let currentSubTab = 'history'; // 'history' | 'commit'

  const subTabNav = el('div', { class: 'subtab-nav' }, [
    el('button', {
      class: `subtab-btn ${currentSubTab === 'history' ? 'is-active' : ''}`,
      onclick: () => { currentSubTab = 'history'; updateSubTabs(); },
    }, [
      el('span', {}, '📜 Histórico de Commits'),
    ]),
    el('button', {
      class: `subtab-btn ${currentSubTab === 'commit' ? 'is-active' : ''}`,
      onclick: () => { currentSubTab = 'commit'; updateSubTabs(); },
    }, [
      el('span', {}, '⚡ Fazer Commit Direto'),
    ]),
  ]);
  view.appendChild(subTabNav);

  const subTabContent = el('div', { class: 'subtab-content' });
  view.appendChild(subTabContent);

  function updateSubTabs() {
    subTabNav.querySelectorAll('.subtab-btn').forEach((b, idx) => {
      if (idx === 0) b.className = `subtab-btn ${currentSubTab === 'history' ? 'is-active' : ''}`;
      if (idx === 1) b.className = `subtab-btn ${currentSubTab === 'commit' ? 'is-active' : ''}`;
    });
    clear(subTabContent);
    if (currentSubTab === 'history') renderHistoryTab(subTabContent);
    else renderCommitFormTab(subTabContent);
  }

  // 1. ABA DE HISTÓRICO DE COMMITS COM DETALHES EXPANSÍVEIS
  function renderHistoryTab(container) {
    const listWrapper = el('div', { class: 'commits-history-wrap' });
    const headerRow = el('div', { class: 'section-title-row' }, [
      el('span', { class: 'section-tag' }, `ÚLTIMOS COMMITS EM "${repo.branch}"`),
      el('span', { class: 'section-sub-tag' }, 'Clique num commit para ver as alterações e arquivos corrigidos'),
    ]);
    listWrapper.appendChild(headerRow);

    const commitsList = el('div', { class: 'commits-list' });
    listWrapper.appendChild(commitsList);
    container.appendChild(listWrapper);

    async function loadCommits() {
      clear(commitsList);
      commitsList.appendChild(el('div', { class: 'loading-box' }, [
        el('div', { class: 'spinner' }),
        el('span', {}, 'Carregando histórico do repositório...'),
      ]));

      try {
        const commits = await gh.listCommits(owner, repoName, repo.branch, 30);
        clear(commitsList);

        if (!commits || !commits.length) {
          commitsList.appendChild(el('div', { class: 'empty-inline' }, 'Nenhum commit encontrado nesta branch.'));
          return;
        }

        commits.forEach(c => {
          const rawMsg = c.commit?.message || 'Sem mensagem';
          const [firstLine, ...bodyLines] = rawMsg.split('\n');
          const bodyText = bodyLines.join('\n').trim();
          const authorName = c.commit?.author?.name || c.author?.login || 'Autor desconhecido';
          const authorAvatar = c.author?.avatar_url;
          const date = c.commit?.author?.date || '';
          const shaShort = c.sha?.slice(0, 7) || '';

          const detailDrawer = el('div', { class: 'commit-detail-drawer', style: { display: 'none' } });

          const commitCard = el('div', {
            class: 'commit-card-item',
            onclick: async () => {
              const isOpen = detailDrawer.style.display !== 'none';
              if (isOpen) {
                detailDrawer.style.display = 'none';
                commitCard.classList.remove('is-expanded');
                return;
              }

              commitCard.classList.add('is-expanded');
              detailDrawer.style.display = 'block';

              if (!detailDrawer.dataset.loaded) {
                clear(detailDrawer);
                detailDrawer.appendChild(el('div', { class: 'loading-box-sm' }, [
                  el('div', { class: 'spinner-sm' }),
                  el('span', {}, 'Carregando arquivos modificados e estatísticas...'),
                ]));

                try {
                  const detail = await gh.getCommitDetail(owner, repoName, c.sha);
                  clear(detailDrawer);
                  detailDrawer.dataset.loaded = '1';

                  const stats = detail.stats || {};
                  const filesList = detail.files || [];

                  // Cabeçalho de stats do commit
                  const statsBar = el('div', { class: 'commit-stats-bar' }, [
                    el('div', { class: 'stats-badge-item text-add' }, `+${stats.additions || 0} adições`),
                    el('div', { class: 'stats-badge-item text-del' }, `-${stats.deletions || 0} remoções`),
                    el('div', { class: 'stats-badge-item text-muted' }, `${filesList.length} ${filesList.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}`),
                    el('a', {
                      href: detail.html_url || `https://github.com/${owner}/${repoName}/commit/${c.sha}`,
                      target: '_blank',
                      class: 'commit-diff-link',
                      onclick: (e) => e.stopPropagation(),
                    }, 'Ver Diff Completo no GitHub ↗'),
                  ]);
                  detailDrawer.appendChild(statsBar);

                  // Corpo da mensagem de commit detalhada se existir
                  if (bodyText) {
                    const commitBodyEl = el('div', { class: 'commit-full-body' }, bodyText);
                    detailDrawer.appendChild(commitBodyEl);
                  }

                  // Lista de arquivos alterados / corrigidos
                  if (filesList.length) {
                    const filesContainer = el('div', { class: 'commit-files-list' });
                    filesList.forEach(file => {
                      const fileStatus = file.status || 'modified';
                      let statusBadgeClass = 'badge-mod';
                      if (fileStatus === 'added') statusBadgeClass = 'badge-add';
                      else if (fileStatus === 'removed') statusBadgeClass = 'badge-del';

                      const fileRow = el('div', { class: 'commit-file-row' }, [
                        el('span', { class: `badge ${statusBadgeClass}` }, fileStatus),
                        el('span', { class: 'commit-file-name', title: file.filename }, file.filename),
                        el('div', { class: 'commit-file-diff-count' }, [
                          file.additions ? el('span', { class: 'diff-add' }, `+${file.additions}`) : null,
                          file.deletions ? el('span', { class: 'diff-del' }, `-${file.deletions}`) : null,
                        ]),
                      ]);
                      filesContainer.appendChild(fileRow);
                    });
                    detailDrawer.appendChild(filesContainer);
                  }
                } catch (err) {
                  clear(detailDrawer);
                  detailDrawer.appendChild(el('div', { class: 'error-banner-inline' }, `Erro ao obter detalhes do commit: ${err.message}`));
                }
              }
            },
          }, [
            el('div', { class: 'commit-card-head' }, [
              authorAvatar
                ? el('img', { src: authorAvatar, class: 'commit-author-avatar' })
                : el('div', { class: 'commit-author-initial' }, authorName.slice(0, 1).toUpperCase()),
              el('div', { class: 'commit-main-info' }, [
                el('div', { class: 'commit-message-title' }, firstLine),
                el('div', { class: 'commit-meta-line' }, [
                  el('code', { class: 'commit-sha-pill' }, shaShort),
                  el('span', { class: 'commit-author-name' }, authorName),
                  el('span', { class: 'commit-time-tag' }, formatRelativeTime(date)),
                ]),
              ]),
              el('div', { class: 'commit-expand-indicator' }, '▼'),
            ]),
            detailDrawer,
          ]);

          commitsList.appendChild(commitCard);
        });
      } catch (e) {
        clear(commitsList);
        commitsList.appendChild(el('div', { class: 'error-banner' }, `Erro ao carregar commits: ${e.message}`));
      }
    }

    loadCommits();
  }

  // 2. ABA DE COMMIT DIRETO (Criação/Modificação de arquivos múltiplos)
  function renderCommitFormTab(container) {
    const formCard = el('div', { class: 'commit-form-card' });

    formCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('span', { class: 'section-tag' }, 'COMMIT DIRETO VIA API GITHUB'),
      el('span', { class: 'section-sub-tag' }, 'Adicione ou edite arquivos e faça commit na branch sem precisar de git local.'),
    ]));

    const filesState = [{ path: '', content: '' }];
    const filesContainer = el('div', { class: 'commit-files-inputs-container' });

    function renderFilesInputs() {
      clear(filesContainer);
      filesState.forEach((f, index) => {
        const pathInput = el('input', {
          class: 'input-field',
          placeholder: 'Caminho do arquivo (ex: src/components/Button.jsx ou README.md)',
          value: f.path,
        });
        pathInput.addEventListener('input', () => { f.path = pathInput.value; });

        const contentInput = el('textarea', {
          class: 'textarea-field code-textarea',
          placeholder: '// Cole ou digite o conteúdo do arquivo aqui...',
          rows: '6',
        }, f.content);
        contentInput.addEventListener('input', () => { f.content = contentInput.value; });

        const fileBlock = el('div', { class: 'commit-file-input-block' }, [
          el('div', { class: 'file-block-header' }, [
            el('span', { class: 'file-block-badge' }, `ARQUIVO #${index + 1}`),
            filesState.length > 1 ? el('button', {
              class: 'btn-remove-file',
              title: 'Remover este arquivo',
              onclick: () => {
                filesState.splice(index, 1);
                renderFilesInputs();
              },
            }, 'Remover ✕') : null,
          ]),
          el('div', { class: 'file-field-row' }, [
            el('label', { class: 'input-label' }, 'Caminho / Nome do Arquivo'),
            pathInput,
          ]),
          el('div', { class: 'file-field-row' }, [
            el('label', { class: 'input-label' }, 'Conteúdo'),
            contentInput,
          ]),
        ]);
        filesContainer.appendChild(fileBlock);
      });
    }

    renderFilesInputs();
    formCard.appendChild(filesContainer);

    const addFileBtn = el('button', {
      class: 'btn btn-secondary btn-sm',
      style: { marginTop: '8px' },
      onclick: () => {
        filesState.push({ path: '', content: '' });
        renderFilesInputs();
      },
    }, '+ Adicionar Outro Arquivo');
    formCard.appendChild(addFileBtn);

    // Campos de Mensagem e Branch
    const msgInput = el('input', {
      class: 'input-field',
      placeholder: 'Ex: fix(auth): corrigir validação de token e atualizar dependências',
    });

    const branchInput = el('input', {
      class: 'input-field',
      value: repo.branch || 'main',
      placeholder: 'Nome da branch de destino',
    });

    const statusNotice = el('div', { class: 'status-notice-wrap' });

    formCard.appendChild(el('div', { class: 'form-group', style: { marginTop: '14px' } }, [
      el('label', { class: 'input-label' }, 'Mensagem do Commit *'),
      msgInput,
    ]));

    formCard.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Branch de Destino *'),
      branchInput,
    ]));

    formCard.appendChild(statusNotice);

    const submitCommitBtn = el('button', {
      class: 'btn btn-primary btn-commit-submit',
      onclick: async () => {
        clear(statusNotice);
        const validFiles = filesState.filter(f => f.path.trim() && f.content.trim());
        if (!validFiles.length) {
          statusNotice.appendChild(el('div', { class: 'error-banner-inline' }, 'Preencha pelo menos um arquivo com caminho e conteúdo válidos.'));
          return;
        }
        const commitMsg = msgInput.value.trim();
        if (!commitMsg) {
          statusNotice.appendChild(el('div', { class: 'error-banner-inline' }, 'Insira uma mensagem explicativa para o commit.'));
          msgInput.focus();
          return;
        }

        const targetBranch = branchInput.value.trim() || repo.branch || 'main';

        submitCommitBtn.disabled = true;
        submitCommitBtn.textContent = 'Enviando commit para o GitHub...';

        try {
          const result = await gh.createCommit(owner, repoName, targetBranch, validFiles, commitMsg);
          statusNotice.appendChild(el('div', { class: 'success-banner' }, [
            el('span', {}, `✓ Commit realizado com sucesso! SHA: `),
            el('code', {}, result.sha.slice(0, 7)),
            el('a', {
              href: result.url || `https://github.com/${owner}/${repoName}/commit/${result.sha}`,
              target: '_blank',
              style: { marginLeft: '8px', color: '#fff', textDecoration: 'underline' },
            }, 'Ver no GitHub ↗'),
          ]));

          // Reset formulário
          msgInput.value = '';
          filesState.length = 0;
          filesState.push({ path: '', content: '' });
          renderFilesInputs();
        } catch (err) {
          statusNotice.appendChild(el('div', { class: 'error-banner-inline' }, `Falha ao realizar commit: ${err.message}`));
        } finally {
          submitCommitBtn.disabled = false;
          submitCommitBtn.textContent = '⚡ Enviar Commit Direto';
        }
      },
    }, '⚡ Enviar Commit Direto');

    formCard.appendChild(submitCommitBtn);
    container.appendChild(formCard);
  }

  updateSubTabs();
}
