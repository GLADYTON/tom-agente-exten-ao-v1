# Agente Tom

Extensão Chrome (side panel) que edita seus repositórios do GitHub usando **seus próprios** modelos de IA — sem servidor intermediário, sem login, sem licença.

## Como funciona

- Toda credencial (chaves de IA + token do GitHub) fica em `chrome.storage.local` do seu navegador. Nada sai da sua máquina exceto para os endpoints que você configurou.
- A extensão fala direto com a API do GitHub e com a API do provider de IA que você escolher.
- Você registra quantos providers quiser (Anthropic, OpenAI, OpenRouter, Google, Groq, DeepSeek, Mistral, Ollama local, ou qualquer endpoint OpenAI-compatível), cadastra os modelos que sua conta tem acesso, define preços por 1M tokens e escolhe o modelo ativo. Trocar de modelo é um dropdown.
- O agente tem ferramentas: `list_repo_tree`, `read_file`, `write_file`, `delete_file`, `create_branch`, `open_pr`. Cada `write_file` é um commit direto no repo ativo.

## Instalação

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique **Carregar sem compactação**
4. Selecione a pasta `agente-tom` (a que contém `manifest.json`)
5. Clique no ícone da extensão na barra — abre o side panel

## Primeiro uso

1. **Config → Providers de IA → + Adicionar**: escolha o tipo (ex: Anthropic), cole sua API key, salve.
2. **Config → Modelo ativo**: selecione o modelo que quer usar por padrão.
3. **Config → GitHub**: cole um PAT (`ghp_...` com scope `repo`) ou use o Device Flow.
4. **Repos**: selecione o repositório que o agente vai editar.
5. **Chat**: descreva a tarefa. Exemplo: *"Adicione um endpoint /health em src/server.js que retorne {status:'ok'} e faça commit direto na main."*

## Onde ficam suas coisas

Tudo em `chrome.storage.local`, chaves com prefixo `tom.`:

- `tom.providers` — array de providers (com API keys)
- `tom.activeModel` — `{providerId, modelId}`
- `tom.github` — `{token, user}`
- `tom.repo` — repositório ativo
- `tom.usage` — contadores mensais por modelo
- `tom.budget` — teto mensal em USD
- `tom.settings` — max iterações, system prompt custom
- `tom.chats` — histórico

Para apagar tudo, desinstale a extensão ou use `chrome.storage.local.clear()` no console do side panel.

## Custos e limites

Aba **Uso** mostra tokens gastos e custo estimado por mês, por modelo, com base nos preços `$/1M in` e `$/1M out` que você definir no cadastro do modelo. Se `Orçamento mensal (USD)` for maior que zero, o agente para automaticamente ao atingir o teto.

## Segurança

- OAuth App puro no browser requer `client_secret`, o que vaza em extensões. O Device Flow (padrão aqui) usa OAuth **sem** secret e é o caminho seguro. Se preferir simplicidade, use PAT.
- Providers de IA guardam chaves em texto claro no storage local — mesma superfície de risco de qualquer extensão que gerencie chaves. Não sincronize seu perfil do Chrome com contas não confiáveis.

## Estender

- Adicionar novo provider: `src/providers/catalog.js` e, se precisar de formato próprio, `src/providers/client.js`.
- Adicionar ferramentas: `src/agent/tools.js` (definição) e `runTool` (execução).
- Trocar prompt do agente: **Config → Comportamento do agente → System prompt**.
