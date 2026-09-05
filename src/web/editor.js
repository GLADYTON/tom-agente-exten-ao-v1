import { el, clear } from '../util/dom.js';

export class CodeEditor {
  constructor(container, { onSaveFile, onChange }) {
    this.container = container;
    this.onSaveFile = onSaveFile;
    this.onChange = onChange;
    this.openTabs = new Map(); // path -> { content, originalContent, isDirty }
    this.activePath = null;
  }

  openFile(path, content = '') {
    if (!this.openTabs.has(path)) {
      this.openTabs.set(path, { content, originalContent: content, isDirty: false });
    }
    this.activePath = path;
    this.render();
  }

  updateContent(path, newContent) {
    const tab = this.openTabs.get(path);
    if (tab) {
      tab.content = newContent;
      tab.isDirty = tab.content !== tab.originalContent;
      if (this.activePath === path) this.render();
    }
  }

  markSaved(path) {
    const tab = this.openTabs.get(path);
    if (tab) {
      tab.originalContent = tab.content;
      tab.isDirty = false;
      this.render();
    }
  }

  closeTab(path) {
    this.openTabs.delete(path);
    if (this.activePath === path) {
      const keys = Array.from(this.openTabs.keys());
      this.activePath = keys.length ? keys[keys.length - 1] : null;
    }
    this.render();
  }

  render() {
    clear(this.container);

    const tabBar = el('div', { class: 'editor-tab-bar' });
    this.openTabs.forEach((tab, path) => {
      const filename = path.split('/').pop() || path;
      const isActive = this.activePath === path;

      const tabEl = el('div', {
        class: `editor-tab${isActive ? ' active' : ''}`,
        onclick: () => {
          this.activePath = path;
          this.render();
        },
      }, [
        el('span', {}, `${filename}${tab.isDirty ? ' *' : ''}`),
        el('span', {
          class: 'editor-tab-close',
          onclick: (e) => {
            e.stopPropagation();
            this.closeTab(path);
          },
        }, '✕'),
      ]);
      tabBar.appendChild(tabEl);
    });

    const activeTab = this.activePath ? this.openTabs.get(this.activePath) : null;

    const editorBody = el('div', { class: 'editor-code-container' });

    if (!activeTab) {
      editorBody.appendChild(el('div', { class: 'welcome-box', style: { margin: 'auto' } }, [
        el('div', { class: 'welcome-avatar' }, '💻'),
        el('div', { class: 'welcome-title' }, 'Selecione um arquivo no Explorer'),
        el('div', { class: 'welcome-desc' }, 'Abra arquivos na barra lateral para visualizar e editar o código.'),
      ]));
    } else {
      const lineCount = (activeTab.content.match(/\n/g) || []).length + 1;
      const lineNums = el('div', { class: 'editor-line-numbers' });
      for (let i = 1; i <= Math.max(lineCount, 30); i++) {
        lineNums.appendChild(el('div', {}, String(i)));
      }

      const textarea = el('textarea', {
        class: 'editor-textarea',
        value: activeTab.content,
        placeholder: 'Digite seu código aqui...',
      });

      textarea.addEventListener('input', () => {
        activeTab.content = textarea.value;
        activeTab.isDirty = activeTab.content !== activeTab.originalContent;
        this.onChange?.(this.activePath, activeTab.content);
        
        // Atualiza números de linha se a quantidade mudar
        const newCount = (textarea.value.match(/\n/g) || []).length + 1;
        if (newCount !== lineCount) {
          clear(lineNums);
          for (let i = 1; i <= Math.max(newCount, 30); i++) {
            lineNums.appendChild(el('div', {}, String(i)));
          }
        }
      });

      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          this.markSaved(this.activePath);
          this.onSaveFile?.(this.activePath, activeTab.content);
        }
      });

      editorBody.appendChild(lineNums);
      editorBody.appendChild(textarea);
    }

    this.container.appendChild(tabBar);
    this.container.appendChild(editorBody);
  }
}
