# MineGPT Bot

Bot experimental para Minecraft Java 1.20.4 usando Mineflayer. O objetivo do projeto e criar um ajudante autonomo para survival vanilla, com percepcao do mundo, inventario, coleta, crafting, sobrevivencia reativa e uma base preparada para futura interpretacao por linguagem natural.

## Estado atual

O bot ja possui:

- comandos via chat restritos ao jogador definido em `owner`;
- navegacao com `mineflayer-pathfinder`;
- percepcao do mundo com cache e attention scoring heuristico;
- catalogo de blocos/itens baseado em `minecraft-data`;
- aliases em portugues para alvos comuns;
- gerenciamento de inventario, hotbar, mao e drop de itens;
- coleta/mineracao de blocos percebidos;
- colocacao segura de blocos simples no mundo;
- busca manual e automatica de drops;
- crafting direto seguro e cadeia curta para itens basicos;
- interacao com containers: scan, memoria, busca, retirada, deposito e classificacao logistica semantica;
- Survival Guard com diagnostico, pedidos de ajuda, comida automatica e reacoes curtas;
- skill registry, ActionResult e snapshot de estado para futuro planner/IA.
- fundacao de planner em `ai/`, ainda mockada/deterministica, com runner de ciclos curtos e sem API externa.

## Requisitos

- Node.js 18+ recomendado
- Minecraft Java 1.20.4
- Um mundo LAN ou servidor acessivel localmente
- Uma instancia separada do Minecraft e recomendada para testes

## Instalacao

```bash
npm install
cp config.example.json config.json
```

Edite `config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 25565,
  "version": "1.20.4",
  "username": "MineGPTBot",
  "auth": "offline",
  "owner": "SeuNick"
}
```

`config.json` nao deve ser commitado. Ele fica ignorado pelo `.gitignore`.

## Uso

Inicie o bot:

```bash
npm start
```

Pare o processo com `Ctrl+C`.

Dentro do jogo, use `ajuda` para ver os comandos principais.

## Comandos principais

### Movimento

- `seguir`
- `vir aqui`
- `parar`
- `destravar`
- `reconectar`
- `navstatus`
- `pular`
- `onde voce esta`
- `ir X Y Z`
- `nav modo seguro`
- `nav modo blocos`
- `nav modo avancado`
- `nav parkour on|off`
- `nav blocos on|off`
- `nav quebrar on|off`

### Percepcao

- `scan`
- `atencao`
- `perigos`
- `recursos`
- `entidades`
- `arredores`
- `percepcao`
- `resolver ALVO`
- `objetivo`
- `objetivo neutro`
- `objetivo sobreviver`
- `objetivo seguir`
- `objetivo coletar_madeira`
- `objetivo explorar`
- `objetivo craftar`

### Inventario

- `status`
- `inventario`
- `hotbar`
- `mao`
- `segure ITEM`
- `drop ITEM`
- `drop ITEM QUANTIDADE`
- `hotbar SLOT ITEM`
- `coletas`

### Coleta e drops

- `coletar ALVO`
- `coletar QUANTIDADE ALVO`
- `pegar drops`
- `pegar ALVO`
- `drops`
- `drops on`
- `drops off`

Exemplos:

- `coletar carvao`
- `coletar 5 stone`
- `coletar madeira`
- `pegar drops`
- `pegar coal`

### Colocar blocos

- `blocos`
- `colocar BLOCO`
- `colocar BLOCO na frente`
- `colocar BLOCO abaixo`
- `colocar BLOCO perto de mim`
- `colocar BLOCO em X Y Z`

Exemplos:

- `blocos`
- `colocar dirt`
- `colocar cobblestone na frente`
- `colocar bloco abaixo`
- `colocar dirt em 10 64 -20`

A skill usa apenas blocos existentes no inventario, exige posicao livre, face de apoio valida, distancia curta ou navegavel, risco baixo e confirmacao do bloco colocado.

### Containers

- `containers`
- `containers conhecidos`
- `containers scan`
- `lembrar baus`
- `containers esquecer`
- `procurar ITEM`
- `procurar ITEM em baus proximos`
- `buscar ITEM em container`
- `pegar ITEM de bau`
- `guardar ITEM`
- `guardar tudo`
- `guardar recursos`
- `guardar blocos`
- `guardar drops`

Exemplos:

- `containers scan`
- `procurar carvao em baus proximos`
- `buscar 16 coal em container`
- `pegar pao de bau`
- `guardar cobblestone`
- `guardar blocos`

A memoria de containers fica em RAM, expira para uso pratico apos alguns minutos e evita reabrir o mesmo container repetidamente na mesma busca. O bot preserva por padrao ferramentas, armas, armadura, cama, comida minima, tochas minimas e flechas minimas.

### Crafting

- `crafting status`
- `receita ITEM`
- `craft ITEM`
- `craft QUANTIDADE ITEM`

Exemplos:

- `receita stick`
- `craft stick`
- `craft 4 torch`
- `craft crafting_table`
- `craft stone_pickaxe`

O numero em `craft QUANTIDADE ITEM` significa quantidade final desejada, nao numero de execucoes da receita. Se a receita gera 4 tochas, `craft 4 torch` faz 1 craft.

### Survival Guard

- `survival`
- `survival status`
- `survival on`
- `survival off`
- `survival pedir`
- `survival debug`

O Survival Guard monitora vida, fome, mobs, lava, fogo, magma, quedas e afogamento. Ele pode comer automaticamente, pedir ajuda, parar uma acao em risco critico, usar escudo, evitar certas ameacas e reagir de forma conservadora.

### Base para planner

- `estado`
- `planner estado`
- `planner compacto`
- `skills`
- `bot COMANDO`

O prefixo experimental `bot` usa providers locais em `ai/`, sem API externa. O padrao seguro e `rule_based`; `mock` continua disponivel para regressao e `ollama` fica reservado para LLM local. Exemplos:

- `bot estado`
- `bot vem aqui`
- `bot para`
- `bot segue`
- `bot pega madeira`
- `bot faz crafting table`
- `bot plano pega madeira`
- `bot confirmar`
- `bot cancelar`
- `bot llm`
- `bot modelo`
- `bot perfil`
- `bot provider`

Por padrao, o runner executa no maximo uma acao por comando. A estrutura interna ja aceita ciclos curtos controlados para testes futuros, com bloqueios por risco, survival, skill ativa e repeticao.

Esses comandos validam o fluxo chat -> planner -> SkillRegistry -> ActionResult. O planner ainda e deterministico e limitado.

Para ver o que o planner faria sem executar nada:

```text
bot plano <pedido>
```

Exemplos:

```text
bot plano pega madeira
bot plano guarda tudo
```

O dry-run chama o planner, valida a decisao e roda `SkillRegistry.plan()`, mas nunca chama `SkillRegistry.execute()`.

Algumas acoes planejadas exigem confirmacao antes de executar, principalmente:

- `inventory.drop`;
- `containers.deposit` com `mode=all`;
- `blocks.place` em coordenadas;
- `movement.go_to` para coordenadas;
- qualquer skill `risk=high`;
- skills futuras marcadas como sensiveis/destrutivas;
- acoes que mencionem itens valiosos conhecidos, como diamante, esmeralda, netherite, elytra ou totem.

Quando isso acontecer, confirme ou cancele:

```text
bot confirmar
bot cancelar
```

A confirmacao expira, fica apenas em memoria e guarda somente skill, argumentos compactos e motivos. Antes de executar uma acao confirmada, o bot chama `SkillRegistry.plan()` novamente; se houver `activeSkill`, survival alto/critico ou mudanca de estado que torne o plano inseguro, a acao e bloqueada.

O runner tambem consegue fazer recuperacao simples baseada em `ActionResult.suggestedNextActions`. Se uma skill falhar e sugerir uma proxima skill estruturada, o runner pode usar essa sugestao sem chamar o LLM de novo, desde que `maxSteps` ainda permita e que a sugestao passe por `SkillRegistry.plan()`, risco, survival, `activeSkill`, repeticao e confirmacao sensivel. A ordem local prefere:

1. `containers.withdraw` para item faltante conhecido;
2. `collection.collect` para recurso coletavel;
3. `crafting.craft` para dependencia basica.

Configure por ambiente:

```bash
MINEGPT_AI_RECOVERY=local npm start
MINEGPT_AI_RECOVERY=off npm start
MINEGPT_AI_RECOVERY=llm npm start
```

O padrao e `local`. `off` preserva a falha original sem tentar recuperacao. `llm` permite que o proximo passo do ciclo volte ao provider quando `maxSteps` permitir. Sugestoes invalidas, ambiguas, repetidas ou sensiveis demais sao bloqueadas.

## LLM local com Ollama

O projeto nao usa OpenAI API, nao exige pagamento e nao salva modelos no repositorio. Os scripts abaixo apenas verificam ou preparam uma instalacao local do Ollama no sistema.

Use primeiro um mundo de teste ou copia de backup. O caminho rapido recomendado e:

```bash
npm run llm:check
npm run llm:setup
npm run llm:bench
MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based MINEGPT_AI_PROFILE=equilibrio npm start
```

O perfil padrao recomendado e `equilibrio`. Para um checklist completo de validacao no Minecraft antes do mundo principal, leia `docs/LOCAL_LLM_TEST_SCENARIOS.md`.

Modelo alvo para este hardware:

- Zorin OS 18 / Linux
- Ryzen 5 3600
- NVIDIA RTX 3060 12 GB
- 16 GB RAM
- `qwen2.5:14b-instruct`, com fallback para `qwen2.5:14b`

Verifique o ambiente local:

```bash
npm run llm:check
```

Esse comando nao quebra se Ollama nao estiver instalado; ele mostra se o binario existe, se o servidor responde em `http://localhost:11434`, se o modelo foi encontrado e qual correcao fazer.

Para instalar o Ollama, use o metodo oficial para Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Depois prepare o modelo local:

```bash
npm run llm:setup
```

O setup e idempotente: se Ollama e modelo ja existirem, ele evita baixar de novo. Se o servidor local nao estiver respondendo, ele tenta iniciar `ollama serve` sem `sudo`. Se o modelo nao existir, ele roda `ollama pull qwen2.5:14b-instruct` e, se necessario, tenta `qwen2.5:14b`.

Para baixar/verificar apenas o modelo:

```bash
npm run llm:pull
```

Perfis de execucao local:

- `economia`: `num_ctx=2048`, `max_output_tokens=160`, `timeout_ms=15000`, `keep_alive=30s`.
- `equilibrio`: perfil padrao, `num_ctx=4096`, `max_output_tokens=256`, `timeout_ms=20000`, `keep_alive=5m`.
- `performance`: `num_ctx=8192`, `max_output_tokens=384`, `timeout_ms=30000`, `keep_alive=15m`.

O projeto nao usa contexto de 128K, nao usa `max_steps > 1` por padrao e limita saida porque o planner deve retornar JSON curto. Escolha o perfil por ambiente:

```bash
MINEGPT_AI_PROFILE=economia npm start
MINEGPT_AI_PROFILE=equilibrio npm start
MINEGPT_AI_PROFILE=performance npm start
```

Alias aceitos: `economy` -> `economia`, `balanced`/`balanceado` -> `equilibrio`, `desempenho`/`perf` -> `performance`. Perfil desconhecido cai para `equilibrio`.

Ative o provider local quando a integracao Ollama estiver habilitada:

```bash
MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based MINEGPT_AI_URL=http://localhost:11434 MINEGPT_AI_PROFILE=equilibrio MINEGPT_AI_MODEL=qwen2.5:14b-instruct npm start
```

Volte para o planner local deterministico:

```bash
MINEGPT_AI_PROVIDER=rule_based npm start
```

O provider `ollama` usa apenas o servidor local do Ollama. Ele envia estado compacto, skills seguras, historico curto e um JSON Schema para `/api/chat` com structured outputs. Se o Ollama estiver offline e `MINEGPT_AI_FALLBACK_PROVIDER=rule_based` ou `mock` estiver configurado, o bot cai para esse provider local; se nao houver fallback, ele responde erro claro e nao executa acao.

Protecoes para sessoes longas:

- `MINEGPT_AI_MAX_CALLS_PER_MINUTE=6` limita chamadas ao Ollama por minuto. Ao exceder, o bot responde para tentar de novo em alguns segundos e nao cai para fallback executando a intencao original.
- Cada chamada Ollama usa `timeout_ms` do perfil ativo ou `MINEGPT_AI_TIMEOUT_MS`; uma chamada pendurada nao deve travar o processo principal.
- `bot para`, `bot pare` e `bot parar` sao tratados localmente: abortam a decisao LLM em andamento quando possivel e priorizam `movement.stop`.
- `MINEGPT_AI_SKILLS_CACHE_TTL_MS=30000` cacheia somente a lista compacta de skills por curto periodo. Estado do mundo e decisoes nao sao cacheados.
- `bot llm` faz apenas healthcheck leve em `/api/tags` com timeout curto. O bot nao chama modelo automaticamente em loop nem por tick.
- O perfil padrao continua `equilibrio`; o projeto nao aumenta contexto, `max_steps` ou perfil `performance` automaticamente.

No chat, use `bot llm` ou `bot modelo` para ver provider atual, fallback, modelo, perfil, `num_ctx`, limite de saida, timeout, URL local do Ollama e um healthcheck leve em `/api/tags`. Esse diagnostico nao chama geracao do modelo.

Tambem existem consultas especificas:

```text
bot perfil
bot provider
```

Os comandos abaixo validam o nome pedido, mas nao alteram o runtime por seguranca. Para aplicar, reinicie o bot com a variavel de ambiente indicada na resposta:

```text
bot perfil economia
bot perfil equilibrio
bot perfil performance
bot provider mock
bot provider rule_based
bot provider ollama
```

Para depurar o payload enviado ao LLM local, use:

```bash
MINEGPT_AI_DEBUG=1 MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based npm start
```

Com debug ativo, o console mostra tamanho aproximado do payload em caracteres, numero de skills enviadas, modelo, perfil, tempo da chamada Ollama e status de parse/validacao. Sem `MINEGPT_AI_DEBUG=1`, esses logs ficam desativados.

### Benchmark local do planner

Depois de instalar o Ollama e baixar o modelo, rode cenarios fixos sem abrir Minecraft:

```bash
npm run llm:bench
```

O benchmark usa um `plannerState` fake minimo, uma lista segura de skills fake baseada no `SkillRegistry`, chama apenas o provider Ollama e valida a resposta localmente. Ele nao executa skills reais, nao abre Minecraft e nao altera mundo.

Para comparar perfis:

```bash
npm run llm:bench:economia
npm run llm:bench:equilibrio
npm run llm:bench:performance
```

O resumo mostra modelo, perfil, tempo medio, p95 simples, maior tempo, taxa de JSON valido, taxa de decisoes validas, skills existentes e argumentos coerentes. Use `economia` quando a latencia/VRAM pesar, `equilibrio` como padrao de uso e `performance` para medir se mais contexto melhora decisoes sem custo excessivo.

Se o Ollama estiver offline ou o modelo estiver ausente, o script imprime diagnostico e sugestoes como `npm run llm:check`, `ollama serve` e `npm run llm:pull`, sem quebrar o projeto.

## Arquitetura

- `index.js`: entrypoint minimo que inicia `main.js`.
- `main.js`: montagem das dependencias, skills e estado compartilhado.
- `bot-runtime.js`: criacao do bot, eventos, conexao e reconexao.
- `commands.js`: parser e execucao dos comandos de chat.
- `navigation.js`: controlador de navegacao, modos e recuperacao de travamento.
- `collection.js`: coleta/mineracao de blocos e drops.
- `utils.js`: helpers compartilhados pequenos.
- `catalog.js`: catalogo/resolucao de blocos e itens usando `minecraft-data`.
- `inventory.js`: helpers de inventario, hotbar, snapshots e diffs.
- `perception.js`: percepcao, tokens, attention scoring e agrupamento de blocos.
- `survival.js`: Survival Guard, riscos e reacoes curtas.
- `crafting.js`: crafting direto seguro e cadeia curta para itens basicos.
- `placement.js`: colocacao segura de blocos simples.
- `containers.js`: memoria, interacao segura e classificacao logistica de containers.
- `skills.js`: skill registry para futura IA/planner, com contratos de argumentos, requisitos, efeitos, risco, custo e `plan()`.
- `action-result.js`: resultado padronizado de acoes, com codigos, severidade, retry, requisitos faltantes e sugestoes para planner.
- `state.js`: snapshot estruturado do estado do bot.
- `ai/`: schema de decisao do planner, adapter seguro de skills e providers locais de planner.
- `AGENT_MAP.md`: mapa operacional para agentes de codigo depurarem e evoluirem o projeto.
- `scripts/`: smoke tests e checagem sintatica.
- `test/`: testes unitarios com `node:test`.

## Testes

```bash
npm test
```

Atualmente os testes verificam sintaxe e smoke tests de catalogo, inventario, skills, crafting, colocacao de blocos e containers.
Agora tambem rodam ESLint e testes unitarios para parsers, catalogo, inventario, crafting, ActionResult, SkillRegistry e percepcao basica.

Comandos uteis:

```bash
npm run check
npm run lint
npm run test:unit
npm run test:smoke
npm run llm:check
npm run llm:setup
npm run llm:bench
npm run coverage
```

O repositorio tambem possui GitHub Actions em `.github/workflows/ci.yml`, rodando `npm test` em push para `main` e pull requests.

## Seguranca e limitacoes

- O bot ainda e experimental.
- Use em uma instancia/mundo de teste antes de usar no seu mundo principal.
- O bot nao deve receber credenciais no codigo.
- `config.json` e `.env` sao ignorados.
- Crafting ainda nao coleta automaticamente recursos faltantes.
- A memoria de containers ainda nao persiste entre reinicios.
- Deposito automatico e conservador e pode preservar itens demais ate refinarmos as regras.
- A futura camada de linguagem natural deve chamar skills registradas, nao controlar Mineflayer diretamente.
- Para estado de IA/planner, use o snapshot compacto (`planner compacto` no chat ou `state.planner_snapshot` via SkillRegistry).
- Antes de implementar a camada `bot`, leia `docs/AI_PLANNER_READINESS.md`.

## Licenca

ISC.
