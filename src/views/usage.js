import { el, clear, fmtCost, fmtTokens } from '../util/dom.js';
import { getUsage, resetUsage, getBudget, getProviders } from '../storage.js';

export async function renderUsage(view) {
  clear(view);
  const [usage, budget, providers] = await Promise.all([
    getUsage(), getBudget(), getProviders(),
  ]);

  const months = Object.keys(usage).sort().reverse();

  // Cabeçalho da página
  const pageHeader = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Consumo & Métricas de IA'),
      el('p', { class: 'page-desc' }, 'Estimativa de custo e tokens calculados a partir dos preços cadastrados.'),
    ]),
  ]);
  view.appendChild(pageHeader);

  // Card resumo do orçamento
  const summaryCard = el('div', { class: 'config-card' });
  summaryCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Resumo Geral'),
      el('p', { class: 'section-sub-tag' }, 'Acompanhamento do ciclo atual e ações de manutenção.'),
    ]),
    el('button', {
      class: 'btn btn-ghost-danger btn-sm',
      onclick: async () => {
        if (!confirm('Zerar contadores de uso locais? Isso não afeta seu faturamento real nos provedores.')) return;
        await resetUsage();
        renderUsage(view);
      },
    }, 'Zerar contadores'),
  ]));

  if (budget.monthlyUSD > 0) {
    const cur = months[0] ? months[0] : new Date().toISOString().slice(0, 7);
    const spent = Object.values(usage[cur] || {}).reduce((a, r) => a + (r.cost || 0), 0);
    const pct = Math.min(100, (spent / budget.monthlyUSD) * 100);

    let budgetPillClass = 'pill ok';
    if (pct >= 100) budgetPillClass = 'pill err';
    else if (pct >= 80) budgetPillClass = 'pill warn';

    summaryCard.appendChild(el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } }, [
      el('span', { class: 'pill' }, `Orçamento: $${budget.monthlyUSD.toFixed(2)}/mês`),
      el('span', { class: budgetPillClass }, `${pct.toFixed(1)}% utilizado (${fmtCost(spent)})`),
    ]));
  } else {
    summaryCard.appendChild(el('div', { class: 'field-hint' }, 'Nenhum teto orçamentário configurado (defina na aba Modelos).'));
  }
  view.appendChild(summaryCard);

  if (!months.length) {
    const emptyBox = el('div', { class: 'empty-card', style: { marginTop: '14px' } }, [
      el('div', { class: 'empty-icon-wrap' }, '📊'),
      el('h3', { class: 'empty-title' }, 'Nenhum uso registrado'),
      el('p', { class: 'empty-text' }, 'Converse com os agentes no chat para gerar métricas de tokens e custo por modelo.'),
    ]);
    view.appendChild(emptyBox);
    return;
  }

  // Lista por mês
  for (const month of months) {
    const monthCard = el('div', { class: 'config-card', style: { marginTop: '14px' } });
    monthCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('span', { class: 'section-tag' }, `Ciclo · ${month}`),
    ]));

    const rows = Object.entries(usage[month] || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
    let totIn = 0, totOut = 0, totCost = 0, totCalls = 0;

    const stack = el('div', { class: 'providers-stack' });

    for (const [key, v] of rows) {
      const [pid, mid] = key.split('::');
      const p = providers.find(pp => pp.id === pid);
      const m = p?.models?.find(mm => mm.id === mid);
      const label = p ? `${p.name || p.type} · ${m?.label || mid}` : key;
      totIn += v.input || 0;
      totOut += v.output || 0;
      totCost += v.cost || 0;
      totCalls += v.calls || 0;

      stack.appendChild(el('div', { class: 'provider-row-v2' }, [
        el('div', { class: 'provider-icon-badge' }, (p?.name || p?.type || 'AI').slice(0, 2).toUpperCase()),
        el('div', { class: 'provider-row-body' }, [
          el('div', { class: 'provider-row-title' }, [
            el('span', {}, label),
            el('span', { class: 'pill' }, fmtCost(v.cost)),
          ]),
          el('div', { class: 'provider-row-meta' },
            `${v.calls} chamadas · in ${fmtTokens(v.input)} · out ${fmtTokens(v.output)}`),
        ]),
      ]));
    }
    monthCard.appendChild(stack);

    // Linha de total
    monthCard.appendChild(el('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: '12px',
        paddingTop: '10px',
        borderTop: '1px solid var(--border)',
        fontSize: '11.5px',
        color: 'var(--text-dim)',
      },
    }, [
      el('span', {}, `Total: ${totCalls} chamadas · in ${fmtTokens(totIn)} · out ${fmtTokens(totOut)}`),
      el('span', { class: 'pill ok' }, fmtCost(totCost)),
    ]));

    view.appendChild(monthCard);
  }
}
