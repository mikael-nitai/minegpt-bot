# Local LLM Plan

Status: documento historico.

Este arquivo registra o planejamento que levou a implementacao do provider Ollama local. Ele contem etapas, defaults e observacoes antigas que ja foram superadas. Para o estado operacional atual, use `README.md`, `AGENT_MAP.md`, `docs/CLEANUP_AUDIT.md` e o codigo em `ai/` como fonte primaria.

Plano para integrar um LLM local via Ollama na camada `ai/` sem alterar o comportamento atual do bot nesta etapa.

Esta etapa e apenas de auditoria e desenho. Nao implementa provider Ollama, nao chama Ollama, nao baixa modelo e nao integra API paga.

## Resumo Da Auditoria

O estado atual e adequado para uma integracao incremental com LLM local:

- O comando `bot` ja esta conectado em `commands.js` por `parseBotCommand()`.
- A execucao passa por `runPlannerCommand()` e `runPlannerCycles()`.
- O planner atual em `ai/planner.js` e mockado/deterministico e nao chama rede nem API externa.
- O runner sempre consulta `stateReporter.getPlannerSnapshot()`, adapta skills para tools seguras e valida decisoes antes de planejar/executar.
- A execucao real passa por `SkillRegistry.plan()` e `SkillRegistry.execute()`, preservando `ActionResult`.
- `tool-adapter.js` expoe apenas metadados de skill: `id`, `description`, `inputSchema`, `risk`, `effects`, `cost` e `plannerHints`. Ele nao expoe `run`, contexto interno, bot, credenciais ou funcoes.
- O snapshot compacto em `state.js` ja e usavel para LLM local, mas precisa de limites mais explicitos quando entrar em prompt real.
- A configuracao atual e por `config.json`/`config.example.json`; ainda nao existe estrutura de config/env dedicada para AI provider.

Nao ha necessidade de adicionar dependencias novas para esta fase.

## Fluxo Atual Do Comando `bot`

```text
chat do owner
  -> commands.js
  -> parseBotCommand(message)
  -> runPlannerCommand()
  -> runPlannerCycles()
  -> safePlannerState(context)
  -> stateReporter.getPlannerSnapshot()
  -> skillRegistryToPlannerTools()
  -> decideNextAction()
  -> validatePlannerDecision()
  -> skillRegistry.plan()
  -> skillRegistry.execute()
  -> ActionResult
  -> resposta curta no chat
```

O runner padrao executa no maximo uma acao por comando (`maxSteps = 1`) e possui limite duro de tres passos (`HARD_MAX_STEPS = 3`) para testes controlados.

## Como O Provider Deterministico Decide Hoje

`ai/planner.js` hoje e a fachada de provider. Ele seleciona o provider configurado, aplica rate limit local quando necessario, chama o provider efetivo e so usa fallback se `MINEGPT_AI_FALLBACK_PROVIDER` estiver configurado.

O provider `rule_based` normaliza a mensagem do usuario e usa regras simples:

- parar/cancelar -> `movement.stop`;
- vir/vem/venha -> `movement.come_here`;
- seguir/siga -> `movement.follow_owner`;
- estado/status -> `state.snapshot`;
- crafting table/mesa de trabalho -> `crafting.craft` com `target: "crafting_table"`;
- madeira/tronco/arvore -> `collection.collect` com `target: "madeira"` e `count: 1`;
- comandos vazios, ambiguos ou nao mapeados -> `ask_user`.

Depois disso, a decisao ainda passa por `validatePlannerDecision()` e pelo normalizador de argumentos. Se a skill escolhida nao estiver disponivel nas tools, o provider deterministico troca a resposta para `ask_user`.

## Guardrails Do Runner

`ai/planner-runner.js` ja aplica bloqueios importantes antes de executar qualquer skill:

- exige `skillRegistry` disponivel;
- valida schema da decisao;
- para em `ask_user`, `refuse` ou `stop`;
- bloqueia skill inexistente;
- bloqueia risco fora de `allowedRisks` (`low` e `medium` por padrao);
- bloqueia nova acao se `context.activeSkill` estiver ocupado, exceto `movement.stop`;
- consulta `survivalGuard.assess()` e bloqueia skills nao baixas quando survival esta `high` ou `critical`;
- bloqueia repeticao da mesma skill com os mesmos argumentos dentro do mesmo ciclo;
- chama `SkillRegistry.plan()` antes de `execute()`;
- suporta `dryRun`.

Esses guardrails devem continuar sendo a fronteira de seguranca mesmo com provider Ollama.

## Snapshot Para LLM Local

`getPlannerSnapshot()` esta compacto o suficiente para um primeiro LLM local, porque evita o snapshot completo de debug e prioriza:

- estado online/reconnecting/busy/canAct/activeSkill;
- vitais e posicao;
- mao atual;
- inventario resumido, foco de ferramentas/comida/blocos/recursos e slot livre;
- top attention, perigos, recursos, drops e containers com limites;
- survival resumido;
- navegacao como `summary`;
- containers conhecidos e itens importantes;
- coletas recentes.

Limites recomendados antes de enviar para prompt real:

- manter inventario em no maximo 16 itens principais;
- manter `topAttention` em no maximo 6 tokens;
- manter hazards em no maximo 4 tokens;
- manter resources em no maximo 6 tokens;
- manter drops e containers em no maximo 5 tokens cada;
- manter containers conhecidos como resumo, nao dump completo;
- manter historico do runner em no maximo 5 entradas compactas;
- serializar JSON sem texto longo de debug.

Meta inicial: prompt total abaixo de 8k tokens. Com Qwen2.5 14B local, usar contexto demais aumenta latencia, consumo de VRAM/RAM e chance de resposta instavel.

## Arquitetura Proposta De Providers

Adicionar uma pequena camada de provider em `ai/`, mantendo o runner como orquestrador:

```text
ai/
  planner.js                 # pode virar provider mock ou facade temporaria
  planner-provider.js        # seleciona provider por config/env
  providers/
    mock.js                  # comportamento atual
    rule-based.js            # regras deterministicas mais explicitas
    ollama.js                # futuro cliente HTTP local
```

Interface sugerida:

```js
async function decideNextAction({
  userMessage,
  plannerState,
  skills,
  history,
  config
}) {
  return PlannerDecision
}
```

O retorno deve continuar exatamente no schema atual:

```text
{
  intent,
  userGoal,
  nextAction,
  reasonSummary,
  askUser,
  risk,
  confidence,
  stopAfterThis
}
```

`runPlannerCycles()` nao deve saber detalhes de Ollama. Ele deve receber uma funcao `decide` ja selecionada ou usar um provider default configurado.

## Providers

### `mock`

Provider atual. Deve permanecer como default ate a integracao local estar testada.

Uso:

- testes unitarios;
- desenvolvimento sem LLM;
- fallback quando provider local falhar;
- modo seguro para regressao.

### `rule_based`

Provider deterministico intermediario, separado do `mock`, para regras explicitas e expansao sem LLM.

Uso:

- comandos basicos em producao quando Ollama estiver indisponivel;
- fallback mais util que `mock`;
- testes de decisoes previsiveis;
- manutencao de comandos comuns como parar, vir aqui, seguir, estado, crafting simples e coleta pequena.

### `ollama`

Provider futuro via HTTP local para `http://127.0.0.1:11434`.

Modelo alvo:

```text
Qwen2.5 14B Instruct Q4_K_M
```

Esse provider deve:

- montar prompt de sistema conservador;
- enviar somente `plannerState`, `skills` seguras, `history` compacto e `userMessage`;
- exigir JSON puro no schema de `PlannerDecision`;
- aplicar timeout;
- tratar JSON invalido como falha de provider;
- nunca executar tool diretamente;
- devolver decisao para o runner validar.

Estado implementado: o provider `ollama` usa `fetch` nativo do Node 18 contra `/api/chat`, envia `format` com JSON Schema para structured outputs, valida localmente com `validatePlannerDecision()` e nunca executa acao diretamente. Fallback de provider pode ser configurado por `MINEGPT_AI_FALLBACK_PROVIDER=rule_based|mock`.

As skills enviadas ao Ollama sao cards seguros gerados por `ai/tool-adapter.js`, com `whenToUse`, `whenNotToUse`, exemplos naturais, exemplos de args e notas de seguranca. O payload final e compactado por `ai/planner-prompt-payload.js`.

Depois da decisao do provider, `ai/argument-normalizer.js` corrige apenas aliases conhecidos e formatos seguros. Exemplos: `movement.stop` sempre vira `{}`, `blocos` vira `mode=blocks`, `mesa de trabalho` vira `crafting_table`, `tochas` vira `torch`, e `tronco de carvalho` vira `oak_log` quando esse alvo estiver permitido pelo snapshot.

## Configuracao

A configuracao atual vive em `config.json`. Para AI local, ha duas opcoes conservadoras:

1. Adicionar bloco opcional `ai` em `config.example.json`.
2. Permitir override por env vars simples.

Proposta de config:

```json
{
  "ai": {
    "provider": "mock",
    "fallbackProvider": "rule_based",
    "profile": "balanced",
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen2.5:14b-instruct-q4_K_M",
      "timeoutMs": 20000,
      "contextTokens": 8192
    }
  }
}
```

Possiveis env vars:

```text
MINEGPT_AI_PROVIDER=mock|rule_based|ollama
MINEGPT_AI_PROFILE=economy|balanced|performance
MINEGPT_OLLAMA_BASE_URL=http://127.0.0.1:11434
MINEGPT_OLLAMA_MODEL=qwen2.5:14b-instruct-q4_K_M
MINEGPT_OLLAMA_TIMEOUT_MS=20000
```

Nesta fase, nao alterar `config.example.json` ainda evita qualquer mudanca comportamental.

## Perfis Locais

### Economia

Objetivo: menor uso de GPU, menor calor e mais estabilidade enquanto joga.

Recomendado:

- `maxSteps = 1`;
- contexto entre 4096 e 6144 tokens;
- timeout entre 12s e 18s;
- `num_predict` baixo, por exemplo 256 a 384 tokens;
- chamar LLM apenas em comando `bot`, nunca em tick;
- fallback imediato para `rule_based` em timeout;
- evitar plano multi-step.

### Equilibrio

Objetivo: bom uso da RTX 3060 12 GB sem travar o desktop.

Recomendado:

- `maxSteps = 1` por padrao;
- contexto alvo de 8192 tokens;
- timeout entre 18s e 25s;
- `num_predict` entre 384 e 512 tokens;
- manter historico compacto;
- permitir uma nova chamada somente apos a acao terminar;
- usar fallback para `rule_based` quando Ollama responder JSON invalido ou lento.

### Performance

Objetivo: maior capacidade de raciocinio local, aceitando mais latencia e uso de VRAM.

Recomendado:

- contexto ate o limite estavel observado na maquina;
- timeout entre 25s e 45s;
- `num_predict` ate 768 tokens;
- `maxSteps` ainda limitado a 1 no jogo real, com ate 3 somente em testes controlados;
- cooldown entre chamadas;
- monitorar VRAM, temperatura e responsividade do jogo.

## Timeout E Fallback

Ordem recomendada:

```text
ollama
  -> timeout, erro HTTP, modelo ausente, JSON invalido ou schema invalido
  -> rule_based
  -> mock
  -> ask_user/refuse seguro
```

Timeouts devem ser curtos o bastante para nao congelar o comando de chat:

- economia: 12000-18000 ms;
- equilibrio: 18000-25000 ms;
- performance: 25000-45000 ms.

Mesmo quando Ollama falhar, a resposta final deve continuar passando por `validatePlannerDecision()` e pelos bloqueios do runner.

## Validacao Por Schema

A validacao atual em `ai/planner-schema.js` deve continuar sendo obrigatoria. Para Ollama, adicionar uma etapa de parse defensivo antes dela:

- aceitar somente objeto JSON;
- rejeitar markdown, texto antes/depois do JSON e arrays;
- rejeitar `nextAction` quando `intent` nao for `execute_skill`;
- exigir `nextAction.args` como objeto;
- limitar `reasonSummary` a 240 caracteres;
- validar `risk` em `low`, `medium`, `high`;
- validar `confidence` entre 0 e 1;
- validar skill existente contra tools;
- normalizar argumentos com `ai/argument-normalizer.js`;
- validar novamente depois da normalizacao;
- bloquear execucao em erro fatal ou skill inexistente.

Nao usar resposta textual do LLM para decidir execucao. A unica saida aceita deve ser `PlannerDecision` validada.

## Seguranca Contra Acoes Sensiveis

Manter a decisao do LLM sem autoridade direta. A seguranca deve ficar em camadas:

- prompt instrui o modelo a preferir `ask_user` quando houver ambiguidade;
- schema rejeita formato invalido;
- runner bloqueia riscos fora de `allowedRisks`;
- runner bloqueia `activeSkill`;
- runner bloqueia survival alto/critico;
- runner bloqueia repeticao;
- `SkillRegistry.plan()` aplica requisitos, precondicoes e policy;
- `SkillRegistry.execute()` revalida antes de executar;
- `ActionResult` registra falha/sucesso de forma estruturada.

Skills que exigem cuidado especial:

- `inventory.drop`: remove itens do inventario;
- `survival.set_enabled`: pode desligar protecao;
- `containers.clear_memory`: apaga memoria util;
- `movement.go_to`: pode mover para longe ou risco;
- `collection.collect`: altera mundo e pode gastar ferramenta;
- `blocks.place`: altera mundo;
- `containers.deposit`: pode guardar itens em container errado;
- `containers.withdraw`: pode esvaziar organizacao de baus.

Para a primeira versao Ollama, manter `allowedRisks = ["low", "medium"]` e exigir comando explicito do usuario para qualquer skill sensivel. A policy atual ja tem parte dessa protecao, mas o runner hoje passa `explicitUserIntent: true` para toda acao derivada de `bot`; ao integrar LLM, vale separar "usuario pediu genericamente" de "usuario autorizou esta acao sensivel".

## Estrategia Para Nao Sobrecarregar GPU

Com Ryzen 5 3600, RTX 3060 12 GB e 16 GB de RAM, Qwen2.5 14B Instruct em Q4_K_M e viavel, mas deve ser tratado como recurso pesado.

Riscos principais:

- VRAM perto do limite se contexto e batch forem altos;
- spill para RAM reduz muito a velocidade;
- 16 GB de RAM limita folga para Minecraft, Node, sistema e Ollama juntos;
- chamadas longas podem causar stutter no jogo;
- temperatura/power podem subir em sessoes longas;
- respostas com contexto alto aumentam latencia e chance de timeout;
- concorrencia de chamadas pode travar a experiencia.

Regras recomendadas:

- nunca chamar LLM em loop de tick;
- permitir uma unica chamada Ollama por vez;
- usar fila simples ou rejeitar chamada enquanto outra estiver ativa;
- manter `maxSteps = 1` no jogo real;
- cooldown minimo entre chamadas, por exemplo 2-5 segundos;
- limitar contexto por perfil;
- limitar `num_predict`;
- usar timeout e fallback;
- nao enviar dumps completos de percepcao, inventario ou containers;
- manter survival guard independente do LLM;
- preferir `rule_based` para comandos triviais como parar e estado;
- monitorar VRAM com `nvidia-smi` durante testes manuais.

## Scripts Futuros Para Ollama

Sem criar scripts nesta etapa, estes seriam uteis depois:

### `scripts/check-ollama.js`

Objetivo: verificar se Ollama esta instalado, se o servidor local responde e se o modelo esperado existe.

Comportamento seguro:

- nao instala nada;
- nao baixa modelo;
- faz apenas checks locais;
- imprime instrucoes manuais quando algo falta;
- retorna exit code diferente de zero em falha.

Checks:

```text
ollama --version
GET /api/tags em 127.0.0.1:11434
modelo qwen2.5 14B instruct Q4_K_M presente
```

### `scripts/install-ollama.sh` Ou Documento Manual

Como instalacao altera sistema, deve ser opt-in e nunca rodar automaticamente pelo bot.

Passos esperados:

```text
instalar Ollama
iniciar servico local
baixar modelo
validar tags
rodar prompt minimo de teste
```

### `scripts/pull-local-model.sh`

Objetivo futuro: baixar o modelo explicitamente, com confirmacao humana fora do bot.

Deve deixar claro:

- tamanho aproximado;
- tempo esperado;
- uso de disco;
- que o download pode ser retomado pelo Ollama;
- que nao e necessario para rodar testes unitarios.

## Mudancas Minimas Futuras

Quando for hora de implementar, o menor conjunto de mudancas deve ser:

1. Extrair o comportamento atual de `ai/planner.js` para provider `mock`.
2. Criar provider `rule_based` com as mesmas regras, mas nomeado como fallback operacional.
3. Criar seletor de provider sem alterar o contrato de `runPlannerCycles()`.
4. Adicionar leitura opcional de config/env para `ai.provider`.
5. Criar provider `ollama` usando API HTTP local e `AbortController` para timeout.
6. Fazer parse estrito de JSON.
7. Reusar `validatePlannerDecision()`.
8. Manter `mock` como default.
9. Adicionar testes unitarios com provider fake, sem chamar Ollama real.
10. So depois adicionar scripts de verificacao/instalacao.

## Criterios Para A Proxima Etapa

Antes de ligar Ollama de verdade:

- `npm test` deve continuar passando;
- provider default deve continuar `mock`;
- nenhum teste deve depender de Ollama instalado;
- chamadas triviais devem poder ser resolvidas por `rule_based`;
- falha de Ollama deve cair em fallback seguro;
- decisao de Ollama deve ser validada por schema e runner;
- prompt deve caber no limite de contexto escolhido;
- comandos sensiveis devem exigir confirmacao/intent explicita;
- runner deve continuar sem executar mais de uma acao por comando por padrao.
