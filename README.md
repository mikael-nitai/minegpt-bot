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
- interacao inicial com containers: scan, memoria, busca, retirada e deposito;
- Survival Guard com diagnostico, pedidos de ajuda, comida automatica e reacoes curtas;
- skill registry, ActionResult e snapshot de estado para futuro planner/IA.

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
- `skills`

Esses comandos expõem estado e skills registradas para a futura camada de linguagem natural.

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
- `containers.js`: memoria e interacao segura com containers.
- `skills.js`: skill registry para futura IA/planner.
- `action-result.js`: resultado padronizado de acoes.
- `state.js`: snapshot estruturado do estado do bot.
- `scripts/`: smoke tests.

## Testes

```bash
npm test
```

Atualmente os testes verificam sintaxe e smoke tests de catalogo, inventario, skills, crafting, colocacao de blocos e containers.

## Seguranca e limitacoes

- O bot ainda e experimental.
- Use em uma instancia/mundo de teste antes de usar no seu mundo principal.
- O bot nao deve receber credenciais no codigo.
- `config.json` e `.env` sao ignorados.
- Crafting ainda nao coleta automaticamente recursos faltantes.
- A memoria de containers ainda nao persiste entre reinicios.
- Deposito automatico e conservador e pode preservar itens demais ate refinarmos as regras.
- A futura camada de linguagem natural deve chamar skills registradas, nao controlar Mineflayer diretamente.

## Licenca

ISC.
