import { el, clear } from '../util/dom.js';
import { PROVIDER_TYPES, getProviderType } from '../providers/catalog.js';
import {
  AUTH_SCHEMES, fetchGatewayModels, gatewayBase, gatewayChatUrl, gatewayModelsUrl,
} from '../providers/client.js';
import { ensureOriginPermission } from '../util/perms.js';
import {
  getProviders, upsertProvider, removeProvider,
  getActiveModel, setActiveModel,
  getBudget, setBudget,
  getSettings, setSettings,
} from '../storage.js';

const CREDENTIAL_TYPES = [
  { id: 'static_key', label: 'Chave de API estática' },
  { id: 'none', label: 'Sem credencial (gateway aberto)' },
];

function newId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

function sortedTypes() {
  const score = t => {
    if (isGatewayType(t)) return -1;
    if (t.free) return 0;
    return t.models?.some(m => m.free) ? 1 : 2;
  };
  return [...PROVIDER_TYPES].sort((a, b) => score(a) - score(b));
}

function isGatewayType(type) {
  return !!(type && (type.isCustomGateway || type.readyToUse || type.id === 'dgsis-gateway'));
}

function isGatewayProvider(p) {
  return !!(p && (p.isGateway || isGatewayType(getProviderType(p.type))));
}

function matchesQuery(type, q) {
  if (!q) return true;
  const hay = [type.label, type.tagline, type.id, ...(type.models || []).map(m => m.label || m.id)]
    .join(' ').toLowerCase();
  return hay.includes(q);
}

function providerTile(type, onPick) {
  const iconLetter = (type.label || '?').slice(0, 2).toUpperCase();
  const isGw = isGatewayType(type);
  const isFree = type.free || type.models?.some(m => m.free);

  let footBadge;
  if (isGw) {
    footBadge = el('span', { class: 'badge badge-ok' }, 'gateway');
  } else if (type.free) {
    footBadge = el('span', { class: 'badge badge-ok' }, '100% grátis');
  } else if (isFree) {
    footBadge = el('span', { class: 'badge badge-ok' }, 'tier grátis');
  } else {
    footBadge = el('span', { class: 'badge badge-dim' }, 'pago');
  }

  const countBadge = type.isCustomGateway
    ? el('span', { class: 'badge badge-dim' }, 'auto-busca')
    : el('span', { class: 'badge badge-dim' }, `${(type.models || []).length} mod.`);

  return el('button', {
    class: 'provider-tile-btn' + (isFree || isGw ? ' is-free' : ''),
    onclick: () => onPick(type),
  }, [
    el('div', { class: 'tile-head' }, [
      el('div', { class: 'tile-icon' }, isGw ? 'GW' : iconLetter),
      el('div', { style: { minWidth: '0' } }, [
        el('div', { class: 'tile-title' }, type.label),
        type.tagline ? el('div', { class: 'tile-tag' }, type.tagline) : null,
      ]),
    ]),
    el('div', { class: 'tile-foot' }, [
      footBadge,
      countBadge,
    ]),
  ]);
}

// Modal unificado: suporta tanto provedores comuns quanto o formulário de gateway avançado.
function openProviderModal({ providers, initialProvider = null, initialType = null, onDone }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal-box' });

  // Se já veio com provider pra editar ou tipo pré-escolhido, pula o picker.
  let step = (initialProvider || initialType) ? 2 : 1;
  let pickedType = initialType || (initialProvider ? getProviderType(initialProvider.type) : null);
  let editingProvider = initialProvider || null;
  let query = '';

  function close(done) {
    backdrop.remove();
    if (done) onDone?.();
  }

  function render() {
    clear(box);

    if (step === 1) {
      renderStep1Picker();
    } else {
      const isGateway = isGatewayType(pickedType) || isGatewayProvider(editingProvider);
      if (isGateway) {
        renderGatewayForm();
      } else {
        renderStandardProviderForm();
      }
    }
  }

  // --- PASSO 1: Grade de Provedores
  function renderStep1Picker() {
    box.appendChild(el('div', { class: 'modal-header' }, [
      el('div', {}, [
        el('h3', { class: 'modal-title' }, 'Adicionar Provedor de IA'),
        el('p', { class: 'modal-subtitle' }, 'Escolha seu gateway próprio ou um provedor pré-configurado.'),
      ]),
      el('button', { class: 'modal-close-btn', onclick: () => close(false) }, '✕'),
    ]));

    const search = el('input', {
      class: 'input-field',
      placeholder: 'Buscar provedor ou modelo...',
      value: query,
    });

    const grid = el('div', { class: 'provider-picker-grid' });

    function fillGrid() {
      clear(grid);
      const q = query.trim().toLowerCase();
      const list = sortedTypes().filter(t => matchesQuery(t, q));
      if (!list.length) {
        grid.appendChild(el('div', { class: 'empty-inline' }, 'Nenhum provedor encontrado.'));
        return;
      }
      list.forEach(t => {
        grid.appendChild(providerTile(t, (type) => {
          pickedType = type;
          editingProvider = providers.find(p => p.type === type.id) || null;
          step = 2;
          render();
        }));
      });
    }

    search.addEventListener('input', () => { query = search.value; fillGrid(); });

    const body = el('div', { class: 'modal-body' }, [
      el('div', { class: 'form-group' }, [search]),
      grid,
    ]);
    box.appendChild(body);
    fillGrid();
    setTimeout(() => search.focus(), 50);
  }

  // --- PASSO 2 (GATEWAY): Formulário completo espelhado no Claude Desktop
  function renderGatewayForm() {
    const existing = editingProvider;
    const typeDef = pickedType || (existing ? getProviderType(existing.type) : null);

    const isDgsisPreset = (pickedType?.id === 'dgsis-gateway') || (existing?.type === 'dgsis-gateway');

    let currentModels = existing?.models ? JSON.parse(JSON.stringify(existing.models)) : (typeDef?.models ? JSON.parse(JSON.stringify(typeDef.models)) : []);

    // Salvar sem nenhum modelo exige um segundo clique confirmando.
    let allowEmptySave = false;

    box.appendChild(el('div', { class: 'modal-header' }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        !existing ? el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => { step = 1; render(); },
          title: 'Voltar',
        }, '← Voltar') : null,
        el('div', {}, [
          el('h3', { class: 'modal-title' }, existing?.name || typeDef?.label || 'Configurar Gateway'),
          el('p', { class: 'modal-subtitle' }, 'Inferência própria compatível com OpenAI API'),
        ]),
      ]),
      el('button', { class: 'modal-close-btn', onclick: () => close(false) }, '✕'),
    ]));

    const body = el('div', { class: 'modal-body' });

    // 0. Nome amigável
    const nameInp = el('input', {
      class: 'input-field',
      value: existing?.name || (isDgsisPreset ? 'Gateway Próprio (DGSIS)' : (typeDef?.label || 'Meu Gateway')),
      placeholder: 'Ex: Gateway Interno, DGSIS Cloud...',
    });
    body.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Nome do Provedor'),
      nameInp,
    ]));

    // 1. Tipo de Credencial
    const credSel = el('select', { class: 'select-field' });
    CREDENTIAL_TYPES.forEach(ct => {
      const opt = el('option', { value: ct.id }, ct.label);
      if ((existing?.credentialType || 'static_key') === ct.id) opt.selected = true;
      credSel.appendChild(opt);
    });
    body.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Tipo de credencial'),
      credSel,
    ]));

    // 2. URL base do gateway
    const defaultEndpoint = existing?.endpoint
      ? gatewayBase(existing.endpoint)
      : (typeDef?.endpoint ? gatewayBase(typeDef.endpoint) : (isDgsisPreset ? 'https://gtw.cloud2.dgsis.com.br' : ''));

    const baseInp = el('input', {
      class: 'input-field',
      value: defaultEndpoint,
      placeholder: 'https://gtw.cloud2.dgsis.com.br/',
    });
    body.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'URL base do gateway *'),
      baseInp,
      el('div', { class: 'field-hint' }, 'Caminhos /v1/chat/completions e /v1/models são deduzidos automaticamente. Na primeira vez o Chrome pede permissão de acesso a este domínio.'),
    ]));

    // 3. Chave de API do gateway
    const defaultKey = existing?.apiKey ?? (typeDef?.defaultApiKey || '');
    const keyInp = el('input', {
      class: 'input-field',
      type: 'password',
      value: defaultKey,
      placeholder: 'sk-...',
    });
    const keyGroup = el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Chave de API do gateway'),
      keyInp,
      el('div', { class: 'field-hint' }, 'Salva localmente com segurança no storage da sua extensão.'),
    ]);
    body.appendChild(keyGroup);

    // Toggle de visibilidade da chave baseado no tipo de credencial
    function syncCredVisibility() {
      const needsKey = credSel.value === 'static_key';
      keyGroup.style.display = needsKey ? 'block' : 'none';
    }
    credSel.addEventListener('change', syncCredVisibility);
    syncCredVisibility();

    // 4. Esquema de autenticação do gateway
    const authSel = el('select', { class: 'select-field' });
    const curScheme = existing?.authScheme || typeDef?.authScheme || 'bearer';
    AUTH_SCHEMES.forEach(s => {
      const opt = el('option', { value: s.id }, s.label);
      if (curScheme === s.id) opt.selected = true;
      authSel.appendChild(opt);
    });
    body.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Esquema de autenticação do gateway'),
      authSel,
      el('div', { class: 'field-hint' }, 'Dica: a maioria usa bearer; se o gateway esperar o header x-api-key, selecione x-api-key.'),
    ]));

    // 5. Origem do iframe de visualização de artefato (opcional, como no Claude Desktop)
    const iframeInp = el('input', {
      class: 'input-field',
      value: existing?.artifactIframeOrigin || '',
      placeholder: 'Opcional (ex: https://artifacts.seu-dominio.com)',
    });
    body.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Origem do iframe de visualização de artefato'),
      iframeInp,
      el('div', { class: 'field-hint' }, 'Origem segura para isolar iframes de artefatos dinâmicos (opcional).'),
    ]));

    // 6. Área de Ações: Testar Conexão + Puxar Modelos
    const actionsRow = el('div', {
      style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' },
    });

    const testBtn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, '⚡ Testar conexão');
    const fetchBtn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, '🔄 Puxar modelos da API');
    actionsRow.appendChild(testBtn);
    actionsRow.appendChild(fetchBtn);
    body.appendChild(actionsRow);

    // Feedback dinâmico de teste/busca
    const feedbackBox = el('div');
    body.appendChild(feedbackBox);

    // 7. Lista / resumo dos modelos carregados
    const modelsSection = el('div', { class: 'form-group', style: { marginTop: '4px' } });
    const modelsHeader = el('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
    });
    const modelsCountLabel = el('label', { class: 'input-label', style: { margin: '0' } });
    modelsHeader.appendChild(modelsCountLabel);
    modelsSection.appendChild(modelsHeader);

    const modelsListContainer = el('div', {
      style: {
        maxHeight: '160px',
        overflowY: 'auto',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--bg)',
        padding: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
    });
    modelsSection.appendChild(modelsListContainer);
    body.appendChild(modelsSection);

    function updateModelsList() {
      clear(modelsListContainer);
      modelsCountLabel.textContent = `Modelos disponíveis (${currentModels.length})`;
      if (!currentModels.length) {
        modelsListContainer.appendChild(el('div', { class: 'empty-inline', style: { padding: '8px' } },
          'Nenhum modelo carregado ainda. Clique em "Puxar modelos da API" acima para sincronizar via /models.'));
        return;
      }
      currentModels.forEach(m => {
        const item = el('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-xs)',
            fontSize: '11.5px',
          },
        }, [
          el('div', { style: { minWidth: '0', flex: '1', marginRight: '6px' } }, [
            el('div', { style: { fontWeight: '600', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.label || m.id),
            el('div', { style: { fontSize: '10px', color: 'var(--text-mute)', fontFamily: 'var(--mono)' } }, m.id),
          ]),
          el('span', { class: 'badge badge-dim' }, `${Math.round((m.context || 128000) / 1000)}k`),
        ]);
        modelsListContainer.appendChild(item);
      });
    }
    updateModelsList();

    // Handlers de Teste e Puxar Modelos
    function getFormConfig() {
      const base = baseInp.value.trim();
      return {
        endpoint: base,
        apiKey: credSel.value === 'static_key' ? keyInp.value.trim() : '',
        authScheme: authSel.value,
      };
    }

    testBtn.addEventListener('click', async () => {
      clear(feedbackBox);
      const cfg = getFormConfig();
      if (!cfg.endpoint) {
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, 'Preencha a URL base do gateway antes de testar.'));
        baseInp.focus();
        return;
      }
      // Precisa ser a primeira await do handler: chrome.permissions.request()
      // só funciona enquanto o gesto de clique do usuário ainda está válido.
      const perm = await ensureOriginPermission(cfg.endpoint);
      if (!perm.granted) {
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, perm.error));
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = 'Testando...';
      feedbackBox.appendChild(el('div', { class: 'loading-box-sm' }, [
        el('div', { class: 'spinner-sm' }),
        el('span', {}, `Conectando em ${gatewayModelsUrl(cfg.endpoint)}...`),
      ]));

      try {
        const models = await fetchGatewayModels(cfg);
        clear(feedbackBox);
        feedbackBox.appendChild(el('div', { class: 'success-banner' },
          `✓ Conexão bem-sucedida! O gateway respondeu com ${models.length} modelos disponíveis.`));
        // Se ainda não tinha modelos ou o usuário quer atualizar, atualiza a lista
        if (!currentModels.length || currentModels.length !== models.length) {
          currentModels = models;
          updateModelsList();
        }
      } catch (e) {
        clear(feedbackBox);
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '⚡ Testar conexão';
      }
    });

    fetchBtn.addEventListener('click', async () => {
      clear(feedbackBox);
      const cfg = getFormConfig();
      if (!cfg.endpoint) {
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, 'Preencha a URL base do gateway.'));
        baseInp.focus();
        return;
      }
      const perm = await ensureOriginPermission(cfg.endpoint);
      if (!perm.granted) {
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, perm.error));
        return;
      }

      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Puxando...';
      feedbackBox.appendChild(el('div', { class: 'loading-box-sm' }, [
        el('div', { class: 'spinner-sm' }),
        el('span', {}, 'Consultando lista de modelos em /v1/models...'),
      ]));

      try {
        const list = await fetchGatewayModels(cfg);
        currentModels = list;
        updateModelsList();
        clear(feedbackBox);
        feedbackBox.appendChild(el('div', { class: 'success-banner' },
          `✓ ${list.length} modelos puxados com sucesso da API!`));
      } catch (e) {
        clear(feedbackBox);
        feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '🔄 Puxar modelos da API';
      }
    });

    box.appendChild(body);

    // Rodapé com Salvar
    box.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => close(false) }, 'Cancelar'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          clear(feedbackBox);
          const cfg = getFormConfig();
          if (!cfg.endpoint) {
            feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, 'Informe a URL base do gateway.'));
            baseInp.focus();
            return;
          }
          if (credSel.value === 'static_key' && !cfg.apiKey && !isDgsisPreset) {
            feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, 'Informe a chave de API do gateway.'));
            keyInp.focus();
            return;
          }

          // Salvar também pede a permissão do host: sem ela o provider ficaria
          // gravado mas todo chat futuro falharia no fetch.
          const perm = await ensureOriginPermission(cfg.endpoint);
          if (!perm.granted) {
            feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, perm.error));
            return;
          }

          // Se a lista estiver vazia, tenta puxar uma vez antes de salvar.
          let finalModels = currentModels;
          if (!finalModels.length) {
            let pullError = null;
            try {
              finalModels = await fetchGatewayModels(cfg);
              currentModels = finalModels;
              updateModelsList();
            } catch (e) {
              pullError = e.message;
              finalModels = [];
            }

            // Nunca inventa um id de modelo: um "default" fictício salvaria um
            // provider que falha no primeiro chat. Exige confirmação explícita.
            if (!finalModels.length && !allowEmptySave) {
              allowEmptySave = true;
              clear(feedbackBox);
              feedbackBox.appendChild(el('div', { class: 'error-banner-inline' },
                `${pullError || 'Nenhum modelo carregado.'} Clique em salvar de novo para gravar o gateway sem modelos e adicioná-los depois.`));
              return;
            }
          }

          const providerObj = {
            id: existing?.id || newId(),
            type: existing?.type || pickedType?.id || 'custom-gateway',
            name: nameInp.value.trim() || 'Meu Gateway',
            endpoint: gatewayChatUrl(cfg.endpoint),
            apiKey: cfg.apiKey,
            authScheme: cfg.authScheme,
            credentialType: credSel.value,
            artifactIframeOrigin: iframeInp.value.trim(),
            isGateway: true,
            models: finalModels,
          };

          try {
            await upsertProvider(providerObj);
            const curActive = await getActiveModel();
            if (!curActive && providerObj.models?.length) {
              await setActiveModel({ providerId: providerObj.id, modelId: providerObj.models[0].id });
            }
            close(true);
          } catch (e) {
            feedbackBox.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
          }
        },
      }, existing ? 'Aplicar alterações' : 'Salvar Gateway'),
    ]));
  }

  // --- PASSO 2 (PROVEDOR PADRÃO): Formulário simples para OpenRouter, Groq, Ollama, etc.
  function renderStandardProviderForm() {
    const picked = pickedType;
    const already = editingProvider || providers.find(p => p.type === picked.id);

    box.appendChild(el('div', { class: 'modal-header' }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        !editingProvider ? el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => { step = 1; render(); },
          title: 'Voltar',
        }, '← Voltar') : null,
        el('div', {}, [
          el('h3', { class: 'modal-title' }, picked.label),
          picked.tagline ? el('p', { class: 'modal-subtitle' }, picked.tagline) : null,
        ]),
      ]),
      el('button', { class: 'modal-close-btn', onclick: () => close(false) }, '✕'),
    ]));

    const body = el('div', { class: 'modal-body' });

    if (picked.usesGithubToken) {
      body.appendChild(el('div', { class: 'modal-guide-step' }, [
        el('div', { class: 'step-num' }, '✓'),
        el('div', { class: 'step-body' }, [
          el('div', { class: 'step-title' }, 'Usa seu token do GitHub automaticamente'),
          el('div', { class: 'step-desc' }, 'Não precisa de chave separada. Conecte sua conta na aba GitHub.'),
        ]),
      ]));
    } else if (picked.noAuth) {
      body.appendChild(el('div', { class: 'modal-guide-step' }, [
        el('div', { class: 'step-num' }, 'i'),
        el('div', { class: 'step-body' }, [
          el('div', { class: 'step-title' }, 'Servidor local (sem chave de API)'),
          el('div', { class: 'step-desc' }, 'Confirme que o servidor local está rodando no endpoint abaixo.'),
        ]),
      ]));
    } else if (picked.keyUrl) {
      body.appendChild(el('div', { class: 'modal-guide-step' }, [
        el('div', { class: 'step-num' }, '1'),
        el('div', { class: 'step-body' }, [
          el('div', { class: 'step-title' }, 'Obter chave de API'),
          el('div', { class: 'step-desc' }, 'Abra o painel oficial para gerar sua chave e depois cole-a abaixo.'),
          el('button', {
            class: 'btn btn-secondary btn-sm',
            style: { marginTop: '8px' },
            onclick: () => window.open(picked.keyUrl, '_blank'),
          }, `Abrir painel ${picked.label} ↗`),
        ]),
      ]));
    }

    const keyInp = el('input', {
      class: 'input-field',
      type: 'password',
      value: already?.apiKey || picked.defaultApiKey || '',
      placeholder: picked.noAuth ? '(não necessário)' : 'Cole sua API key aqui',
      disabled: (picked.noAuth || picked.usesGithubToken) ? 'disabled' : null,
    });

    const endInp = el('input', {
      class: 'input-field',
      value: already?.endpoint || picked.endpoint || '',
      placeholder: 'https://...',
    });

    const stepNumKey = (picked.usesGithubToken || picked.noAuth) ? '1' : (picked.keyUrl ? '2' : '1');
    body.appendChild(el('div', { class: 'modal-guide-step' }, [
      el('div', { class: 'step-num' }, stepNumKey),
      el('div', { class: 'step-body', style: { width: '100%' } }, [
        el('div', { class: 'step-title' }, picked.usesGithubToken ? 'Endpoint da API' : (picked.noAuth ? 'Endpoint local' : 'Configurar credenciais')),
        el('div', { class: 'step-desc' }, 'A chave fica salva exclusivamente na memória local do seu navegador.'),
        (!picked.noAuth && !picked.usesGithubToken) ? el('div', { class: 'form-group', style: { marginTop: '8px' } }, [
          el('label', { class: 'input-label' }, 'API Key *'),
          keyInp,
        ]) : null,
        el('div', { class: 'form-group', style: { marginTop: '8px' } }, [
          el('label', { class: 'input-label' }, 'Endpoint'),
          endInp,
        ]),
      ]),
    ]));

    const err = el('div');
    body.appendChild(err);
    box.appendChild(body);

    box.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => close(false) }, 'Cancelar'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          clear(err);
          const providerObj = {
            id: already?.id || newId(),
            type: picked.id,
            name: picked.label,
            apiKey: keyInp.value.trim(),
            endpoint: endInp.value.trim() || picked.endpoint,
            models: JSON.parse(JSON.stringify(picked.models || [])),
          };
          if (!picked.noAuth && !picked.usesGithubToken && !providerObj.apiKey) {
            err.appendChild(el('div', { class: 'error-banner-inline' }, 'Cole a API key primeiro.'));
            keyInp.focus();
            return;
          }
          try {
            await upsertProvider(providerObj);
            const curActive = await getActiveModel();
            if (!curActive && providerObj.models?.length) {
              await setActiveModel({ providerId: providerObj.id, modelId: providerObj.models[0].id });
            }
            close(true);
          } catch (e) {
            err.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
          }
        },
      }, already ? 'Atualizar provedor' : 'Adicionar provedor'),
    ]));
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close(false);
  });

  backdrop.appendChild(box);
  render();
  return backdrop;
}

function providerRow(p, onDelete, onEdit) {
  const type = getProviderType(p.type);
  const isGw = isGatewayProvider(p);
  const iconLetter = isGw ? 'GW' : (p.name || type?.label || p.type).slice(0, 2).toUpperCase();

  let statusBadge;
  if (isGw) {
    statusBadge = el('span', { class: 'badge badge-ok' }, 'gateway');
  } else if (p.apiKey) {
    statusBadge = el('span', { class: 'badge badge-ok' }, 'chave ok');
  } else if (type?.noAuth) {
    statusBadge = el('span', { class: 'badge badge-dim' }, 'local');
  } else if (type?.usesGithubToken) {
    statusBadge = el('span', { class: 'badge badge-dim' }, 'token GitHub');
  } else {
    statusBadge = el('span', { class: 'badge badge-warn' }, 'sem chave');
  }

  const editBtnLabel = isGw ? 'Configurar' : 'Chave';

  return el('div', { class: 'provider-row-v2' }, [
    el('div', { class: 'provider-icon-badge' }, iconLetter),
    el('div', { class: 'provider-row-body' }, [
      el('div', { class: 'provider-row-title' }, [
        el('span', {}, p.name || type?.label || p.type),
        statusBadge,
        p.authScheme && p.authScheme !== 'bearer'
          ? el('span', { class: 'badge badge-lang' }, p.authScheme)
          : null,
      ]),
      type?.tagline ? el('div', { class: 'provider-row-tag' }, type.tagline) : null,
      el('div', { class: 'provider-row-meta' }, `${(p.models || []).length} modelos disponíveis`),
    ]),
    el('div', { class: 'provider-row-actions' }, [
      (!type?.noAuth && !type?.usesGithubToken) ? el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: onEdit,
        title: isGw ? 'Configurar gateway e modelos' : 'Trocar chave de API',
      }, editBtnLabel) : null,
      el('button', {
        class: 'btn btn-ghost-danger btn-sm',
        onclick: onDelete,
      }, 'Remover'),
    ]),
  ]);
}

export async function renderConfig(view) {
  clear(view);
  const [providers, active, budget, settings] = await Promise.all([
    getProviders(), getActiveModel(), getBudget(), getSettings(),
  ]);

  // Cabeçalho da página
  const pageHeader = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Modelos de IA & Configurações'),
      el('p', { class: 'page-desc' }, 'Gerencie gateways de inferência, provedores de IA e preferências de execução.'),
    ]),
  ]);
  view.appendChild(pageHeader);

  // --- SEÇÃO 1: Provedores configurados
  const providersCard = el('div', { class: 'config-card' });
  providersCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Provedores Conectados'),
      el('p', { class: 'section-sub-tag' }, 'Adicione gateways próprios ou provedores para disponibilizar modelos aos agentes.'),
    ]),
    el('div', { style: { display: 'flex', gap: '6px' } }, [
      el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: () => document.body.appendChild(openProviderModal({
          providers,
          initialType: getProviderType('custom-gateway'),
          onDone: () => renderConfig(view),
        })),
      }, '+ Gateway Próprio'),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => document.body.appendChild(openProviderModal({
          providers,
          onDone: () => renderConfig(view),
        })),
      }, '+ Adicionar Provedor'),
    ]),
  ]));

  if (!providers.length) {
    providersCard.appendChild(el('div', { class: 'empty-card', style: { padding: '24px 16px' } }, [
      el('div', { class: 'empty-icon-wrap' }, '🔌'),
      el('h3', { class: 'empty-title' }, 'Nenhum provedor configurado'),
      el('p', { class: 'empty-text' }, 'Clique nos botões acima para conectar seu gateway próprio ou provedores de IA.'),
    ]));
  } else {
    const stack = el('div', { class: 'providers-stack' });
    providers.forEach(p => stack.appendChild(providerRow(
      p,
      async () => {
        if (!confirm(`Remover "${p.name || p.type}"?`)) return;
        await removeProvider(p.id);
        renderConfig(view);
      },
      () => {
        document.body.appendChild(openProviderModal({
          providers,
          initialProvider: p,
          onDone: () => renderConfig(view),
        }));
      },
    )));
    providersCard.appendChild(stack);
  }
  view.appendChild(providersCard);

  // --- SEÇÃO 2: Modelo Padrão Global
  const modelCard = el('div', { class: 'config-card' });
  modelCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Modelo Padrão Global'),
      el('p', { class: 'section-sub-tag' }, 'Usado pelos agentes que não possuem modelo específico definido.'),
    ]),
  ]));

  const activeSel = el('select', { class: 'select-field' });
  activeSel.appendChild(el('option', { value: '' }, '— Selecione um modelo padrão —'));
  for (const p of providers) {
    for (const m of (p.models || [])) {
      const val = `${p.id}::${m.id}`;
      const label = `${p.name || p.type} · ${m.label || m.id}`;
      const attrs = { value: val };
      if (active && active.providerId === p.id && active.modelId === m.id) attrs.selected = 'selected';
      activeSel.appendChild(el('option', attrs, label));
    }
  }
  activeSel.addEventListener('change', async () => {
    if (!activeSel.value) { await setActiveModel(null); return; }
    const [providerId, modelId] = activeSel.value.split('::');
    await setActiveModel({ providerId, modelId });
  });

  modelCard.appendChild(el('div', { class: 'form-group' }, [
    activeSel,
    !providers.length
      ? el('div', { class: 'field-hint field-hint-warn' }, 'Adicione um provedor acima para liberar opções de modelo.')
      : el('div', { class: 'field-hint' }, 'A alteração tem efeito imediato em todos os agentes com modelo herdado.'),
  ]));
  view.appendChild(modelCard);

  // --- SEÇÃO 2.5: Fallback Automático
  const fallbackCard = el('div', { class: 'config-card' });
  fallbackCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Fallback Automático (Anti-Limite)'),
      el('p', { class: 'section-sub-tag' }, 'Se o modelo principal atingir o limite de cota (429 Too Many Requests), o agente tentará automaticamente os modelos abaixo na ordem definida.'),
    ]),
  ]));

  const fallbackToggleRow = el('div', { class: 'tool-row' + (settings.autoFallback ? ' is-on' : '') });
  const fallbackCheck = el('input', { type: 'checkbox', class: 'tool-checkbox', checked: settings.autoFallback ? 'checked' : null });
  fallbackToggleRow.appendChild(fallbackCheck);
  fallbackToggleRow.appendChild(el('div', { class: 'tool-row-text' }, [
    el('div', { class: 'tool-row-title' }, 'Ativar troca automática de modelo'),
    el('div', { class: 'tool-row-desc' }, 'O agente não vai parar se a API recusar por falta de créditos ou limite de requisições.'),
  ]));
  
  fallbackToggleRow.addEventListener('click', async (e) => {
    if (e.target !== fallbackCheck) fallbackCheck.checked = !fallbackCheck.checked;
    const isOn = fallbackCheck.checked;
    fallbackToggleRow.className = 'tool-row' + (isOn ? ' is-on' : '');
    await setSettings({ ...settings, autoFallback: isOn });
  });
  fallbackCard.appendChild(fallbackToggleRow);

  const fallbackQueueBox = el('div', { class: 'form-group', style: { marginTop: '12px' } });
  
  function renderFallbackQueue() {
    clear(fallbackQueueBox);
    const queue = settings.fallbackQueue || [];
    
    if (!queue.length) {
      fallbackQueueBox.appendChild(el('div', { class: 'empty-inline' }, 'Nenhum modelo na fila de fallback.'));
    } else {
      queue.forEach((ref, idx) => {
        const [pId, mId] = ref.split('::');
        const p = providers.find(x => x.id === pId);
        const m = p?.models?.find(x => x.id === mId);
        const label = p && m ? `${p.name || p.type} · ${m.label || m.id}` : `Modelo não encontrado (${ref})`;
        
        const row = el('div', { class: 'provider-row-v2', style: { padding: '6px 10px' } }, [
          el('div', { class: 'step-num', style: { width: '18px', height: '18px', fontSize: '10px' } }, String(idx + 1)),
          el('div', { class: 'provider-row-body' }, [
            el('div', { class: 'provider-row-title', style: { fontSize: '11.5px' } }, label)
          ]),
          el('div', { class: 'provider-row-actions' }, [
            el('button', { class: 'btn btn-ghost-danger btn-sm', onclick: async () => {
              const newQ = [...queue];
              newQ.splice(idx, 1);
              settings.fallbackQueue = newQ;
              await setSettings({ ...settings, fallbackQueue: newQ });
              renderFallbackQueue();
            }}, '✕')
          ])
        ]);
        fallbackQueueBox.appendChild(row);
      });
    }

    const addSel = el('select', { class: 'select-field', style: { marginTop: '8px' } });
    addSel.appendChild(el('option', { value: '' }, '+ Adicionar modelo à fila...'));
    for (const p of providers) {
      for (const m of (p.models || [])) {
        const val = `${p.id}::${m.id}`;
        if (queue.includes(val)) continue; // Já está na fila
        addSel.appendChild(el('option', { value: val }, `${p.name || p.type} · ${m.label || m.id}`));
      }
    }
    addSel.addEventListener('change', async () => {
      if (!addSel.value) return;
      const newQ = [...queue, addSel.value];
      settings.fallbackQueue = newQ;
      await setSettings({ ...settings, fallbackQueue: newQ });
      renderFallbackQueue();
    });
    fallbackQueueBox.appendChild(addSel);
  }
  
  renderFallbackQueue();
  fallbackCard.appendChild(fallbackQueueBox);
  view.appendChild(fallbackCard);

  // --- SEÇÃO 3: Limites & Orçamento
  const budgetCard = el('div', { class: 'config-card' });
  budgetCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Orçamento & Limites'),
      el('p', { class: 'section-sub-tag' }, 'Controle gastos mensais e chamadas de ferramentas.'),
    ]),
  ]));

  const budInp = el('input', {
    class: 'input-field',
    type: 'number',
    step: '0.01',
    min: '0',
    value: String(budget.monthlyUSD || 0),
    placeholder: '0.00',
  });

  const iterInp = el('input', {
    class: 'input-field',
    type: 'number',
    min: '1',
    max: '50',
    value: String(settings.maxIterations || 12),
  });

  const saveLimitsBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Salvar limites');
  const limitsFeedback = el('span', { class: 'field-hint' });

  saveLimitsBtn.addEventListener('click', async () => {
    await setBudget({ monthlyUSD: +budInp.value || 0 });
    await setSettings({ ...settings, maxIterations: +iterInp.value || 12 });
    limitsFeedback.textContent = '✓ Limites salvos com sucesso';
    setTimeout(() => { limitsFeedback.textContent = ''; }, 3000);
  });

  budgetCard.appendChild(el('div', { class: 'form-group' }, [
    el('label', { class: 'input-label' }, 'Orçamento mensal máximo (USD)'),
    budInp,
    el('div', { class: 'field-hint' }, 'Zero = sem limite. Se definido, o agente pausa ao atingir o valor.'),
  ]));

  budgetCard.appendChild(el('div', { class: 'form-group' }, [
    el('label', { class: 'input-label' }, 'Máximo de iterações por mensagem'),
    iterInp,
    el('div', { class: 'field-hint' }, 'Limite de ações consecutivas que o agente pode realizar (padrão: 12).'),
  ]));

  budgetCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' } }, [
    saveLimitsBtn,
    limitsFeedback,
  ]));
  view.appendChild(budgetCard);

  // --- SEÇÃO 4: Instruções Globais
  const promptCard = el('div', { class: 'config-card' });
  promptCard.appendChild(el('div', { class: 'section-title-row' }, [
    el('div', {}, [
      el('span', { class: 'section-tag' }, 'Prompt do Sistema Global (Fallback)'),
      el('p', { class: 'section-sub-tag' }, 'Instruções aplicadas caso o agente não defina instruções próprias.'),
    ]),
  ]));

  const spInp = el('textarea', {
    class: 'textarea-field',
    rows: '4',
    placeholder: 'Instruções adicionais aplicadas globalmente...',
  }, settings.systemPrompt || '');

  const savePromptBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Salvar prompt');
  const promptFeedback = el('span', { class: 'field-hint' });

  savePromptBtn.addEventListener('click', async () => {
    const cur = await getSettings();
    await setSettings({ ...cur, systemPrompt: spInp.value });
    promptFeedback.textContent = '✓ Prompt global salvo';
    setTimeout(() => { promptFeedback.textContent = ''; }, 3000);
  });

  promptCard.appendChild(el('div', { class: 'form-group' }, [
    spInp,
  ]));
  promptCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' } }, [
    savePromptBtn,
    promptFeedback,
  ]));
  view.appendChild(promptCard);
}
