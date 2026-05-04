# Cleanup Audit

Data: 2026-05-03

Objetivo: identificar restos obsoletos, duplicacoes e caminhos ambiguos sem alterar comportamento funcional do MineGPT Bot.

## Baseline Validado

- `git status --short --branch`: branch `main` limpa e alinhada com `origin/main`.
- `npm test`: passou completo.
- `npm run llm:bench`: Ollama disponivel; comandos basicos passaram.

Resultado do benchmark:

- `bot venha aqui`: `movement.come_here`, `plan.ok=true`.
- `bot vem aqui`: `movement.come_here`, `plan.ok=true`.
- `bot pare`: `movement.stop`, `plan.ok=true`.
- `bot estado`: `state.snapshot`, `plan.ok=true`.
- `bot colete madeira`: `collection.collect`, `plan.ok=true`.
- `bot faça crafting table`: `crafting.craft`, `plan.ok=true`.

Limitacoes conhecidas vistas no benchmark, fora do escopo desta limpeza:

- `bot minera carvão` foi barrado por coerencia semantica.
- `bot pega 16 carvão no baú` escolheu `containers.search` onde o benchmark esperava `containers.withdraw`.

## Arquivos Centrais Atuais

- `index.js`: entrada minima; chama `start()` de `main.js`.
- `main.js`: composicao de dependencias, warmup Ollama e registro das skills.
- `bot-runtime.js`: conexao Mineflayer, eventos, reconexao e tick loop.
- `commands.js`: dispatcher dos comandos antigos de chat e ponte para `bot`.
- `skills.js`: `SkillRegistry`, validacao, `plan()` e `execute()`.
- `action-result.js`: formato padrao de retorno das skills.
- `state.js`: snapshots de estado, incluindo snapshot compacto para planner.
- `inventory.js`: inventario, hotbar, mao, equip/drop e deltas.
- `perception.js`: cache, scan, tokens, grupos e attention scoring.
- `navigation.js`: pathfinder, modos e recuperacao.
- `collection.js`: coleta/mineracao e drops.
- `crafting.js`: receitas, crafting direto e cadeia curta.
- `placement.js`: colocacao simples de blocos.
- `containers.js`: memoria, busca, retirada, deposito e logistica.
- `survival.js`: Survival Guard e reacoes curtas.
- `catalog.js`: resolucao Minecraft 1.20.4 via `minecraft-data`.
- `utils.js`: helpers compartilhados pequenos.

## Camada AI/Planner Atual

- `ai/planner.js`: fachada de provider; escolhe provider configurado, aplica rate limit, fallback configurado e fallback basico de controle.
- `ai/providers/ollama-provider.js`: provider principal local com Ollama/Qwen.
- `ai/providers/rule-based-provider.js`: fallback explicito e fallback basico de controle.
- `ai/providers/mock-provider.js`: provider legado ainda configuravel e fallback para provider desconhecido.
- `ai/providers/index.js`: selecao de provider.
- `ai/planner-runner.js`: orquestra decisoes, normalizacao, guardrails, `SkillRegistry.plan()`, `execute()` e recovery local.
- `ai/planner-executor.js`: integra prefixo `bot`, dry-run, confirmacao, diagnosticos e respostas de chat.
- `ai/planner-schema.js`: validacao estrutural/final e schemas JSON.
- `ai/argument-normalizer.js`: normalizacao segura antes de `plan()`.
- `ai/tool-adapter.js`: skill cards seguros para planner.
- `ai/planner-prompt-payload.js`: compactacao de estado/skills/history para LLM.
- `ai/local-llm-profiles.js`: perfis locais.
- `ai/planner-limits.js`: rate limit e cache de skills.
- `ai/semantic-aliases.js`: aliases semanticos.

## Providers Realmente Usados

- `ollama`: provider padrao (`DEFAULT_PROVIDER = 'ollama'`) e caminho principal de linguagem natural.
- `rule_based`: usado como provider explicito, fallback configurado e fallback basico de controle em `ai/planner.js`.
- `mock`: ainda usado como provider explicito e como fallback quando provider/fallback configurado e desconhecido. Tambem cobre testes de regressao.

Conclusao: nenhum provider deve ser removido nesta etapa.

## Comandos Antigos Ainda Necessarios

`commands.js` ainda e necessario como compatibilidade operacional. Ele contem comandos manuais importantes que nao devem ser removidos nesta limpeza:

- movimento direto: `seguir`, `vir aqui`, `parar`, `destravar`, `ir X Y Z`;
- navegacao/debug: `navstatus`, `nav modo`, `nav parkour`, `nav blocos`, `nav quebrar`;
- estado/percepcao: `estado`, `planner estado`, `planner compacto`, `scan`, `atencao`, `perigos`, `recursos`, `entidades`;
- inventario: `status`, `inventario`, `hotbar`, `mao`, `segure`, `drop`, `hotbar SLOT ITEM`;
- coleta/crafting/blocos/containers: comandos diretos ainda sao uteis para debug e fallback manual.

Conclusao: `commands.js` pode ser dividido no futuro, mas nao deve ser refatorado nesta limpeza.

## Arquivos Possivelmente Obsoletos Ou Historicos

- `docs/LOCAL_LLM_PLAN.md`: contem planejamento antigo e trechos que ja foram superados, como default `mock` e auditoria antes da implementacao do provider Ollama. Deve ser marcado como documento historico/legacy ou substituido por documentacao atual.
- `docs/ARCHITECTURE_REFACTOR_PLAN.md`: ainda pode ser util como registro de decisoes, mas deve ser tratado como historico se divergir do codigo.
- `docs/AI_PLANNER_READINESS.md`: documento de readiness; manter como historico de auditoria, nao como fonte operacional primaria.

Conclusao: nao remover docs nesta etapa; atualizar cabecalhos para reduzir ambiguidade.

## Exports Possivelmente Excessivos

`ai/index.js` funciona como barrel amplo. Busca estatica mostrou:

- Runtime externo usa `require('./ai')` apenas em `commands.js`, importando `parseBotCommand` e `runPlannerCommand`.
- Antes da limpeza, testes usavam `require('../ai')` para muitos helpers internos.
- Modulos runtime como `main.js`, scripts e providers ja importam varios arquivos diretamente.

Candidatos seguros para limpeza:

- Reduzir `ai/index.js` para API publica minima usada por runtime: `parseBotCommand` e `runPlannerCommand`.
- Atualizar testes para importar helpers internos diretamente dos modulos correspondentes.

Risco: medio-baixo. Pode quebrar testes por imports, mas nao deve alterar runtime se ajustado com cuidado.

## Funcoes/Exports Internos A Manter Por Enquanto

- `plannerDecisionJsonSchema`: ainda usado por `scripts/probe-local-llm.js` e testes.
- `plannerDecisionSimpleJsonSchema`: usado pelo Ollama e benchmark.
- `validatePlannerDecisionStructure`: usado pelo Ollama, runner e benchmark.
- `semanticGuardForDecision`: ainda conectado ao runner; padrao `warn`. Remover agora mudaria debug/guardrails.
- `compactActionResult`, `compactDecision`, `compactPlan`: usados internamente no runner; exportados para testes/debug. Manter ate haver separacao de testes por modulo.
- `isLlmDiagnosticCommand`, `parsePlannerDiagnosticCommand`, `describePlannerProvider`, `checkOllamaStatus`: usados em executor/testes ou comandos de diagnostico. Manter.
- `DEFAULT_*` do runner/provider: usados por testes e como contratos documentados.

## Modulos Duplicados Ou Ambiguos

- `mock-provider` e `rule-based-provider` se sobrepoem em comandos simples, mas tem papeis diferentes:
  - `mock`: regressao e fallback para provider desconhecido.
  - `rule_based`: fallback operacional deterministico.
- `MINEGPT_AI_DEBUG` e `MINEGPT_AI_TRACE` coexistem:
  - `DEBUG` e log geral de planner.
  - `TRACE` e trilha detalhada do pipeline.
  Manter ambos nesta etapa.
- `state.snapshot` e `state.planner_snapshot` coexistem:
  - `state.snapshot`: completo/debug.
  - `state.planner_snapshot`: compacto/planner.
  Manter ambos.

## Docs Desatualizadas

- `README.md` ainda diz que a fundacao do planner e "mockada/deterministica, sem API externa" no resumo inicial.
- `README.md` tambem diz que "o planner ainda e deterministico e limitado" logo apos descrever `bot`.
- `AGENT_MAP.md` diz que `ai/` possui "planner mockado sem API externa".
- `docs/LOCAL_LLM_PLAN.md` possui trechos historicos que contradizem o estado atual se lidos como guia operacional.

Esses pontos sao seguros para atualizar porque nao alteram runtime.

## Riscos De Remocao

- Remover `mock-provider`: quebra fallback de provider desconhecido, modo explicito e testes.
- Remover `rule_based`: quebra fallback configurado e fallback basico de controle.
- Remover `plannerDecisionJsonSchema`: quebra `llm:probe`.
- Remover exports do barrel sem ajustar testes: quebra `npm test`.
- Remover comandos antigos: reduz capacidade de debug manual e viola compatibilidade.
- Remover semantic guard: altera comportamento/debug de decisoes incoerentes.

## Recomendacao De Limpeza Controlada

Grupo 1, baixo risco:

- Atualizar frases desatualizadas em `README.md` e `AGENT_MAP.md`.
- Marcar `docs/LOCAL_LLM_PLAN.md` como documento historico.

Grupo 2, medio-baixo risco:

- Reduzir `ai/index.js` para API publica minima.
- Atualizar `test/ai-planner.test.js` para imports diretos por modulo.
- Rodar `npm test` imediatamente.

Grupo 3, adiar:

- Dividir `commands.js`.
- Separar testes grandes de `test/ai-planner.test.js`.
- Reavaliar se `mock-provider` pode virar apenas fixture de teste depois que fallback desconhecido tiver politica propria.
- Refinar semantic guard para nao usar classificacao lexical fragil em cenarios como "minera carvao".
