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
    this.activeLeftTab = 'files'; // 'files' | 'git'
    this.activeRightTab = 'preview'; // 'preview' | 'terminal' | 'chat'
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

    const workspace = el('div', { class: 'workspace-container' });
    const bottomPanel = el('div', { class: 'workspace-bottom-panel' });
    const bottomTabs = el('div', { class: 'subtab-nav' }, [
      el('button', { class: 'subtab-btn is-active', onclick: () => this.showBottom(bottomPanel, 'terminal') }, 'Terminal'),
      el('button', { class: 'subtab-btn', onclick: () => this.showBottom(bottomPanel, 'console') }, 'Console'),
      el('button', { class: 'subtab-btn', onclick: () => this.showBottom(bottomPanel, 'problems') }, 'Problems'),
    ]);
    const saveState = el('span', { class: 'workspace-save-state badge badge-ok' }, 'Saved');
    const projectHeader = el('header', { class: 'project-editor-header' }, [
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { window.location.hash = '#dashboard'; } }, '← Voltar'),
      el('strong', { class: 'project-editor-name' }, this.repo?.fullName || 'Projeto'),
      saveState,
      el('div', { class: 'project-editor-modes' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => workspace.classList.remove('preview-focus') }, 'Code'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => workspace.classList.add('preview-focus') }, 'Preview'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => workspace.classList.remove('preview-focus') }, 'Split'),
      ]),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.terminal?.executeCommand('npm run dev') }, 'Run'),
    ]);
    workspace.appendChild(projectHeader);

    // 1. COLUNA ESQUERDA (File Explorer & Git Navigation)
    const leftPanel = el('div', { class: 'workspace-left-panel' });
    const leftNav = el('div', { class: 'subtab-nav', style: { margin: '8px' } }, [
      el('button', {
        class: `subtab-btn${this.activeLeftTab === 'files' ? ' is-active' : ''}`,
        onclick: () => { this.activeLeftTab = 'files'; this.renderLeftPanel(leftContent); },
      }, '📁 Arquivos'),
      el('button', {
        class: `subtab-btn${this.activeLeftTab === 'git' ? ' is-active' : ''}`,
        onclick: () => { this.activeLeftTab = 'git'; this.renderLeftPanel(leftContent); },
      }, '🐙 Git'),
    ]);

    const leftContent = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });
    leftPanel.appendChild(leftNav);
    leftPanel.appendChild(leftContent);
    this.renderLeftPanel(leftContent);

    // 2. COLUNA CENTRAL (Multi-tab Code Editor)
    const centerPanel = el('div', { class: 'workspace-center-panel' });
    this.editor = new CodeEditor(centerPanel, {
      onSaveFile: async (path, content) => {
        this.terminal?.log(`Salvando ${path}...`, 'info');
        this.preview?.setFileContent(path, content);
      },
      onChange: (path, content) => {
        this.preview?.setFileContent(path, content);
      },
    });
    this.editor.render();

    // 3. COLUNA DIREITA (Live Preview / Terminal / Chat de IA)
    const rightPanel = el('div', { class: 'workspace-right-panel' });
    const rightNav = el('div', { class: 'subtab-nav', style: { margin: '8px' } }, [
      el('button', {
        class: `subtab-btn${this.activeRightTab === 'preview' ? ' is-active' : ''}`,
        onclick: () => { this.activeRightTab = 'preview'; this.renderRightPanel(rightContent); },
      }, '🌐 Preview'),
      el('button', {
        class: `subtab-btn${this.activeRightTab === 'chat' ? ' is-active' : ''}`,
        onclick: () => { this.activeRightTab = 'chat'; this.renderRightPanel(rightContent); },
      }, '🤖 Agente IA'),
      el('button', {
        class: `subtab-btn${this.activeRightTab === 'terminal' ? ' is-active' : ''}`,
        onclick: () => { this.activeRightTab = 'terminal'; this.renderRightPanel(rightContent); },
      }, '💻 Terminal'),
    ]);

    const rightContent = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });
    rightPanel.appendChild(rightNav);
    rightPanel.appendChild(rightContent);
    this.renderRightPanel(rightContent);

    workspace.appendChild(leftPanel);
    workspace.appendChild(centerPanel);
    workspace.appendChild(rightPanel);
    workspace.appendChild(bottomPanel);
    const statusBar = el('footer', { class: 'project-editor-statusbar' }, [
      el('span', {}, this.repo?.branch || 'main'),
      el('span', {}, 'TypeScript / JavaScript'),
      el('span', { class: 'workspace-cursor' }, 'Ln 1, Col 1'),
      el('span', { class: 'badge badge-ok' }, 'GitHub ●'),
    ]);
    workspace.appendChild(statusBar);
    this.container.appendChild(workspace);
    this.showBottom(bottomPanel, 'terminal');
    bottomPanel.prepend(bottomTabs);
  }

  showBottom(container, tab) {
    const body = container.querySelector('.bottom-panel-content') || el('div', { class: 'bottom-panel-content' });
    clear(body);
    if (!body.parentElement) container.appendChild(body);
    if (tab === 'terminal') {
      const box = el('div', { style: { height: '150px' } });
      this.terminal = new WebTerminal(box, { onSendErrorToAI: () => { this.activeRightTab = 'chat'; } });
      this.terminal.render(); body.appendChild(box);
    } else if (tab === 'console') {
      body.appendChild(el('div', { class: 'empty-inline' }, 'Console disponível após executar projeto.'));
    } else {
      body.appendChild(el('div', { class: 'empty-inline' }, 'Nenhum problema detectado.'));
    }
  }

  renderLeftPanel(container) {
    clear(container);
    if (this.activeLeftTab === 'files') {
      const explorerBox = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column' } });
      this.explorer = new FileExplorer(explorerBox, {
        onFileSelect: async (path) => {
          const github = await getGithub();
          if (this.repo && github.token) {
            try {
              const res = await getFile(this.repo.owner, this.repo.repo, path, this.repo.branch || 'main');
              const content = res.text || '';
              this.editor?.openFile(path, content);
              this.preview?.setFileContent(path, content);
            } catch {
              this.editor?.openFile(path, '');
            }
          } else {
            this.editor?.openFile(path, '');
          }
        },
        onCreateFile: (name) => {
          this.treeFiles.push(name);
          this.explorer?.setTree(this.treeFiles);
          this.editor?.openFile(name, '');
        },
      });
      this.explorer.setTree(this.treeFiles);
      container.appendChild(explorerBox);
    } else {
      const gitBox = el('div', { style: { flex: '1', overflowY: 'auto', padding: '8px' } });
      this.gitPanel = new GitPanel(gitBox, {
        onCommitAndPush: async (message, files) => {
          const github = await getGithub();
          if (this.repo && github.token) {
            await createCommit(this.repo.owner, this.repo.repo, this.repo.branch || 'main', files, message);
          }
        },
      });
      this.gitPanel.setData({ repo: this.repo, branches: [{ name: this.repo?.branch || 'main' }], modifiedFiles: [] });
      container.appendChild(gitBox);
    }
  }

  renderRightPanel(container) {
    clear(container);
    if (this.activeRightTab === 'preview') {
      const previewBox = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column' } });
      this.preview = new WebPreview(previewBox, {
        onFixWithAI: (err) => {
          this.activeRightTab = 'chat';
          this.renderRightPanel(container);
        },
      });
      this.preview.render();
      container.appendChild(previewBox);
    } else if (this.activeRightTab === 'chat') {
      const chatBox = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', height: '100%' } });
      renderChat(chatBox);
      container.appendChild(chatBox);
    } else {
      const terminalBox = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column' } });
      this.terminal = new WebTerminal(terminalBox, {
        onSendErrorToAI: (err) => {
          this.activeRightTab = 'chat';
          this.renderRightPanel(container);
        },
      });
      this.terminal.render();
      container.appendChild(terminalBox);
    }
  }
}
