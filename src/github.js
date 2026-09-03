import { getGithub, setGithub } from './storage.js';

const API = 'https://api.github.com';

async function authHeaders() {
  const g = await getGithub();
  if (!g.token) throw new Error('GitHub token não configurado. Vá em Config e cole seu PAT ou use Device Flow.');
  return {
    'Authorization': `Bearer ${g.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function gh(path, opts = {}) {
  const headers = { ...(await authHeaders()), ...(opts.headers || {}) };
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export async function testToken(token) {
  const res = await fetch(`${API}/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`Token inválido (${res.status})`);
  return res.json();
}

export async function savePAT(token) {
  const user = await testToken(token);
  await setGithub({ token, user: { login: user.login, avatar: user.avatar_url, id: user.id } });
  return user;
}

export async function clearAuth() {
  await setGithub({ token: '', user: null });
}

export async function listMyRepos({ perPage = 100, sort = 'updated' } = {}) {
  return gh(`/user/repos?per_page=${perPage}&sort=${sort}&affiliation=owner,collaborator`);
}

export async function getRepo(owner, repo) {
  return gh(`/repos/${owner}/${repo}`);
}

export async function getBranch(owner, repo, branch) {
  return gh(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
}

export async function getTree(owner, repo, ref, recursive = true) {
  const branch = await getBranch(owner, repo, ref);
  const sha = branch.commit.commit.tree.sha;
  return gh(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=${recursive ? 1 : 0}`);
}

export async function getFile(owner, repo, path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}${q}`);
  if (Array.isArray(data)) return { type: 'dir', entries: data };
  if (data.encoding === 'base64') {
    const bin = atob(data.content.replace(/\n/g, ''));
    let text;
    try { text = decodeURIComponent(escape(bin)); } catch { text = bin; }
    return { type: 'file', text, sha: data.sha, path: data.path, size: data.size };
  }
  return { type: 'file', text: data.content || '', sha: data.sha, path: data.path, size: data.size };
}

function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export async function putFile(owner, repo, path, content, message, branch, sha) {
  const body = {
    message,
    content: toBase64(content),
    branch,
  };
  if (sha) body.sha = sha;
  return gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function deleteFile(owner, repo, path, message, branch, sha) {
  return gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, branch, sha }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function createBranch(owner, repo, newBranch, fromBranch) {
  const src = await getBranch(owner, repo, fromBranch);
  return gh(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: src.commit.sha }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function openPR(owner, repo, { head, base, title, body }) {
  return gh(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ head, base, title, body }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function listCommits(owner, repo, branch, perPage = 20) {
  return gh(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`);
}

export async function getCommitDetail(owner, repo, sha) {
  return gh(`/repos/${owner}/${repo}/commits/${sha}`);
}

export async function listReposForToken(token, perPage = 100) {
  const res = await fetch(`${API}/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

// Um commit para N arquivos, via Git Trees API.
// files: [{ path, content }] para escrita, [{ path, action: 'delete' }] para remoção.
// Blobs sobem em paralelo (limitado) porque é a parte lenta quando são muitos arquivos.
export async function createCommit(owner, repo, branch, files, message) {
  if (!files?.length) throw new Error('Nada para commitar.');
  const headers = await authHeaders();
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const branchData = await getBranch(owner, repo, branch);
  const baseSha = branchData.commit.sha;
  const baseTreeSha = branchData.commit.commit.tree.sha;

  async function toTreeEntry(f) {
    // sha null remove o caminho da árvore.
    if (f.action === 'delete') {
      return { path: f.path, mode: '100644', type: 'blob', sha: null };
    }
    const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    if (!res.ok) {
      throw new Error(`Falha ao enviar ${f.path}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const blob = await res.json();
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  }

  const tree = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    tree.push(...await Promise.all(files.slice(i, i + CONCURRENCY).map(toTreeEntry)));
  }

  const treeRes = await fetch(`${API}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) throw new Error(`Falha ao montar árvore: ${treeRes.status} ${(await treeRes.text().catch(() => '')).slice(0, 200)}`);
  const treeData = await treeRes.json();

  const commitRes = await fetch(`${API}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ message, tree: treeData.sha, parents: [baseSha] }),
  });
  if (!commitRes.ok) throw new Error(`Falha ao criar commit: ${commitRes.status} ${(await commitRes.text().catch(() => '')).slice(0, 200)}`);
  const commit = await commitRes.json();

  const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ sha: commit.sha }),
  });
  if (!refRes.ok) {
    const body = (await refRes.text().catch(() => '')).slice(0, 200);
    // 422 aqui normalmente é non-fast-forward: alguém commitou na branch no meio.
    throw new Error(refRes.status === 422
      ? `A branch ${branch} avançou durante a execução (non-fast-forward). O commit ${commit.sha.slice(0, 7)} foi criado mas a branch não foi movida. Rode de novo para reaplicar. Detalhe: ${body}`
      : `Falha ao mover a branch ${branch}: ${refRes.status} ${body}`);
  }

  return {
    sha: commit.sha,
    message: commit.message,
    url: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    branch,
    count: files.length,
  };
}

export async function deviceStart(clientId, scope = 'repo user') {  if (!clientId) throw new Error('Configure o Client ID do OAuth App em Config → GitHub antes de usar Device Flow.');
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) throw new Error('Falha ao iniciar Device Flow');
  return res.json();
}

export async function devicePoll(clientId, device_code, interval) {
  await new Promise(r => setTimeout(r, (interval || 5) * 1000));
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json();
  if (data.error === 'authorization_pending') return { pending: true };
  if (data.error === 'slow_down') return { pending: true, slower: true };
  if (data.error) throw new Error(data.error_description || data.error);
  if (data.access_token) {
    const user = await testToken(data.access_token);
    await setGithub({
      token: data.access_token,
      user: { login: user.login, avatar: user.avatar_url, id: user.id },
    });
    return { done: true, user };
  }
  return { pending: true };
}
