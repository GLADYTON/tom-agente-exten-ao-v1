import { el, clear } from '../util/dom.js';

export class CodeDiffView {
  constructor(container) {
    this.container = container;
  }

  renderDiff(oldText = '', newText = '', filename = '') {
    clear(this.container);

    const header = el('div', { class: 'file-explorer-header' }, [
      el('span', { class: 'file-explorer-title' }, `COMPARAÇÃO DE DIFF — ${filename}`),
    ]);

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    const diffBox = el('div', {
      style: {
        flex: '1',
        overflowY: 'auto',
        padding: '12px',
        fontFamily: 'var(--mono)',
        fontSize: '12px',
        lineHeight: '1.6',
        background: 'var(--bg)',
      },
    });

    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      const oldL = oldLines[i];
      const newL = newLines[i];

      if (oldL !== undefined && newL !== undefined && oldL !== newL) {
        // Linha removida
        diffBox.appendChild(el('div', {
          style: { background: 'rgba(248, 113, 113, 0.15)', color: '#fca5a5', padding: '1px 8px' },
        }, `- ${oldL}`));
        // Linha adicionada
        diffBox.appendChild(el('div', {
          style: { background: 'rgba(52, 211, 153, 0.15)', color: '#6ee7b7', padding: '1px 8px' },
        }, `+ ${newL}`));
      } else if (oldL === undefined) {
        diffBox.appendChild(el('div', {
          style: { background: 'rgba(52, 211, 153, 0.15)', color: '#6ee7b7', padding: '1px 8px' },
        }, `+ ${newL}`));
      } else if (newL === undefined) {
        diffBox.appendChild(el('div', {
          style: { background: 'rgba(248, 113, 113, 0.15)', color: '#fca5a5', padding: '1px 8px' },
        }, `- ${oldL}`));
      } else {
        diffBox.appendChild(el('div', {
          style: { color: 'var(--text-dim)', padding: '1px 8px' },
        }, `  ${oldL}`));
      }
    }

    this.container.appendChild(header);
    this.container.appendChild(diffBox);
  }
}
