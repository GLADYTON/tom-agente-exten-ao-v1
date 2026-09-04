import { getProviderType } from './providers/catalog.js';
import { DEFAULT_PROTECTED_BRANCHES } from './agent/guard.js';

const KEYS = {
  providers: 'tom.providers',
  activeModel: 'tom.activeModel',
  github: 'tom.github',
  githubAccounts: 'tom.github_accounts',
  activeGithubAccount: 'tom.activeGithubAccount',
  repo: 'tom.repo',
  usage: 'tom.usage',
  budget: 'tom.budget',
  chats: 'tom.chats',
  settings: 'tom.settings',
  agents: 'tom.agents',
  activeAgent: 'tom.activeAgent',
  seededGateways: 'tom.seededGateways',
};

const DEFAULT_AGENTS = [
  {
    id: 'coder',
    name: 'Coder',
    emoji: '⚡',
    description: 'Edita código, cria arquivos, faz commits e abre PRs.',
    systemPrompt: 'Você é o Coder, um engenheiro de software que edita repositórios do GitHub. Leia antes de escrever, de preferência vários arquivos numa só chamada. Use edit_file para alterar arquivo existente e write_file só para criar. Faça mudanças mínimas e diretas; tudo é commitado junto ao final.',
    tools: ['list_repo_tree', 'read_file', 'edit_file', 'write_file', 'delete_file', 'create_branch', 'open_pr'],
    modelRef: null,
    temperature: 0.2,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    emoji: '🔍',
    description: 'Analisa o código sem modificar. Foca em bugs, qualidade e segurança.',
    systemPrompt: 'Você é o Reviewer, um revisor de código sênior. Leia o código e retorne análises detalhadas: bugs, code smells, riscos de segurança. NÃO modifique arquivos.',
    tools: ['list_repo_tree', 'read_file'],
    modelRef: null,
    temperature: 0.1,
  },
  {
    id: 'architect',
    name: 'Architect',
    emoji: '🏗️',
    description: 'Planeja mudanças grandes, quebra em passos, cria branches e PRs.',
    systemPrompt: 'Você é o Architect. Antes de tocar em código, mapeie a estrutura com list_repo_tree e read_file (vários caminhos por chamada). Proponha um plano em passos numerados. Depois execute: crie uma branch nova, edite com edit_file e abra um PR ao final.',
    tools: ['list_repo_tree', 'read_file', 'edit_file', 'write_file', 'create_branch', 'open_pr'],
    modelRef: null,
    temperature: 0.3,
  },
];

async function get(key, fallback) {
  const res = await chrome.storage.local.get(key);
  return res[key] === undefined ? fallback : res[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getProviders() {
  await seedReadyProvidersOnce();
  return get(KEYS.providers, []);
}

// getProviders() é chamado em paralelo por várias views; sem essa trava as
// chamadas concorrentes leriam seeded=false juntas e duplicariam o gateway.
let seedInFlight = null;

function seedReadyProvidersOnce() {
  seedInFlight ??= doSeedReadyProviders().finally(() => { seedInFlight = null; });
  return seedInFlight;
}

async function doSeedReadyProviders() {
  try {
    if (await get(KEYS.seededGateways, false)) return;

    const current = await get(KEYS.providers, []);
    const already = current.some(p =>
      p.type === 'dgsis-gateway' || (p.endpoint || '').includes('gtw.cloud2.dgsis.com.br'));

    if (!already) {
      const type = getProviderType('dgsis-gateway');
      const seeded = {
        id: 'p_dgsis_seeded',
        type: type.id,
        name: type.label,
        apiKey: type.defaultApiKey,
        endpoint: type.endpoint,
        authScheme: type.authScheme,
        credentialType: 'static_key',
        isGateway: true,
        models: JSON.parse(JSON.stringify(type.models)),
      };
      current.unshift(seeded);
      await set(KEYS.providers, current);

      // Sem modelo ativo ainda: já deixa o gateway pronto para conversar.
      if (!(await get(KEYS.activeModel, null))) {
        await set(KEYS.activeModel, { providerId: seeded.id, modelId: seeded.models[0].id });
      }
    }

    await set(KEYS.seededGateways, true);
  } catch (err) {
    console.error('Error seeding providers:', err);
    // Não lança o erro para não travar a inicialização
  }
}

export async function saveProviders(list) {
  await set(KEYS.providers, list);
}

export async function upsertProvider(provider) {
  const list = await getProviders();
  const idx = list.findIndex(p => p.id === provider.id);
  if (idx >= 0) list[idx] = provider; else list.push(provider);
  await saveProviders(list);
  return list;
}

export async function removeProvider(id) {
  const list = (await getProviders()).filter(p => p.id !== id);
  await saveProviders(list);
  return list;
}

export async function getActiveModel() {
  return get(KEYS.activeModel, null);
}

export async function setActiveModel(ref) {
  await set(KEYS.activeModel, ref);
}

export async function getGithub() {
  return get(KEYS.github, { token: '', user: null, oauthClientId: '' });
}

export async function setGithub(v) {
  await set(KEYS.github, v);
}

export async function getGithubAccounts() {
  const accounts = await get(KEYS.githubAccounts, null);
  if (accounts) return accounts;
  const legacy = await getGithub();
  if (legacy.token && legacy.user) {
    const migrated = [{ id: legacy.user.id || 'legacy', token: legacy.token, user: legacy.user }];
    await set(KEYS.githubAccounts, migrated);
    await set(KEYS.activeGithubAccount, migrated[0].id);
    return migrated;
  }
  return [];
}

export async function addGithubAccount(account) {
  const list = await getGithubAccounts();
  const idx = list.findIndex(a => a.id === account.id);
  if (idx >= 0) list[idx] = account; else list.push(account);
  await set(KEYS.githubAccounts, list);
  if (list.length === 1) await set(KEYS.activeGithubAccount, account.id);
  await set(KEYS.github, { token: account.token, user: account.user });
  return list;
}

export async function removeGithubAccount(id) {
  const list = (await getGithubAccounts()).filter(a => a.id !== id);
  await set(KEYS.githubAccounts, list);
  const activeId = await get(KEYS.activeGithubAccount, null);
  if (activeId === id) {
    if (list.length) {
      await set(KEYS.activeGithubAccount, list[0].id);
      await set(KEYS.github, { token: list[0].token, user: list[0].user });
    } else {
      await set(KEYS.activeGithubAccount, null);
      await set(KEYS.github, { token: '', user: null });
    }
  }
  return list;
}

export async function getActiveGithubAccount() {
  const accounts = await getGithubAccounts();
  if (!accounts.length) return null;
  const activeId = await get(KEYS.activeGithubAccount, null);
  return accounts.find(a => a.id === activeId) || accounts[0];
}

export async function setActiveGithubAccount(id) {
  const accounts = await getGithubAccounts();
  const account = accounts.find(a => a.id === id);
  if (!account) return;
  await set(KEYS.activeGithubAccount, id);
  await set(KEYS.github, { token: account.token, user: account.user });
}

export async function getRepo() {
  return get(KEYS.repo, null);
}

export async function setRepo(v) {
  await set(KEYS.repo, v);
}

export async function getUsage() {
  return get(KEYS.usage, {});
}

export async function addUsage(providerId, modelId, input, output, costUSD) {
  const usage = await getUsage();
  const monthKey = new Date().toISOString().slice(0, 7);
  usage[monthKey] ??= {};
  const key = `${providerId}::${modelId}`;
  usage[monthKey][key] ??= { input: 0, output: 0, cost: 0, calls: 0 };
  usage[monthKey][key].input += input || 0;
  usage[monthKey][key].output += output || 0;
  usage[monthKey][key].cost += costUSD || 0;
  usage[monthKey][key].calls += 1;
  await set(KEYS.usage, usage);
  return usage;
}

export async function resetUsage() {
  await set(KEYS.usage, {});
}

export async function getBudget() {
  return get(KEYS.budget, { monthlyUSD: 0 });
}

export async function setBudget(v) {
  await set(KEYS.budget, v);
}

export async function getSettings() {
  const cur = await get(KEYS.settings, {});
  // Defaults aplicados na leitura: instalações antigas não têm as chaves novas.
  return {
    autoApprove: false,
    maxIterations: 12,
    systemPrompt: '',
    autoCommit: true,
    autoReview: true,
    // Modo equipe (multiagente). Desligado por padrão: o modo de agente único
    // continua sendo o caminho conhecido de quem já usa a extensão.
    teamMode: false,
    maxParallelAgents: 2,
    // Portões de aprovação humana. Ligados por padrão: o agente não tem como
    // rodar build/teste no browser, então commit em branch protegida e remoção
    // de arquivo passam pelo usuário.
    confirmProtectedCommit: true,
    confirmDelete: true,
    protectedBranches: DEFAULT_PROTECTED_BRANCHES.join(', '),
    // Fallback automático de modelos
    autoFallback: false,
    fallbackQueue: [], // Array de strings no formato "providerId::modelId"
    ...cur,
  };
}

export async function setSettings(v) {
  const cur = await getSettings();
  await set(KEYS.settings, { ...cur, ...v });
}

export async function getChats() {
  const list = await get(KEYS.chats, []);
  // Migração de formato antigo (array de objetos com apenas {messages: []})
  // para o novo formato com id, title, updatedAt.
  if (list.length > 0 && !list[0].id) {
    const migrated = list.map((c, i) => ({
      id: `chat_${Date.now()}_${i}`,
      title: c.messages?.[0]?.content?.slice(0, 40) || 'Conversa sem título',
      updatedAt: new Date().toISOString(),
      messages: c.messages || [],
    }));
    await set(KEYS.chats, migrated);
    return migrated;
  }
  return list;
}

export async function saveChats(v) {
  await set(KEYS.chats, v);
}

export async function getActiveChatId() {
  return get('tom.activeChatId', null);
}

export async function setActiveChatId(id) {
  await set('tom.activeChatId', id);
}

export async function getAgents() {
  const list = await get(KEYS.agents, null);
  if (!list) {
    await set(KEYS.agents, DEFAULT_AGENTS);
    return DEFAULT_AGENTS;
  }
  return list;
}

export async function saveAgents(list) {
  await set(KEYS.agents, list);
}

export async function upsertAgent(agent) {
  const list = await getAgents();
  const idx = list.findIndex(a => a.id === agent.id);
  if (idx >= 0) list[idx] = agent; else list.push(agent);
  await saveAgents(list);
  return list;
}

export async function removeAgent(id) {
  const list = (await getAgents()).filter(a => a.id !== id);
  await saveAgents(list);
  return list;
}

export async function getActiveAgent() {
  const id = await get(KEYS.activeAgent, 'coder');
  const list = await getAgents();
  return list.find(a => a.id === id) || list[0];
}

export async function setActiveAgent(id) {
  await set(KEYS.activeAgent, id);
}
