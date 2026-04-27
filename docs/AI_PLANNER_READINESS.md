# AI Planner Readiness

Auditoria tecnica da fronteira entre chat commands, estado e skills antes de adicionar uma camada futura de IA chamada por mensagens com prefixo `bot`.

Esta auditoria nao implementa IA, nao adiciona dependencia de API e nao cria comando novo. O objetivo e registrar o estado atual, riscos reais e ajustes minimos recomendados antes de conectar um planner.

## Estado Atual Da Arquitetura

O projeto ja tem os blocos corretos para uma primeira camada planejadora:

- `commands.js` recebe comandos humanos via chat e chama modulos diretamente.
- `main.js` monta os helpers e registra skills no `SkillRegistry`.
- `skills.js` oferece `list()`, `plan()` e `execute()` com validacao simples, requisitos, efeitos, risco, timeout e custo.
- `action-result.js` padroniza `ok`, `code`, `severity`, `retryable`, `missingRequirements`, `inventoryDelta`, `positionDelta` e `suggestedNextActions`.
- `state.js` produz um snapshot estruturado via `getStateSnapshot()` e uma serializacao JSON via `describeForPlanner()`.
- `catalog.js`, `inventory.js`, `perception.js`, `containers.js` e `crafting.js` ja expoem informacoes suficientes para resolver nomes, estado de inventario, mundo ao redor, containers e faltas de crafting.

O caminho correto para a IA e:

```text
mensagem "bot ..."
  -> interpretar intencao
  -> ler stateReporter/planner state
  -> consultar skillRegistry.list()
  -> chamar skillRegistry.plan(id, args)
  -> executar skillRegistry.execute(id, args)
  -> observar ActionResult
  -> continuar, pedir ajuda ou parar
```

O planner nao deve controlar Mineflayer diretamente.

## Skills Registradas E Prontidao Para IA

### Seguras Para Chamada Experimental

Estas skills ja retornam `ActionResult` real ou sao consultas simples:

- `state.snapshot`: boa skill de leitura. O estado e util, mas ainda pode ser verboso para contexto de LLM.
- `survival.status`: leitura segura do risco atual.
- `crafting.recipe`: leitura segura, mas retorna texto; futuramente deveria retornar receita/faltas estruturadas.
- `crafting.craft`: relativamente boa. Ja retorna `missingRequirements` e `suggestedNextActions` para faltas de material e crafting table.
- `inventory.equip`: retorna `ActionResult` honesto para sucesso, item ausente, nome ambiguo e falha de equipar.
- `inventory.hotbar`: retorna `ActionResult` honesto para sucesso, slot invalido, item ausente, nome ambiguo e falha de mover slot.
- `collection.collect`: agora usa action planejavel que retorna `ActionResult` com `code`, `worldChanged`, ganhos e `inventoryDelta`.
- `blocks.place`: boa base para planner experimental. Valida bloco, risco, posicao, suporte e confirmacao final.
- `containers.scan`: aceitavel. Tem limites de raio/quantidade/timeout e memoria.
- `containers.search`: aceitavel. Busca em memoria e containers proximos, mas falhas ainda poderiam ter `code` mais especifico.
- `containers.withdraw`: aceitavel, mas sucesso parcial precisa ser tratado pelo planner via `data.remaining`.
- `containers.deposit`: aceitavel, mas sucesso parcial tambem precisa ser tratado por `data.remaining`.
- `movement.stop`: segura e util para abortar.

### Parcialmente Seguras, Mas Podem Enganar O Planner

Estas skills existem, mas `ok=true` nao significa necessariamente que a tarefa terminou:

- `movement.follow_owner`: retorna sucesso apos definir goal continuo, nao apos acompanhar de fato.
- `movement.come_here`: retorna sucesso apos definir goal, nao apos chegar.
- `movement.go_to`: retorna sucesso apos definir goal, nao apos chegar nas coordenadas.
- `inventory.drop`: agora retorna falha honesta para item ausente/quantidade invalida; em `plannerMode`, a policy inicial exige permissao explicita do usuario.
- `drops.collect`: retorna sucesso mesmo se nenhum item foi coletado; o planner precisa verificar `data.gains`.

### Nao Prontas Para IA Sem Ajuste

No momento, as skills prioritarias de inventario e coleta nao dependem mais de wrappers de chat para indicar sucesso/falha ao `SkillRegistry`.

Pendencia restante nesta categoria: revisar gradualmente skills de movimento continuo, porque elas ainda retornam sucesso quando o goal foi iniciado, nao quando foi concluido.

## Modulos Que Misturam Chat Command E Skill Planejavel

### `commands.js`

As funcoes de inventario do chat (`equipItemByName`, `dropItemByName`, `moveItemToHotbar`) agora chamam actions estruturadas de `inventory.js` e apenas traduzem o resultado para mensagens humanas.

Ainda assim, `commands.js` continua misturando muitos comandos humanos com chamadas diretas a modulos. Para a IA, o caminho correto continua sendo `SkillRegistry`, nao comandos de chat.

Historicamente essas funcoes:

- validam erro falando no chat;
- nao retornam estrutura de sucesso/falha;
- sao reutilizadas por skills em `main.js`.

Estado atual: inventario ja foi corrigido; aplicar o mesmo padrao gradualmente para coleta e navegacao.

### `collection.js`

Tem uma boa funcao interna `collectOneBlockByTarget()`. A skill planejavel agora chama `collectByTargetAction()`, que retorna `ActionResult`.

As funcoes publicas usadas por comando humano (`collectBlockByTarget`, `collectMultipleBlocksByTarget`) continuam falando no chat para preservar UX atual.

### `navigation.js`

As funcoes de movimento sao orientadas a comando continuo ou goal assíncrono. Elas nao retornam quando o objetivo foi concluido.

Recomendacao: criar skills planejaveis separadas para `movement.goto_completed` e `movement.come_here_completed`, com wait por `goal_reached`, timeout real, cancelamento e validacao de distancia final. As skills atuais podem continuar como comandos/controle.

## ActionResult Que Precisa Ficar Mais Honesto

Prioridade alta restante:

- `inventory.drop`: ja retorna `code`, `inventoryDelta` negativo e `worldChanged: true`; em `plannerMode`, ja e bloqueada sem permissao explicita.
- `movement.go_to`/`come_here`: distinguir `goal_started` de `goal_reached`. Para planner, preferir skill que aguarde conclusao.

Prioridade media:

- `containers.withdraw`: se retirou parcialmente, retornar `code: partial_success` ou `severity: warning`.
- `containers.deposit`: se guardou parcialmente, idem.
- `containers.search`: em falha, preencher `missingRequirements: [{ type: "item", name, count? }]` quando o alvo for item resolvido.
- `drops.collect`: se nao coletou nada, talvez `ok=false` com `code: no_drops_collected` quando chamado por planner; para comando humano atual pode continuar aceitavel.
- `blocks.place`: enriquecer `code`, `worldChanged: true`, `inventoryDelta` negativo e `missingRequirements` para bloco ausente.
- `crafting.recipe`: retornar dados estruturados alem de texto.

## Estado Para Planner

`stateReporter.getStateSnapshot()` ja e adequado para debug. Para a IA, existe tambem `getPlannerSnapshot()`, mais compacto e estavel.

Pontos fortes:

- contem online/reconnecting/activeSkill;
- vida, fome, oxigenio, posicao e mao;
- inventario resumido;
- objetivo perceptivo;
- top attention/hazards/resources;
- survival status;
- navigation describe;
- containers e coletas recentes.

Limites:

- `inventory` e array de strings, nao objetos `{ name, count }`.
- `navigation` e string humana, dificil para o planner comparar.
- `perception.cache` tambem e string.
- top tokens sao compactos, mas ainda podem consumir contexto demais se enviados sempre.
- containers podem ficar verbosos com itens e roles.
- nao ha campo explicito de `canAct`, `safeToAct`, `busy`, `recommendedImmediateAction`.

Formato conceitual usado por `getPlannerSnapshot()`:

```text
{
  status: { online, reconnecting, busy, activeSkill, safeToAct },
  vitals: { health, food, oxygen, position },
  heldItem,
  inventory: [{ name, count }],
  topAttention: [...limit 5],
  hazards: [...limit 3],
  survival: { enabled, severity, top },
  containers: { known, nearby, topRoles },
  recent: { collections },
  skills: opcionalmente separado via SkillRegistry.list()
}
```

## Riscos De Timeout Sem Cancelamento Real

Risco real: `skills.js` e `utils.js` usam `Promise.race` para timeout. Isso encerra a espera, mas nao necessariamente cancela a acao Mineflayer em andamento.

Exemplos:

- `bot.pathfinder.goto(...)` pode continuar se o timeout dispara e o caller nao parar pathfinder em `finally`.
- `bot.craft`, `bot.dig`, `openContainer`, `withdraw`, `deposit`, `placeBlock` podem ter efeitos depois do timeout dependendo da API/servidor.
- `SkillRegistry.execute()` marca timeout, mas nao chama uma rotina de cancelamento da skill.

Mitigacoes ja existentes:

- Muitas skills chamam `pathfinder.stop()` e `clearControlStates()` em `finally`.
- Containers fecham janela em `finally`.
- Navigation damage/reconnect reseta movimento.

Lacuna antes da IA:

- Adicionar `onTimeout`/`cleanup` opcional no `SkillRegistry`, ou padronizar `finally` nas actions planejaveis.
- Para skills compostas futuras, cancelar explicitamente subacao em timeout.

## Riscos De Acoes Perigosas Ou Repetitivas

Riscos altos:

- `inventory.drop` pode descartar itens valiosos se um planner interpretar mal.
- `blocks.place` altera mundo; ja e limitado, mas pode ser repetido para espalhar blocos.
- `collection.collect` altera mundo; precisa de limite por plano e honestidade de resultado.
- `containers.deposit` pode guardar itens em local errado se o planner chamar modo amplo demais.
- `containers.clear_memory` pode apagar contexto util; deve ser baixo risco humano, mas nao deve ser escolhido livremente pela IA.
- `survival.set_enabled` pode desligar protecao; planner nao deve fazer isso sem comando explicito do usuario.
- `movement.go_to` para coordenada distante pode mover o bot para risco ou ficar preso.

Riscos aceitaveis para primeira versao experimental:

- Chamar `state.snapshot`, `survival.status`, `crafting.recipe`, `containers.search`.
- Chamar `crafting.craft` para itens simples, desde que respeite `missingRequirements`.
- Chamar `containers.withdraw` com quantidade pequena.
- Chamar `containers.deposit` apenas em modo `target` ou categorias conservadoras.
- Chamar `blocks.place` apenas para comandos explicitos do usuario, nao por decisao autonoma.

## Ajustes Priorizados Antes Da API

### P0 - Obrigatorio Antes Do Primeiro Planner

1. Separar skills de movimento em:
   - iniciar movimento/follow;
   - movimento concluido com validacao final.
2. Manter inventario e coleta como exemplos de fronteira correta: actions estruturadas em modulo de dominio, comandos de chat como adaptadores, `SkillRegistry` chamando actions diretamente.
3. Expandir policy inicial conforme surgirem comandos `bot` reais.

Ja resolvido:

- `collection.collect` no registry usa `collectByTargetAction()`.
- `getPlannerSnapshot()` foi adicionado em `state.js`.
- `SkillRegistry` tem policy inicial opcional em `plannerMode`, bloqueando `inventory.drop`, `survival.set_enabled`, `containers.clear_memory`, movimento distante e coleta acima de 3 blocos sem `explicitUserIntent`.

### P1 - Muito Recomendado

1. Enriquecer `containers.*` com `partial_success`, `inventoryDelta` e `missingRequirements`.
2. Enriquecer `blocks.place` com `code`, `worldChanged` e `inventoryDelta`.
3. Enriquecer `collection.collect` com `missing_tool`, `target_not_found`, `unsafe_area` e `inventory_full`.
4. Adicionar `ActionResult.suggestedNextActions` em containers search/withdraw quando item nao for encontrado.
5. Criar testes unitarios para `setupSkillRegistry()` com fakes, validando que skills perigosas nao retornam sucesso falso.

### P2 - Depois Da Primeira Versao Experimental

1. Skill composta `items.obtain`:
   - verificar inventario;
   - buscar em containers;
   - craftar;
   - resolver materiais faltantes;
   - coletar recursos com profundidade limitada.
2. Persistencia leve de memoria de containers.
3. Planejamento multi-step com budget de tempo, passos e risco.
4. Observacao pos-acao padronizada: comparar state antes/depois.

## Testes Necessarios Antes Da Integracao Com API

Antes de conectar API, adicionar testes para:

- `SkillRegistry` com skills reais/fakes do `main.js`, garantindo que `plan()` e `execute()` nao retornem sucesso falso.
- actions de inventario retornando `ActionResult` honesto para item ausente, ambiguo, sucesso e falha.
- collection planejavel retornando falha estruturada para alvo inexistente, inventario cheio e ferramenta inadequada.
- movimento concluido: goal reached, timeout, alvo ausente, cancelamento.
- `getPlannerSnapshot()` com bot online/offline e containers presentes.
- policy de planner bloqueando skills destrutivas ou perigosas.
- parsing futuro do prefixo `bot`, quando existir, sem interferir nos comandos atuais.
- testes de regressao para `ActionResult` com `missingRequirements` e `suggestedNextActions`.

Os testes que dependem diretamente de Mineflayer real ainda podem ficar manuais/smoke, mas parsers, state compacto, policies, skill contracts e actions puras devem ter teste unitario.

## Proposta Incremental De Implementacao

### Fase 1 - Fronteira Honesta

- Criar actions planejaveis de inventario fora de `commands.js`.
- Corrigir `collection.collect` para retornar `ActionResult` real.
- Adicionar `getPlannerSnapshot()`.
- Criar policy inicial de skills permitidas para IA.

Estado: fase 1 aplicada em nivel inicial. Ainda falta endurecer movimento concluido e cancelamento real em timeout.

### Fase 2 - Primeiro Parser `bot`, Sem API Externa

- Criar comando `bot ...` local com parser deterministico simples.
- Mapear apenas intencoes seguras:
  - `bot vem aqui`;
  - `bot pega X no bau`;
  - `bot crafta X`;
  - `bot guarda X`.
- Usar `SkillRegistry.plan()` antes de `execute()`.
- Retornar no chat o resultado estruturado resumido.

### Fase 3 - API De Linguagem Natural

- Conectar API somente depois da Fase 1 e 2.
- Enviar `getPlannerSnapshot()` compacto, `SkillRegistry.list()` e historico curto.
- Exigir que o modelo escolha skills/args em formato estruturado.
- Validar toda chamada com policy local antes de executar.
- Usar loop curto com limite de passos.

### Fase 4 - Skill `items.obtain`

- Implementar como skill composta com profundidade limitada.
- Usar inventario, containers, crafting e coleta.
- Parar em `missingRequirements` quando nao houver rota segura.
- Nunca coletar/minerar/colocar/drop sem budget e limite explicito.

## Conclusao

O projeto esta perto de suportar um planner experimental, mas ainda nao deve receber uma IA livre chamando todas as skills. A arquitetura correta ja existe (`SkillRegistry`, `ActionResult`, `stateReporter`, catalogo, percepcao, containers e crafting), mas a fronteira precisa ficar mais honesta antes da API.

O maior risco tecnico atual nao e interpretacao de linguagem natural; e o planner acreditar em `ok=true` quando a acao real apenas iniciou, falhou silenciosamente no chat ou teve sucesso parcial. Corrigir essa fronteira e a etapa correta antes de implementar o prefixo `bot`.
