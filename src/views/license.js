import { el, clear } from '../util/dom.js';
import {
  getLicenseConfig, getLicenseStatus, validateLicense, deactivateLicense,
} from '../license.js';
import { syncService, modelService, skillService, remoteConfigService } from '../backend/index.js';

const keyPattern = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const date = value => value ? new Date(value).toLocaleDateString('pt-BR') : 'Não informado';
const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : 'Nunca';

export async function renderLicense(view) {
  clear(view);
  const [config, status] = await Promise.all([getLicenseConfig(), getLicenseStatus()]);
  const box = el('div', { class: 'page-section', style: { maxWidth: '680px', margin: '0 auto' } });
  view.appendChild(box);

  box.appendChild(el('div', { class: 'page-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Licença & Sincronização Remota'),
      el('p', { class: 'page-desc' }, 'Gerencie sua licença, verifique modelos de IA e skills disponibilizadas pelo backend.'),
    ]),
    el('a', {
      class: 'btn btn-secondary btn-sm',
      href: 'http://localhost:8080/admin/licenses',
      target: '_blank',
      style: { textDecoration: 'none' },
    }, '🛡️ Painel Admin ↗'),
  ]));

  const notice = el('div');
  const show = (message, error = false) => {
    clear(notice);
    notice.appendChild(el('div', { class: error ? 'error-banner-inline' : 'success-banner' }, message));
  };

  if (status.isActivated) {
    // Card do Status da Licença
    box.appendChild(el('div', { class: 'active-repo-banner' }, [
      el('div', { class: 'active-repo-badge' }, 'LICENÇA ATIVA'),
      el('div', { class: 'active-repo-content' }, [
        el('div', { class: 'active-repo-info' }, [
          el('div', { class: 'active-repo-title' }, `Licença #${status.licenseId || 'Ativa'}`),
          el('div', { class: 'active-repo-meta' }, [
            el('span', {}, `Plano: ${status.plan || 'Padrão'}`),
            el('span', {}, `Expira em: ${date(status.expiresAt)}`),
            el('span', {}, `Dispositivo: ${status.deviceName}`),
          ]),
        ]),
      ]),
    ]));

    // Ações de Licença
    const actions = el('div', { class: 'modal-footer', style: { marginTop: '12px', marginBottom: '20px' } });
    actions.appendChild(el('button', {
      class: 'btn btn-ghost-danger btn-sm',
      onclick: async () => {
        try {
          await deactivateLicense();
          show('Dispositivo desconectado com sucesso.');
          await renderLicense(view);
        } catch (err) {
          show(err.message, true);
        }
      },
    }, 'Sair deste dispositivo'));

    if (config.renewUrl) {
      actions.appendChild(el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => window.open(config.renewUrl, '_blank', 'noopener'),
      }, 'Renovar Licença'));
    }
    box.appendChild(actions);

    // Seção de Sincronização Remota
    const cacheMeta = await remoteConfigService.getCacheMeta();
    const syncCard = el('div', { class: 'config-card', style: { marginBottom: '20px' } });
    const syncBtn = el('button', { class: 'btn btn-secondary btn-sm' }, '🔄 Sincronizar Agora');
    
    syncCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('div', {}, [
        el('span', { class: 'section-tag' }, 'Sincronização Remota'),
        el('p', { class: 'section-sub-tag' }, `Última sincronização: ${dateTime(cacheMeta.syncedAt)}`),
      ]),
      syncBtn,
    ]));

    const syncFeedback = el('div');
    syncCard.appendChild(syncFeedback);

    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Sincronizando...';
      clear(syncFeedback);
      try {
        await syncService.sync();
        syncFeedback.appendChild(el('div', { class: 'success-banner', style: { marginTop: '8px' } }, '✓ Sincronização concluída com sucesso!'));
        setTimeout(() => renderLicense(view), 800);
      } catch (err) {
        syncFeedback.appendChild(el('div', { class: 'error-banner-inline', style: { marginTop: '8px' } }, `Falha na sincronização: ${err.message}`));
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '🔄 Sincronizar Agora';
      }
    });
    box.appendChild(syncCard);

    // Seção de Modelos Autorizados pela Licença
    const models = await modelService.list();
    const modelsCard = el('div', { class: 'config-card', style: { marginBottom: '20px' } });
    modelsCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('div', {}, [
        el('span', { class: 'section-tag' }, `Modelos de IA Autorizados (${models.length})`),
        el('p', { class: 'section-sub-tag' }, 'Modelos ativos e limites liberados pelo backend para a sua licença.'),
      ]),
    ]));

    if (!models.length) {
      modelsCard.appendChild(el('div', { class: 'empty-inline', style: { padding: '12px' } },
        'Nenhum modelo customizado recebido do backend. A extensão usará modelos padrão configurados.'));
    } else {
      const modelsGrid = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } });
      models.forEach(m => {
        const item = el('div', {
          style: {
            padding: '10px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          },
        }, [
          el('div', { style: { minWidth: '0', flex: '1', marginRight: '10px' } }, [
            el('div', { style: { fontWeight: '600', color: '#fff', fontSize: '13px' } }, [
              m.display_name || m.name || m.id,
              el('span', { class: 'badge badge-ok', style: { marginLeft: '8px', fontSize: '10px' } }, 'ativo'),
            ]),
            m.description ? el('div', { style: { fontSize: '11px', color: 'var(--text-mute)', marginTop: '2px' } }, m.description) : null,
          ]),
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
            m.context_window ? el('span', { class: 'badge badge-dim', title: 'Context Window' }, `Contexto: ${Math.round(m.context_window / 1000)}K`) : null,
            m.input_token_limit ? el('span', { class: 'badge badge-dim', title: 'Input Limit' }, `In: ${Math.round(m.input_token_limit / 1000)}K`) : null,
            m.output_token_limit || m.max_tokens ? el('span', { class: 'badge badge-dim', title: 'Output Limit' }, `Out: ${Math.round((m.output_token_limit || m.max_tokens) / 1000)}K`) : null,
          ]),
        ]);
        modelsGrid.appendChild(item);
      });
      modelsCard.appendChild(modelsGrid);
    }
    box.appendChild(modelsCard);

    // Seção de Skills Remotas Autorizadas pela Licença
    const skills = await skillService.list();
    const skillsCard = el('div', { class: 'config-card' });
    skillsCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('div', {}, [
        el('span', { class: 'section-tag' }, `Skills Autorizadas (${skills.length})`),
        el('p', { class: 'section-sub-tag' }, 'Funcionalidades e automações disponibilizadas remotamente.'),
      ]),
    ]));

    if (!skills.length) {
      skillsCard.appendChild(el('div', { class: 'empty-inline', style: { padding: '12px' } },
        'Nenhuma skill remota extra registrada no backend para esta licença.'));
    } else {
      const skillsGrid = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } });
      skills.forEach(s => {
        const item = el('div', {
          style: {
            padding: '10px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          },
        }, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
            el('span', { style: { fontSize: '18px' } }, s.icon || '⚡'),
            el('div', {}, [
              el('div', { style: { fontWeight: '600', color: '#fff', fontSize: '13px' } }, s.name || s.slug),
              s.description ? el('div', { style: { fontSize: '11px', color: 'var(--text-mute)' } }, s.description) : null,
            ]),
          ]),
          el('span', { class: 'badge badge-ok' }, s.version ? `v${s.version}` : 'habilitada'),
        ]);
        skillsGrid.appendChild(item);
      });
      skillsCard.appendChild(skillsGrid);
    }
    box.appendChild(skillsCard);

  } else {
    // Formulário de Ativação da Licença
    const rememberedKey = (await chrome.storage.local.get('tom.remember_license_key'))?.['tom.remember_license_key'] || '';
    const initialKey = status.licenseKey || rememberedKey;

    const input = el('input', {
      class: 'input-field',
      placeholder: 'XXXX-XXXX-XXXX-XXXX',
      maxlength: '19',
      value: initialKey,
    });
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).replace(/(.{4})/g, '$1-').replace(/-$/, '');
    });

    const rememberCheckbox = el('input', {
      type: 'checkbox',
      id: 'remember-license-token',
      checked: true,
      style: { cursor: 'pointer', accentColor: 'var(--accent, #6366f1)' },
    });

    const rememberLabel = el('label', {
      for: 'remember-license-token',
      style: { fontSize: '12px', color: 'var(--text-mute)', cursor: 'pointer', userSelect: 'none' },
    }, 'Lembrar token');

    const rememberRow = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px' },
    }, [rememberCheckbox, rememberLabel]);

    const saveKeyBtn = el('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      onclick: async () => {
        const key = input.value.trim();
        if (!keyPattern.test(key)) return show('Formato inválido. Use XXXX-XXXX-XXXX-XXXX.', true);
        await chrome.storage.local.set({
          'tom.license_key': key,
          'tom.remember_license_key': key,
        });
        show('Licença salva localmente com sucesso!');
      },
    }, '💾 Salvar Licença');

    const activate = el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const key = input.value.trim();
        if (!keyPattern.test(key)) return show('Formato inválido. Use XXXX-XXXX-XXXX-XXXX.', true);
        activate.disabled = true;
        activate.textContent = 'Validando...';
        try {
          if (!(await validateLicense(key))) {
            show('Licença inválida ou expirada.', true);
          } else {
            if (rememberCheckbox.checked) {
              await chrome.storage.local.set({ 'tom.remember_license_key': key });
            } else {
              await chrome.storage.local.remove('tom.remember_license_key');
            }
            await syncService.sync().catch(() => {});
            await renderLicense(view);
          }
        } catch (err) {
          show(err.message, true);
        } finally {
          activate.disabled = false;
          activate.textContent = 'Ativar Licença';
        }
      },
    }, 'Ativar Licença');

    box.appendChild(el('div', { class: 'modal-box', style: { marginTop: '16px' } }, [
      el('label', { class: 'input-label' }, 'License key'),
      input,
      rememberRow,
      notice,
      el('div', { style: { marginTop: '14px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        activate,
        saveKeyBtn,
        config.purchaseUrl ? el('a', { href: config.purchaseUrl, target: '_blank', rel: 'noopener', class: 'btn btn-ghost' }, 'Onde conseguir uma licença?') : null,
      ]),
    ]));
  }
}

