import { el, clear } from '../util/dom.js';

function getIconForFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return '⚡';
    case 'jsx': case 'tsx': case 'ts': return '⚛️';
    case 'html': return '🌐';
    case 'css': case 'scss': case 'less': return '🎨';
    case 'json': return '📋';
    case 'md': return '📝';
    case 'png': case 'jpg': case 'svg': case 'ico': return '🖼️';
    case 'py': return '🐍';
    case 'java': return '☕';
    case 'php': return '🐘';
    default: return '📄';
  }
}

export class FileExplorer {
  constructor(container, { onFileSelect, onCreateFile, onDeleteFile }) {
    this.container = container;
    this.onFileSelect = onFileSelect;
    this.onCreateFile = onCreateFile;
    this.onDeleteFile = onDeleteFile;
    this.tree = [];
    this.selectedPath = null;
    this.modifiedFiles = new Set();
  }

  setTree(files = [], modifiedPaths = []) {
    this.tree = files;
    this.modifiedFiles = new Set(modifiedPaths);
    this.render();
  }

  render() {
    clear(this.container);

    const header = el('div', { class: 'file-explorer-header' }, [
      el('span', { class: 'file-explorer-title' }, 'ARQUIVOS DO PROJETO'),
      el('div', { style: { display: 'flex', gap: '4px' } }, [
        el('button', {
          class: 'btn btn-ghost btn-sm',
          title: 'Novo Arquivo',
          onclick: () => {
            const name = prompt('Nome do novo arquivo:');
            if (name) this.onCreateFile?.(name);
          },
        }, '+ Arquivo'),
      ]),
    ]);

    const body = el('div', { style: { flex: '1', overflowY: 'auto', padding: '6px 0' } });

    if (!this.tree.length) {
      body.appendChild(el('div', { class: 'empty-inline', style: { padding: '12px', textAlign: 'center' } },
        'Nenhum arquivo carregado ainda.'));
    } else {
      this.tree.forEach(item => {
        const path = typeof item === 'string' ? item : (item.path || item.name);
        const icon = getIconForFile(path);
        const isModified = this.modifiedFiles.has(path);

        const row = el('div', {
          class: `tree-node-item${this.selectedPath === path ? ' is-selected' : ''}`,
          onclick: () => {
            this.selectedPath = path;
            this.render();
            this.onFileSelect?.(path);
          },
        }, [
          el('span', { style: { fontSize: '14px' } }, icon),
          el('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, path),
          isModified ? el('span', { class: 'git-badge-m', title: 'Modificado' }, 'M') : null,
        ]);

        body.appendChild(row);
      });
    }

    this.container.appendChild(header);
    this.container.appendChild(body);
  }
}
