# AGENT_MAP

Mapa operacional para agentes de codigo trabalhando neste repositorio.

Este arquivo nao substitui leitura real do codigo. Use como indice de orientacao, depois confirme tudo nos arquivos fonte e nos testes. Se houver conflito entre este mapa e o codigo, o codigo vence.

## Rotina Recomendada

1. Verifique o estado do repositorio antes de alterar algo: `git status --short`.
2. Leia este arquivo para localizar o fluxo provavel.
3. Leia os arquivos fonte envolvidos antes de editar.
4. Para qualquer skill nova ou alterada, preserve os contratos: `ActionResult`, `SkillRegistry`, validacao, timeout e testes.
5. Rode `npm test` antes de concluir mudancas relevantes.
6. Se a mudanca alterar arquitetura, fluxos ou responsabilidade de modulo, atualize este mapa no mesmo commit.

## Entrada Do Sistema

Fluxo de inicializacao:

```text
index.js
  -> main.js
    -> loadConfig()
    -> createMinecraftCatalog()
    -> cria context compartilhado
    -> cria inventory, navigation, perception, survival, collection, crafting, placement, containers
    -> setupSkillRegistry()
    -> createRuntime().start()
```

`main.js` e o ponto de montagem. Evite colocar logica pesada nele. Se uma responsabilidade crescer, mova para modulo dedicado e injete dependencias pelo mesmo padrao atual.

## Arquivos Por Responsabilidade

- `index.js`: entrada minima; chama `start()`.
- `main.js`: composicao de dependencias, criacao do contexto e registro de skills.
- `bot-runtime.js`: conexao Mineflayer, eventos principais, reconexao e tick loop.
- `commands.js`: parser e dispatcher de comandos de chat do dono.
- `navigation.js`: pathfinder, modos de navegacao, parkour/scaffold toggles e recuperacao.
- `perception.js`: scan do mundo, cache, tokens, grupos, attention scoring e descricoes.
- `catalog.js`: catalogo Minecraft 1.20.4 via `minecraft-data`, aliases e resolucao de nomes.
- `inventory.js`: snapshots, diffs, hotbar, mao, busca/equip/drop e helpers de itens.
- `collection.js`: coleta/mineracao, selecao de alvo percebido, drops e validacao basica.
- `placement.js`: colocacao simples e segura de blocos.
- `crafting.js`: crafting direto, receitas, faltas e cadeia curta de dependencias basicas.
- `containers.js`: memoria de containers, scan, busca, retirada, deposito e classificacao logistica.
- `survival.js`: Survival Guard, avaliacao de risco, pedidos de ajuda e reacoes curtas.
- `skills.js`: contrato planejavel das skills, `plan()`, validacao, pre/post-condicoes e timeout.
- `action-result.js`: formato padrao de resultado de acoes.
- `state.js`: snapshot estruturado para debug e futuro planner.
- `utils.js`: helpers pequenos compartilhados.
- `scripts/`: smoke tests e checagem sintatica.
- `test/`: testes unitarios com `node:test`.

## Contratos Criticos

### ActionResult

Toda acao planejavel deve retornar ou ser convertida para:

```text
{
  ok,
  skill,
  code,
  severity,
  retryable,
  message,
  reason,
  missingRequirements,
  worldChanged,
  inventoryDelta,
  positionDelta,
  suggestedNextActions,
  data,
  startedAt,
  finishedAt,
  durationMs
}
```

Use `actionOk`, `actionFail` e `runAction`. Nao crie formatos paralelos para sucesso/falha. Quando uma falha puder ser resolvida por outra acao, preencha `missingRequirements` e `suggestedNextActions`.

`crafting.js` ja retorna faltas de materiais como `missingRequirements` estruturados e sugere acoes como buscar em container ou coletar item no mundo.

### SkillRegistry

`skills.js` e a fronteira entre futuro planner e acoes reais.

Contrato esperado de skill:

```text
id
description
inputSchema
risk
timeoutMs
interruptible
requires
preconditions
postconditions
effects
cost
plannerHints
run(args, context)
```

Use `registry.plan(id, args, context)` para avaliar viabilidade sem executar. Use `registry.execute(id, args, context)` para executar com validacao, pre-condicoes e timeout.

Se criar nova skill, declare pelo menos:

- `inputSchema` com argumentos obrigatorios/opcionais.
- `requires` para estado necessario, como `botOnline`, `notReconnecting`, `navigationReady`.
- `effects` para o que pode mudar, como `inventory`, `world`, `position`, `containerMemory`.
- `risk` e `timeoutMs`.
- `plannerHints` com uso operacional curto.

### Perception Tokens

`perception.js` transforma mundo em tokens ranqueados. Tokens podem representar blocos, grupos, entidades, drops, perigos e containers. A coleta deve preferir candidatos vindos da percepcao em vez de criar busca paralela sem necessidade.

Campos importantes:

```text
kind
name
category
position
distance
direction
heads
score
reasons
extras especificos
```

Objetivos de percepcao alteram pesos internos. Antes de mudar scoring, confira chamadas em coleta, containers, survival e comandos de debug.

### Catalogo

`catalog.js` e a fonte para resolver blocos/itens. Nao hardcode listas grandes de itens vanilla fora dele. Use aliases manuais apenas para portugues, sinonimos e categorias semanticas.

### Inventario

Use snapshots e diffs de `inventory.js` para validar coleta, crafting, retirada/deposito e drops. Evite comparar somente mensagens de chat quando o inventario pode confirmar a mudanca.

## Fluxos Criticos

### Comando De Chat

```text
bot-runtime.js recebe chat
  -> commands.js valida dono e interpreta texto
  -> chama modulo especifico ou helper
  -> modulo retorna efeito ou mensagem
```

Comandos atuais ainda podem chamar helpers diretamente. Para a futura mente, preferir expor acoes importantes via `SkillRegistry`.

### Execucao Por Skill

```text
planner/comando futuro
  -> skillRegistry.plan(id, args)
  -> se ok, skillRegistry.execute(id, args)
  -> run(args, context)
  -> ActionResult
```

Se uma skill falha, procure primeiro em `data.plan`, `reason`, pre-condicoes e timeout antes de investigar Mineflayer.

### Coleta/Mining

```text
collection.collect
  -> perception.refresh/getWorldTokens
  -> resolve target pelo catalogo/inventario
  -> escolhe candidato por score, seguranca e acessibilidade
  -> navega/olha/equipa ferramenta
  -> quebra bloco
  -> coleta drops
  -> valida diff de inventario
```

Falhas comuns:

- alvo subterraneo ou sem linha limpa;
- ferramenta inadequada;
- drop caiu longe;
- inventario cheio;
- perigo local abortou;
- movimento/pathfinder dessincronizado.

### Containers

```text
containers.scan/search/withdraw/deposit
  -> descobre containers por percepcao/busca local
  -> move ate container
  -> abre, le janela, fecha sempre
  -> classifica papel logistico por conteudo
  -> atualiza memoria
  -> retira/deposita conforme modo
```

Sempre preserve fechamento de janelas em `finally`. Evite loops: use limites de raio, visited set, cooldown/memoria e timeout.

Containers usam classificacao em camadas: `primaryRole`, `secondaryRole`, `specificRole`, `confidence`, `mixed` e `evidence`. Casos especiais relevantes:

- madeiras: `blocks/wood/oak`, `blocks/wood/spruce`, etc.
- pedras: `blocks/stone/stone`, `blocks/stone/cobblestone`, `blocks/stone/andesite`, `blocks/stone/diorite`, `blocks/stone/granite`, `blocks/stone/deepslate`.
- quando a categoria ampla e clara mas a subcategoria nao e, use `mixed` ou `unknown` na camada especifica, nao force certeza falsa.

### Survival Guard

```text
tick/runtime
  -> survival.assess()
  -> recomenda ou executa reacao curta
```

Survival nao deve virar planner completo. Ele deve reagir a risco imediato e produzir sinais claros para uma mente futura. Cuidado para nao conflitar com skills ativas: cheque `activeSkill`, risco e cancelamento.

### Reconnect E Movimento Travado

Problemas historicos envolveram dano/knockback, queda e desync de movimento. Ao depurar:

1. Veja `navigation.js` para controles, recovery e probe.
2. Veja `bot-runtime.js` para eventos e reconexao.
3. Veja `survival.js` se alguma reacao esta interferindo.
4. Veja `collection.js` ou `placement.js` se a skill deixou controles ativos.

## Pontos De Debug Por Sintoma

- "Bot responde no chat mas nao move": `navigation.js`, `bot-runtime.js`, `survival.js`, estado `reconnecting`, controles ativos, pathfinder parado.
- "Bot escolhe bloco ruim": `perception.js`, `collection.js`, catalogo, linha de visao, categoria do token, objetivo atual.
- "Bot quebra mas nao coleta": `collection.js`, drops, diff de inventario, inventario cheio, distancia do drop.
- "Craftou quantidade errada": `crafting.js`, `plannedCraftRuns`, `plannedCraftOutput`, receitas do `minecraft-data`.
- "Item nao resolve": `catalog.js`, aliases, contexto `collect/dropped/inventory`, testes de catalogo.
- "Container abre errado ou repete": `containers.js`, memoria, visited set, TTL, fechamento da janela.
- "Comando ambiguo": `commands.js`, parsers exportados, testes em `test/commands-parsers.test.js`.
- "Skill deveria falhar antes": `skills.js`, `inputSchema`, `requires`, `preconditions`, timeout.

## Regras Para Mudancas Futuras

- Nao criar um segundo catalogo de itens/blocos fora de `catalog.js`.
- Nao criar formato alternativo de resultado fora de `ActionResult`.
- Nao criar skill planejavel sem registrar contrato no `SkillRegistry`.
- Nao bypassar percepcao para coleta/mining quando o alvo ja pode ser encontrado por tokens.
- Nao deixar loops sem limite de raio, quantidade, tentativas e timeout.
- Nao deixar movimento, janela de container ou controle de bot sem cleanup em `finally`.
- Nao transformar `survival.js` em planner de longo prazo.
- Nao colocar novas responsabilidades grandes em `main.js`; use modulo e injecao.

## Testes E Validacao

Comando principal:

```bash
npm test
```

Ele roda:

```text
npm run check
npm run lint
npm run test:unit
npm run test:smoke
```

Ao alterar:

- `catalog.js`: atualize/rode testes de catalogo.
- `commands.js`: atualize `test/commands-parsers.test.js`.
- `skills.js`: atualize `test/inventory-skills.test.js` e `scripts/check-skills.js`.
- `crafting.js`: atualize `test/crafting.test.js` e smoke de crafting.
- `perception.js`: atualize `test/perception.test.js` quando mudar token/scoring publico.
- `containers.js`: rode smoke de containers e teste manual no jogo.

## Preparacao Para Mente Em Linguagem Natural

O planner futuro deve consumir:

```text
state.snapshot
SkillRegistry.list()
SkillRegistry.plan()
SkillRegistry.execute()
perception summaries/tokens
inventory summaries/snapshots
survival status
container memory
```

O planner nao deve conhecer detalhes do Mineflayer quando uma skill ja encapsula a acao. Se o planner precisar saber detalhes demais para agir, provavelmente falta contrato, `state` ou skill intermediaria.

## Atualizacao Deste Arquivo

Atualize este mapa quando:

- um modulo novo for criado;
- uma responsabilidade mudar de arquivo;
- o fluxo de skill, comando, percepcao, survival ou runtime mudar;
- uma regra de troubleshooting importante for descoberta;
- uma decisao arquitetural reduzir ou aumentar acoplamento entre modulos.
