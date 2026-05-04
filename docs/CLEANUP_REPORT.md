# Cleanup Report

Data: 2026-05-03

## Resumo

Limpeza controlada concluida sem remover comportamento funcional. O foco foi reduzir ambiguidade documental e diminuir a superficie publica do modulo `ai/`, mantendo comandos antigos, provider Ollama, fallback `rule_based`, provider `mock`, normalizador, scripts LLM e pipeline `bot`.

## O Que Foi Removido Ou Simplificado

- `ai/index.js` foi reduzido de barrel amplo para API publica minima.
- O barrel agora exporta apenas:
  - `parseBotCommand`;
  - `runPlannerCommand`.
- `test/ai-planner.test.js` deixou de importar helpers internos por `../ai` e passou a importar diretamente dos modulos reais:
  - `ai/planner.js`;
  - `ai/providers/index.js`;
  - `ai/local-llm-profiles.js`;
  - `ai/planner-schema.js`;
  - `ai/planner-runner.js`;
  - `ai/planner-prompt-payload.js`;
  - `ai/planner-limits.js`;
  - `ai/argument-normalizer.js`;
  - `ai/semantic-aliases.js`;
  - `ai/tool-adapter.js`.

Isso deixa claro que `ai/index.js` e interface de runtime para `commands.js`, nao um ponto de acesso generico para internals.

## Documentacao Atualizada

- Criado `docs/CLEANUP_AUDIT.md` com baseline, mapa de responsabilidades, candidatos de limpeza e riscos de remocao.
- `README.md` atualizado para refletir que o provider padrao atual e Ollama, com `rule_based` como fallback/debug e `mock` como regressao/debug.
- `AGENT_MAP.md` atualizado com a mesma fronteira operacional da camada `ai/`.
- `docs/LOCAL_LLM_PLAN.md` marcado como documento historico para evitar conflito com o estado atual.

## O Que Foi Mantido E Por Que

- `ai/providers/ollama-provider.js`: provider principal local.
- `ai/providers/rule-based-provider.js`: fallback explicito e fallback basico de controle.
- `ai/providers/mock-provider.js`: provider explicito de regressao/debug e fallback para provider desconhecido.
- `ai/planner-schema.js` com schema estrito e schema simples: o estrito ainda e usado por `llm:probe`; o simples e usado pelo Ollama e benchmark.
- `ai/planner-runner.js` com semantic guard em modo `warn`: ainda fornece diagnostico e pode bloquear em modo `strict`.
- `commands.js`: comandos antigos continuam essenciais para debug manual e compatibilidade.
- Scripts `llm:check`, `llm:setup`, `llm:bench`, `llm:probe`: ainda sao parte do fluxo operacional.

## Riscos Restantes

- `test/ai-planner.test.js` continua grande e cobre muitas responsabilidades em um unico arquivo.
- `commands.js` ainda mistura parser e execucao de muitos comandos antigos; dividir agora seria refatoracao de maior risco.
- `semanticGuardForDecision` ainda usa classificacao lexical simples; isso explica parte das falhas de benchmark em cenarios como `bot minera carvão`.
- `mock-provider` e `rule_based` tem alguma sobreposicao conceitual, mas ainda possuem papeis diferentes.
- Docs historicas podem continuar contendo exemplos antigos; agora estao marcadas como historicas quando necessario.

## Proximos Pontos De Simplificacao

- Separar `test/ai-planner.test.js` em testes por modulo:
  - provider selection;
  - schema;
  - runner;
  - executor;
  - normalizer;
  - prompt payload.
- Dividir `commands.js` em parsers/handlers por dominio quando houver tempo:
  - movimento;
  - percepcao;
  - inventario;
  - coleta;
  - crafting;
  - containers;
  - planner.
- Reavaliar `semanticGuardForDecision` para virar apenas diagnostico estruturado ou ser substituido por guardrails baseados em skill metadata.
- Considerar uma politica propria para provider desconhecido antes de remover `mock-provider` do runtime.

## Validacoes Executadas

- `git status --short --branch` no baseline: limpo e alinhado com `origin/main`.
- `npm test` no baseline: passou.
- `npm run llm:bench` no baseline: Ollama disponivel; comandos basicos passaram.
- `npm test` apos limpeza de documentacao: passou.
- `npm test` apos reduzir `ai/index.js`: passou.
- `npm test` final: passou.
- `npm run llm:bench` final: Ollama disponivel; comandos basicos passaram.

Limitacoes mantidas no benchmark final:

- `bot minera carvão`: barrado por coerencia semantica.
- `bot pega 16 carvão no baú`: escolheu `containers.search` onde o benchmark esperava `containers.withdraw`.
