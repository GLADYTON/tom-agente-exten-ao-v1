# CodeForge ⚡

**Agentes de IA que editam, revisam e transformam seus repositórios GitHub com maestria.**

Extensão Chrome (side panel) que conecta seus próprios modelos de IA diretamente ao GitHub — sem servidor, sem login, sem intermediários.

---

## ✨ Diferenciais

- **Fallback Automático**: Configure uma fila de modelos. Se o principal estourar cota (429/quota), o CodeForge troca automaticamente para o próximo modelo da lista sem perder o progresso.
- **Execução em Background**: Troque de aba à vontade — o agente continua trabalhando e salvando o progresso. Volte ao chat e veja o resultado atualizado.
- **Resumo Profissional**: Em vez de poluir o chat com cada `read_file`/`edit_file`, o CodeForge agrupa as operações em um bloco expansível: *"3 lidos, 2 editados"*. Clique em "Ver detalhes" se quiser inspecionar.
- **Múltiplas Conversas**: Cada chat tem seu próprio histórico, título e data. A aba "Histórico" lista todas as conversas para retomar ou excluir.
- **Múltiplos Agentes**: Crie agentes com personalidade, modelo e permissões diferentes. O Coder edita, o Reviewer analisa, o Architect planeja — ou crie o seu.
- **Múltiplas Contas GitHub**: Conecte quantas contas quiser, alterne entre elas, busque repositórios de todas ao mesmo tempo.
- **Gateways Próprios**: Conecte qualquer endpoint compatível com OpenAI API — DGSIS, OpenRouter, Ollama local, ou seu próprio gateway.
- **100% Privado**: Toda credencial (chaves de IA + token do GitHub) fica no `chrome.storage.local`. Nada sai da sua máquina.

## Como funciona

- A extensão fala diretamente com a API do GitHub e com a API do modelo de IA que você escolher.
- Você registra quantos providers quiser (Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, ou qualquer gateway OpenAI-compatível), define os preços por 1M tokens e seleciona o modelo ativo.
- O agente tem ferramentas: `list_repo_tree`, `read_file`, `edit_file`, `write_file`, `delete_file`, `create_branch`, `open_pr`. Cada alteração é commitada automaticamente no repositório ativo.

## Instalação

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique **Carregar sem compactação**
4. Selecione a pasta `codeforge` (a que contém `manifest.json`)
5. Clique no ícone da extensão na barra — abre o side panel

## Primeiro uso

1. **Modelos → + Adicionar Provedor**: escolha o tipo (ex: Anthropic), cole sua API key, salve.
2. **Modelos → Modelo Padrão Global**: selecione o modelo principal.
3. **Modelos → Fallback Automático**: ative a troca automática e adicione modelos reserva na ordem desejada.
4. **GitHub → Conectar Conta**: cole um PAT (`ghp_...` com scope `repo`) ou use o fluxo OAuth.
5. **Repo**: selecione o repositório que o agente vai editar.
6. **Chat**: descreva a tarefa. Exemplo: *"Adicione um endpoint /health em src/server.js que retorne {status:'ok'} e faça commit direto na main."*

## Arquitetura

```
codeforge/
├── manifest.json          # Manifest V3
├── background.js          # Service worker (side panel)
├── panel.html             # Interface principal
├── panel.css              # Tema escuro premium
├── panel.js               # Roteamento de abas
├── src/
│   ├── runner.js          # Gerenciador global de execução (background)
│   ├── storage.js         # chrome.storage.local
│   ├── github.js          # API GitHub
│   ├── agent/
│   │   ├── loop.js        # Loop do agente (fallback, revisão, staging)
│   │   ├── tools.js       # Definição e execução das ferramentas
│   │   ├── stage.js       # Staging de arquivos
│   │   └── guard.js       # Proteção de branches
│   ├── providers/
│   │   ├── client.js      # Clientes de API (OpenAI, Anthropic, Gemini)
│   │   └── catalog.js     # Catálogo de provedores
│   ├── views/
│   │   ├── chat.js        # Chat do agente
│   │   ├── chat-history.js# Histórico de conversas
│   │   ├── config.js      # Configurações (modelos, fallback, orçamento)
│   │   ├── github.js      # Gerenciamento de contas GitHub
│   │   ├── repos.js       # Repositórios e commits
│   │   ├── agents.js      # Gerenciamento de agentes
│   │   └── usage.js       # Métricas de consumo
│   └── util/
│       └── dom.js         # Helpers de DOM
```

## Onde ficam suas coisas

Tudo em `chrome.storage.local`, chaves com prefixo `tom.`:

| Chave | Descrição |
|---|---|
| `tom.providers` | Providers de IA configurados |
| `tom.activeModel` | Modelo padrão global |
| `tom.github_accounts` | Contas GitHub conectadas |
| `tom.repo` | Repositório ativo |
| `tom.usage` | Contadores mensais por modelo |
| `tom.budget` | Teto mensal em USD |
| `tom.settings` | Configurações (fallback, iterações, etc.) |
| `tom.chats` | Histórico de conversas |
| `tom.agents` | Agentes personalizados |

## Custos e limites

Aba **Uso** mostra tokens gastos e custo estimado por mês, por modelo, com base nos preços que você definir. Se o orçamento mensal for definido, o agente para automaticamente ao atingir o teto.

## Segurança

- OAuth App usa Device Flow (sem `client_secret`) — caminho seguro para extensões.
- Providers de IA guardam chaves no storage local — mesma superfície de risco de qualquer extensão que gerencie chaves.
- A extensão nunca envia seus dados para servidores externos além dos endpoints que você mesmo configurou.

---

**CodeForge** — Forjado para código, alimentado por IA. ⚡