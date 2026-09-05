import { el, clear } from '../util/dom.js';
import { FileExplorer } from './explorer.js';
import { CodeEditor } from './editor.js';
import { WebPreview } from './preview.js';
import { WebTerminal } from './terminal.js';
import { GitPanel } from './git-panel.js';
import { renderChat } from '../views/chat.js';
import { getRepo, getGithub } from '../storage.js';
import { getTree, getFile, createCommit } from '../github.js';

export class WorkspaceView {
  constructor(container) {
    this.container = container;
    this.repo = null;
    this.treeFiles = [];
    this.explorer = null;
    this.editor = null;
    this.preview = null;
    this.terminal = null;
    this.gitPanel = null;

    this.activeMode = 'preview'; // 'preview' | 'code' | 'split'
    this.activePage = 'Página inicial';
    this.plusMenuOpen = false;
    this.history = [
      { id: '1', title: 'Registra auditoria privada e derivada da sessão no...', active: false },
      { id: '2', title: 'Remove unused splash state import to avoid start...', active: true },
    ];
    this.suggestions = [
      'Validar pós-deploy no cache',
      'Adicionar telemetria de falhas',
      'Melhorar UX do header',
      'Adicionar suporte a dark mode',
    ];
  }

  async loadRepoData() {
    this.repo = await getRepo();
    const github = await getGithub();
    if (this.repo && github.token) {
      try {
        const tree = await getTree(this.repo.owner, this.repo.repo, this.repo.branch || 'main');
        this.treeFiles = (tree.tree || []).map(f => f.path);
      } catch (err) {
        console.error('Error loading repo tree:', err);
      }
    }
  }

  async render() {
    clear(this.container);
    await this.loadRepoData();

    const root = el('div', { class: 'lovable-workspace-root' });

    // ==========================================
    // 1. LOVABLE TOP BAR
    // ==========================================
    const topbar = el('header', { class: 'lovable-topbar' }, [
      // Left group
      el('div', { class: 'lovable-tb-left' }, [
        el('button', { class: 'lovable-tb-btn', title: 'Menu', onclick: () => { window.location.hash = '#dashboard'; } }, '☰'),
        el('div', { class: 'lovable-project-dropdown' }, [
          el('span', { class: 'lovable-project-name' }, this.repo?.name || 'mercoo erp'),
          el('span', { class: 'lovable-dropdown-arrow' }, '▾'),
        ]),
        el('button', { class: 'lovable-tb-btn', title: 'Histórico' }, '🕒'),
        el('button', { class: 'lovable-tb-btn', title: 'Alternar Painel' }, '📑'),
      ]),

      // Center Pill Controls
      el('div', { class: 'lovable-tb-center' }, [
        el('div', { class: 'lovable-mode-pills' }, [
          el('button', {
            class: `lovable-pill-btn ${this.activeMode === 'preview' || this.activeMode === 'split' ? 'is-active' : ''}`,
            onclick: () => this.setMode('preview'),
          }, [
            el('span', {}, '🌐'),
            el('span', {}, 'Visualização'),
          ]),
          el('button', {
            class: `lovable-pill-btn ${this.activeMode === 'code' ? 'is-active' : ''}`,
            onclick: () => this.setMode('code'),
            title: 'Código Fonte',
          }, '📄'),
          el('button', { class: 'lovable-pill-icon-btn', title: 'Mais opções' }, '⋮'),
        ]),

        el('div', { class: 'lovable-preview-tools' }, [
          el('button', { class: 'lovable-tb-btn', title: 'Desktop' }, '🖥️'),
          el('button', { class: 'lovable-tb-btn', title: 'Atualizar', onclick: () => this.preview?.reload() }, '🔄'),
          el('div', { class: 'lovable-page-selector' }, [
            el('span', {}, this.activePage),
            el('span', {}, '▾'),
          ]),
          el('button', { class: 'lovable-tb-btn', title: 'Abrir em nova aba', onclick: () => window.open(this.preview?.getUrl() || '#', '_blank') }, '↗'),
        ]),
      ]),

      // Right Group
      el('div', { class: 'lovable-tb-right' }, [
        el('button', { class: 'lovable-btn-secondary' }, 'Compartilhar'),
        el('button', { class: 'lovable-btn-primary' }, 'Publicar'),
      ]),
    ]);

    root.appendChild(topbar);

    // ==========================================
    // 2. MAIN WORKSPACE CONTAINER
    // ==========================================
    const mainArea = el('div', { class: 'lovable-main-area' });

    // ------------------------------------------
    // LEFT PANEL: CHAT & ACTIVITY FEED
    // ------------------------------------------
    const leftPanel = el('div', { class: 'lovable-left-panel' });
    this.renderLeftFeed(leftPanel);

    // ------------------------------------------
    // RIGHT PANEL: PREVIEW & CODE CANVAS
    // ------------------------------------------
    const rightPanel = el('div', { class: 'lovable-right-panel' });
    this.renderRightCanvas(rightPanel);

    mainArea.appendChild(leftPanel);
    mainArea.appendChild(rightPanel);
    root.appendChild(mainArea);

    this.container.appendChild(root);
  }

  setMode(mode) {
    this.activeMode = mode;
    this.render();
  }

  renderLeftFeed(container) {
    clear(container);

    // Activity Feed Cards Container
    const feed = el('div', { class: 'lovable-feed-container' });

    this.history.forEach(item => {
      const card = el('div', { class: `lovable-activity-card ${item.active ? 'is-active' : ''}` }, [
        el('div', { class: 'lovable-card-header' }, [
          el('span', { class: 'lovable-card-github-icon' }, '🐙'),
          el('span', { class: 'lovable-card-title' }, item.title),
        ]),
        el('div', { class: 'lovable-card-actions' }, [
          el('button', { class: 'lovable-card-btn' }, 'Detalhes'),
          el('button', { class: `lovable-card-btn ${item.active ? 'is-active-btn' : ''}` }, item.active ? 'Visualizando prévia' : 'Visualizar'),
        ]),
      ]);
      feed.appendChild(card);
    });

    container.appendChild(feed);

    // Suggestions Carousel
    const suggestionsBox = el('div', { class: 'lovable-suggestions-row' });
    this.suggestions.forEach(sug => {
      const chip = el('button', {
        class: 'lovable-suggestion-chip',
        onclick: () => {
          const input = container.querySelector('.lovable-prompt-textarea');
          if (input) { input.value = sug; input.focus(); }
        },
      }, sug);
      suggestionsBox.appendChild(chip);
    });
    container.appendChild(suggestionsBox);

    // Prompt Input Card (Floating Bottom Box)
    const promptCard = el('div', { class: 'lovable-prompt-card' });

    const textarea = el('textarea', {
      class: 'lovable-prompt-textarea',
      placeholder: 'Pergunte à Lovable...',
      rows: '2',
    });

    // Plus popover menu (Screenshot 1)
    const plusPopover = el('div', { class: `lovable-plus-popover ${this.plusMenuOpen ? 'is-open' : ''}` }, [
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '⚙️'), el('span', {}, 'Configurações'), el('span', { class: 'shortcut' }, 'Ctrl .')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '🎨'), el('span', {}, 'Design system')]),
      el('div', { class: 'lovable-popover-divider' }),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '🕒'), el('span', {}, 'Histórico')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '📖'), el('span', {}, 'Conhecimento')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '🐙'), el('span', {}, 'GitHub')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '🔌'), el('span', {}, 'Conectores do projeto')]),
      el('div', { class: 'lovable-popover-divider' }),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '📷'), el('span', {}, 'Capturar tela')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '@'), el('span', {}, 'Adicionar referência')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '🧩'), el('span', {}, 'Adicionar habilidade')]),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '📎'), el('span', {}, 'Anexar')]),
      el('div', { class: 'lovable-popover-divider' }),
      el('button', { class: 'lovable-popover-item' }, [el('span', {}, '❓'), el('span', {}, 'Ajuda ↗')]),
    ]);

    const toolbar = el('div', { class: 'lovable-prompt-toolbar' }, [
      el('div', { class: 'lovable-tb-left-tools' }, [
        el('button', {
          class: 'lovable-plus-btn',
          onclick: (e) => {
            e.stopPropagation();
            this.plusMenuOpen = !this.plusMenuOpen;
            plusPopover.classList.toggle('is-open', this.plusMenuOpen);
          },
        }, '+'),
        plusPopover,
        el('button', { class: 'lovable-mode-dropdown-btn' }, [
          el('span', {}, 'Construir'),
          el('span', {}, '▾'),
        ]),
      ]),

      el('div', { class: 'lovable-tb-right-tools' }, [
        el('button', { class: 'lovable-icon-action-btn', title: 'Chat por voz' }, '🎙️'),
        el('button', {
          class: 'lovable-send-btn',
          title: 'Enviar',
          onclick: () => {
            const val = textarea.value.trim();
            if (val) {
              this.history.unshift({ id: String(Date.now()), title: val, active: true });
              textarea.value = '';
              this.renderLeftFeed(container);
            }
          },
        }, '⬆'),
      ]),
    ]);

    promptCard.appendChild(textarea);
    promptCard.appendChild(toolbar);

    container.appendChild(promptCard);
  }

  renderRightCanvas(container) {
    clear(container);

    if (this.activeMode === 'code') {
      const codeWrapper = el('div', { class: 'lovable-code-wrapper' });
      const explorerBox = el('div', { class: 'lovable-code-sidebar' });
      const editorBox = el('div', { class: 'lovable-code-main' });

      this.explorer = new FileExplorer(explorerBox, {
        onFileSelect: async (path) => {
          const github = await getGithub();
          if (this.repo && github.token) {
            try {
              const res = await getFile(this.repo.owner, this.repo.repo, path, this.repo.branch || 'main');
              this.editor?.openFile(path, res.text || '');
            } catch {
              this.editor?.openFile(path, '');
            }
          } else {
            this.editor?.openFile(path, '');
          }
        },
      });
      this.explorer.setTree(this.treeFiles);

      this.editor = new CodeEditor(editorBox, {
        onSaveFile: (path, content) => this.preview?.setFileContent(path, content),
      });
      this.editor.render();

      codeWrapper.appendChild(explorerBox);
      codeWrapper.appendChild(editorBox);
      container.appendChild(codeWrapper);
    } else {
      // Preview Mode
      const previewWrapper = el('div', { class: 'lovable-preview-wrapper' });
      const previewBox = el('div', { class: 'lovable-preview-canvas' });

      this.preview = new WebPreview(previewBox, {});
      this.preview.render();
      previewWrapper.appendChild(previewBox);

      // Floating Bottom Canvas Controls (🎯 T 📎 💬)
      const floatingTools = el('div', { class: 'lovable-floating-canvas-bar' }, [
        el('button', { class: 'lovable-canvas-tool-btn', title: 'Inspecionar elemento' }, '🎯'),
        el('button', { class: 'lovable-canvas-tool-btn', title: 'Editar texto' }, 'T'),
        el('button', { class: 'lovable-canvas-tool-btn', title: 'Anexar referência' }, '📎'),
        el('button', { class: 'lovable-canvas-tool-btn', title: 'Adicionar comentário' }, '💬'),
      ]);

      previewWrapper.appendChild(floatingTools);
      container.appendChild(previewWrapper);
    }
  }
}

