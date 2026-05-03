# Architecture Refactor Plan

## Objetivo

Refatorar o pipeline de decisao do MineGPT Bot para deixar a fronteira entre linguagem natural, providers, schema, normalizacao, planejamento, seguranca, execucao e observabilidade mais clara. O foco desta etapa e arquitetura e confiabilidade; nao e uma expansao de skills grandes.

Fluxo-alvo:

```text
chat "bot ..."
  -> comando interno deterministico ou pedido natural
  -> provider selecionado
  -> payload compacto para LLM
  -> decisao JSON estruturada
  -> validatePlannerDecision()
  -> normalizacao/correcao segura de argumentos
  -> validacao pos-normalizacao
  -> SkillRegistry.plan()
  -> risco/survival/activeSkill/confirmacao
  -> SkillRegistry.execute()
  -> ActionResult honesto
  -> logs/debug/benchmark
  -> resposta clara no chat
```

## Problemas Encontrados

- `commands.js` ainda concentra muitos comandos legados, mas o prefixo `bot` ja esta isolado em `ai/planner-executor.js`.
- Comandos internos de controle (`llm`, `perfil`, `provider`, `confirmar`, `cancelar`, `plano`, `para`) ja sao deterministicos, mas essa fronteira precisava ficar documentada.
- Provider `ollama` ja e o padrao e nao usa `rule_based` como pre-filtro. O fallback so ocorre quando configurado e apos falha do provider principal.
- A normalizacao de argumentos estava dentro de `ai/providers/provider-utils.js`, misturando utilitarios de provider com regras semanticas de planner.
- O normalizador antigo corrigia `movement.stop` e `containers.deposit`, mas nao retornava warnings/erros estruturados nem resolvia aliases comuns de coleta/crafting/container.
- `tool-adapter.js` enviava metadados seguros, porem pobres para LLM: descricao, schema e hints curtos, sem "quando usar", "quando nao usar", exemplos naturais, exemplos de args e observacoes de seguranca.
- O prompt do Ollama ja exige JSON e uma unica acao, mas precisava instruir explicitamente casos de ambiguidade lexical como "para frente" e aliases Minecraft em portugues.
- O payload do LLM ja e compacto e remove funcoes/ciclos, mas o conjunto de skills enviado nao tinha contexto semantico suficiente para reduzir args incoerentes.
- Debug atual registra payload resumido e parse/validacao, mas nao mostra o pipeline completo com args antes/depois da normalizacao, plan e resultado.
- `logs/` nao estava no `.gitignore`, apesar da necessidade de salvar payload/resposta bruta quando debug persistente estiver ativo.
- `scripts/bench-local-llm.js` usava ids fake diferentes das skills reais, reduzindo valor como regressao arquitetural.
- `planner-schema.js` rejeitava `intent: "stop"`, embora o contrato desejado inclua esse intent. O runner ainda deve tratar parada operacional como `movement.stop`.

## Decisoes Arquiteturais

- Comandos internos do prefixo `bot` continuam deterministicos e nao passam por LLM:
  - `bot llm`
  - `bot modelo`
  - `bot perfil`
  - `bot provider`
  - `bot confirmar`
  - `bot cancelar`
  - `bot plano <pedido>`
  - `bot para|pare|parar`
- Pedidos naturais sob `bot` sempre vao para o provider ativo. Com `MINEGPT_AI_PROVIDER=ollama`, nao ha pre-filtro lexical por `rule_based`.
- `rule_based` fica reservado para provider explicito ou fallback configurado por `MINEGPT_AI_FALLBACK_PROVIDER`.
- A normalizacao de argumentos passa a ser modulo proprio: `ai/argument-normalizer.js`.
- Aliases semanticos comuns ficam em `ai/semantic-aliases.js`, com integracao opcional ao `catalog.js` quando houver catalogo disponivel.
- O runner valida a decisao antes e depois da normalizacao. Decisao invalida ou normalizacao fatal nunca executa.
- Normalizacao pode remover campos extras seguros, mapear aliases conhecidos e corrigir formatos triviais, mas nao inventa skill nem coordenadas.
- Skill cards passam a ser a representacao enviada ao LLM: compacta, segura e com exemplos.
- Debug fica dividido:
  - `MINEGPT_AI_DEBUG=1`: eventos compactos do pipeline.
  - `MINEGPT_AI_DEBUG_PAYLOAD=1`: payload compacto.
  - `MINEGPT_AI_DEBUG_RAW=1`: resposta bruta do LLM.
  - `MINEGPT_AI_SAVE_DEBUG=1`: salva eventos em `logs/`.
- `logs/` deve permanecer ignorado pelo Git.

## Fronteiras Entre Modulos

- `commands.js`: comandos humanos legados e roteamento inicial do prefixo `bot`.
- `ai/planner-executor.js`: comandos internos do prefixo `bot`, confirmacao, dry-run e resposta de chat.
- `ai/providers/index.js`: selecao de provider solicitado e fallback configurado.
- `ai/planner.js`: fachada de decisao, rate limit e fallback explicito.
- `ai/providers/ollama-provider.js`: cliente Ollama local, prompt, parse estrito e validacao inicial.
- `ai/planner-prompt-payload.js`: compactacao segura de estado, historico e skill cards.
- `ai/tool-adapter.js`: conversao de SkillRegistry para cards seguros do planner.
- `ai/planner-schema.js`: contrato JSON estrutural e validacao de skill/args.
- `ai/argument-normalizer.js`: correcao segura e rastreavel de argumentos.
- `ai/semantic-aliases.js`: ponte de aliases PT/EN para ids/modos tecnicos.
- `ai/planner-runner.js`: orquestracao segura, normalizacao, plan/execute, risco, survival, activeSkill, dry-run e recovery.
- `skills.js`: contrato executavel, validacao de inputSchema, pre/post-condicoes, timeout e policy.
- `action-result.js`: resultado honesto das acoes.
- `catalog.js`, `inventory.js`, `perception.js`, `containers.js`, `crafting.js`, `collection.js`: dominio Minecraft e execucao real.

## Riscos

- Normalizacao agressiva demais pode esconder erro do LLM. Mitigacao: warnings/erros estruturados e somente aliases conhecidos.
- Validacao de `collection.collect` contra `allowedActions.collectTargets` pode bloquear aliases semanticamente corretos quando o alvo ainda nao apareceu na percepcao. Mitigacao: normalizador tenta escolher alvo permitido compativel antes da validacao pos-normalizacao.
- Skill cards mais ricos aumentam payload. Mitigacao: limites existentes e textos curtos.
- Debug persistente pode gerar dados demais em sessoes longas. Mitigacao: salvar apenas quando `MINEGPT_AI_SAVE_DEBUG=1` e truncar eventos.
- `intent: "stop"` no schema pode confundir provider. Mitigacao: runner trata como parada sem `nextAction`, e comandos reais de parada continuam usando `movement.stop`.
- Benchmarks sem Minecraft continuam aproximados. Mitigacao: usar ids reais e medir plan/dry-run contra registry fake.

## Plano De Migracao

1. Documentar arquitetura e achados desta auditoria.
2. Extrair normalizacao de `provider-utils` para `ai/argument-normalizer.js`.
3. Criar aliases semanticos em `ai/semantic-aliases.js`.
4. Enriquecer `tool-adapter.js` com skill cards e exemplos.
5. Atualizar payload/prompt/debug para expor cards e pipeline.
6. Integrar normalizador no runner antes de `SkillRegistry.plan()`.
7. Ajustar provider/benchmark/probe para usar o novo normalizador.
8. Atualizar testes unitarios de provider, normalizacao, skill cards, debug e dry-run.
9. Atualizar README/docs para o novo contrato.
10. Rodar `npm test`, `npm run llm:check` e, quando Ollama estiver disponivel, `npm run llm:bench`.

## Alterado Nesta Refatoracao

- Documento criado para registrar a arquitetura-alvo e decisoes.
- Normalizacao de argumentos passa a ter modulo dedicado, warnings e erros.
- Aliases semanticos comuns foram centralizados para planner/normalizer.
- Skill cards passaram a incluir contexto de uso, contrauso, exemplos, schema e seguranca.
- Prompt do Ollama foi reforcado para lidar com uma unica skill, argumentos exatos, ambiguidades e "para frente".
- Debug do pipeline ficou mais rastreavel.
- Benchmark local foi alinhado aos ids reais das skills.
- `logs/` foi adicionado ao `.gitignore`.

## Pendente

- Enriquecer `ActionResult` de `containers.search`, `containers.withdraw`, `containers.deposit`, `drops.collect` e `blocks.place` com mais codigos e deltas em cenarios parciais.
- Persistir ou inspecionar debug salvo por comando de suporte, se ficar necessario.
- Avaliar uma skill composta futura `items.obtain`, com budget e profundidade limitados, sem entrar nesta etapa.
- Testar manualmente no Minecraft os cenarios de `docs/LOCAL_LLM_TEST_SCENARIOS.md` com Ollama real.
- Medir `npm run llm:bench` em `economia`, `equilibrio` e `performance` no hardware-alvo.
