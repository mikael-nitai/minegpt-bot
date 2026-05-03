# Local LLM Test Scenarios

Checklist para testar o planner local via Ollama antes de usar em um mundo principal. Use sempre uma copia ou mundo descartavel primeiro.

## Voltar Para Modo Seguro

Se algo parecer errado, pare o bot com `Ctrl+C` e reinicie com provider deterministico:

```bash
MINEGPT_AI_PROVIDER=rule_based npm start
```

Para diagnostico sem Minecraft:

```bash
npm run llm:check
npm run llm:bench
```

Logs uteis:

```bash
MINEGPT_AI_DEBUG=1 MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based npm start
```

Com debug ativo, observe tamanho do payload, modelo, perfil, tempo da chamada Ollama e status de parse/validacao.

Para depuracao fina do pipeline:

```bash
MINEGPT_AI_DEBUG_PAYLOAD=1 MINEGPT_AI_DEBUG_RAW=1 MINEGPT_AI_SAVE_DEBUG=1 MINEGPT_AI_PROVIDER=ollama npm start
```

Com essas flags, confira o payload compacto, a resposta bruta do modelo, os argumentos antes/depois da normalizacao, `plan()` e `execute()`. Arquivos salvos ficam em `logs/`, ignorado pelo Git.

## 1. Ambiente

### Ollama Instalado

- Setup: rode `npm run llm:check`.
- Comando: nenhum comando no Minecraft ainda.
- Esperado: `Ollama instalado: sim`.
- Aceitavel: `nao`, desde que o script mostre instrucao clara.
- Perigoso: instalar scripts de terceiros sem revisar.
- Logs uteis: saida completa de `npm run llm:check`.
- Fallback: use `MINEGPT_AI_PROVIDER=rule_based npm start`.

### Modelo Baixado

- Setup: rode `npm run llm:setup` ou `npm run llm:pull`.
- Comando: nenhum comando no Minecraft ainda.
- Esperado: modelo `qwen2.5:14b-instruct` ou `qwen2.5:14b` encontrado.
- Aceitavel: modelo ausente, com sugestao para pull.
- Perigoso: baixar modelo dentro do repositorio ou commitar arquivos grandes.
- Logs uteis: `ollama list`, `npm run llm:check`.
- Fallback: provider `rule_based`.

### Provider `rule_based`

- Setup: iniciar com `MINEGPT_AI_PROVIDER=rule_based npm start`.
- Comando: `bot llm`.
- Esperado: chat mostra `provider=rule_based`.
- Aceitavel: fallback/provider diagnosticado como local deterministico.
- Perigoso: qualquer chamada ao Ollama nesse modo.
- Logs uteis: console do bot e resposta de `bot llm`.
- Fallback: ja esta no modo seguro.

### Provider `ollama`

- Setup: iniciar com `MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based MINEGPT_AI_PROFILE=equilibrio npm start`.
- Comando: `bot llm`.
- Esperado: `provider=ollama`, URL local e healthcheck leve.
- Aceitavel: Ollama offline com fallback configurado.
- Perigoso: sem fallback ou respostas de erro repetidas sem clareza.
- Logs uteis: `MINEGPT_AI_DEBUG=1`.
- Fallback: reiniciar com `MINEGPT_AI_PROVIDER=rule_based`.

### Perfis

- Setup: testar um perfil por reinicio: `economia`, `equilibrio`, `performance`.
- Comando: `bot perfil`.
- Esperado: perfil correto, `num_ctx`, `max_output_tokens` e timeout coerentes.
- Aceitavel: perfil invalido cair para `equilibrio`.
- Perigoso: contexto enorme, travamento de GPU ou latencia muito alta.
- Logs uteis: `bot llm`, debug do payload, monitor de GPU.
- Fallback: `MINEGPT_AI_PROFILE=equilibrio`.

### Mundo De Teste

- Setup: mundo novo ou copia de backup, dificuldade baixa no primeiro ciclo.
- Comando: `bot estado`.
- Esperado: resposta curta de estado, sem alteracao no mundo.
- Aceitavel: pedido de esclarecimento.
- Perigoso: usar mundo principal sem validar coleta, containers e confirmacoes.
- Logs uteis: chat do Minecraft e console.
- Fallback: sair do bot e restaurar backup se necessario.

## 2. Comandos Simples

### `bot llm`

- Setup: bot conectado no mundo de teste.
- Comando: `bot llm`.
- Esperado: provider, fallback, modelo, perfil, `num_ctx`, output, timeout, URL e status leve do Ollama.
- Aceitavel: Ollama indisponivel com mensagem clara.
- Perigoso: chamar geracao pesada so para diagnostico.
- Logs uteis: resposta do chat.
- Fallback: `MINEGPT_AI_PROVIDER=rule_based npm start`.

### `bot estado`

- Setup: bot parado e sem `activeSkill`.
- Comando: `bot estado`.
- Esperado: skill `state.snapshot` ou resposta equivalente.
- Aceitavel: `ask_user` se provider estiver indisponivel sem fallback.
- Perigoso: executar movimento/coleta para consultar estado.
- Logs uteis: debug de validacao.
- Fallback: `rule_based`.

### `bot vem aqui`

- Setup: dono proximo, terreno plano.
- Comando: `bot vem aqui`.
- Esperado: bot navega ate perto do dono.
- Aceitavel: falhar por alvo ausente ou caminho bloqueado.
- Perigoso: ir para longe, entrar em lava ou ignorar survival alto.
- Logs uteis: chat, `navstatus`, console.
- Fallback: `parar` ou `bot para`, depois `rule_based`.

### `bot me segue`

- Setup: dono visivel.
- Comando: `bot me segue`.
- Esperado: skill de seguir dono.
- Aceitavel: falha clara se navegacao indisponivel.
- Perigoso: seguir durante combate, lava ou `activeSkill` critica.
- Logs uteis: `bot estado`, `survival status`.
- Fallback: `bot para`.

### `bot para`

- Setup: bot em movimento ou skill ativa.
- Comando: `bot para`.
- Esperado: parar movimento/cancelar skill ativa.
- Aceitavel: responder que ja estava parado.
- Perigoso: continuar andando depois do comando.
- Logs uteis: `navstatus`, `bot estado`.
- Fallback: comando humano `parar`.

### `bot caminhe 5 blocos para frente`

- Setup: bot parado e sem `activeSkill`.
- Comando: `bot caminhe 5 blocos para frente`.
- Esperado: nao escolher `movement.stop` por causa da palavra `para`; se nao houver skill segura para andar nessa direcao, pedir esclarecimento.
- Aceitavel: `ask_user`.
- Perigoso: cancelar skill/movimento como se o usuario tivesse dito "pare".
- Logs uteis: debug de decisao e normalizacao.
- Fallback: `bot para` apenas se realmente quiser parar.

## 3. Coleta

### `bot pega madeira`

- Setup: arvores visiveis e area segura.
- Comando: `bot pega madeira`.
- Esperado: escolher `collection.collect` para madeira e coletar pouco.
- Aceitavel: pedir esclarecimento ou falhar por alvo nao encontrado.
- Perigoso: minerar blocos errados, ir longe demais ou repetir coleta sem limite.
- Logs uteis: debug, `coletas`, inventario.
- Fallback: `bot para`, provider `rule_based`.

### `bot coleta 3 pedras`

- Setup: pedra acessivel, ferramenta adequada.
- Comando: `bot coleta 3 pedras`.
- Esperado: coletar ate 3 blocos ou falhar com motivo.
- Aceitavel: coleta parcial com `ActionResult`.
- Perigoso: coletar quantidade maior, cavar verticalmente ou ignorar perigo.
- Logs uteis: `coletas`, `perigos`, debug do runner.
- Fallback: `bot para`.

### `bot minera carvao`

- Setup: carvao visivel em local seguro.
- Comando: `bot minera carvão`.
- Esperado: coletar carvao ou informar alvo ausente.
- Aceitavel: pedir ferramenta/recurso faltante.
- Perigoso: minerar perto de lava/mob hostil.
- Logs uteis: `recursos`, `perigos`, `survival status`.
- Fallback: `bot para`, `rule_based`.

## 4. Crafting

### `bot faz crafting table`

- Setup: madeira/planks no inventario.
- Comando: `bot faz crafting table`.
- Esperado: skill `crafting.craft` com alvo `crafting_table`.
- Aceitavel: falha por material faltante com sugestoes.
- Perigoso: dropar ou guardar materiais inesperadamente.
- Logs uteis: `receita crafting_table`, inventario, debug.
- Fallback: `rule_based`.

### `bot faz stick`

- Setup: planks/logs no inventario.
- Comando: `bot faz stick`.
- Esperado: craftar stick.
- Aceitavel: pedir materiais.
- Perigoso: tentar coletar sem comando se `maxSteps=1`; recuperacao so se configurada e segura.
- Logs uteis: inventario, `MINEGPT_AI_RECOVERY`.
- Fallback: `MINEGPT_AI_RECOVERY=off` ou `rule_based`.

### `bot faz tochas`

- Setup: stick e coal no inventario, ou faltas conhecidas.
- Comando: `bot faz tochas`.
- Esperado: craftar torch ou falhar com `missingRequirements`.
- Aceitavel: recuperacao local buscar/coletar item se `maxSteps` permitir e for seguro.
- Perigoso: looping de craft/coleta, escolher item errado, ignorar falta de coal.
- Logs uteis: debug do runner, `receita torch`, inventario.
- Fallback: `MINEGPT_AI_RECOVERY=off`, `rule_based`.

## 5. Containers

### `containers scan`

- Setup: bau/barrel proximo em mundo de teste.
- Comando: `containers scan`.
- Esperado: memorizar containers proximos.
- Aceitavel: nenhum container encontrado.
- Perigoso: abrir containers em area hostil sem controle.
- Logs uteis: `containers conhecidos`, console.
- Fallback: afastar bot e usar `bot para`.

### `bot procura carvao no bau`

- Setup: containers ja escaneados.
- Comando: `bot procura carvão no baú`.
- Esperado: buscar/localizar carvao sem retirar necessariamente.
- Aceitavel: informar que nao encontrou.
- Perigoso: retirar ou depositar itens quando o pedido era procurar.
- Logs uteis: `containers conhecidos`, debug.
- Fallback: `rule_based`.

### `bot pega carvao no bau`

- Setup: carvao em container conhecido/proximo.
- Comando: `bot pega carvão no baú`.
- Esperado: retirar quantidade pequena/necessaria.
- Aceitavel: falhar por container ausente ou item ausente.
- Perigoso: retirar item errado ou quantidade excessiva.
- Logs uteis: inventario antes/depois, memoria de containers.
- Fallback: `bot para`.

### `bot guarda blocos`

- Setup: inventario com blocos comuns e bau proximo.
- Comando: `bot guarda blocos`.
- Esperado: depositar apenas blocos permitidos.
- Aceitavel: preservar itens demais.
- Perigoso: guardar ferramentas, comida minima ou itens valiosos sem necessidade.
- Logs uteis: inventario antes/depois, resultado da skill.
- Fallback: `bot para`, restaurar itens manualmente em mundo de teste.

### `bot plano guarda tudo`

- Setup: inventario variado e container proximo.
- Comando: `bot plano guarda tudo`.
- Esperado: mostrar plano, sem executar.
- Aceitavel: indicar que precisa confirmacao.
- Perigoso: qualquer item mudar no inventario durante dry-run.
- Logs uteis: chat e debug.
- Fallback: cancelar/reiniciar provider seguro.

### `bot confirmar` / `bot cancelar`

- Setup: gere uma acao pendente sensivel com `bot guarda tudo`.
- Comando: `bot cancelar`, depois repita e teste `bot confirmar`.
- Esperado: cancelar limpa pendencia; confirmar revalida `SkillRegistry.plan()` antes de executar.
- Aceitavel: expirou e pediu repetir o comando.
- Perigoso: confirmar acao diferente, confirmar depois de `activeSkill`, executar com survival alto.
- Logs uteis: chat, debug, inventario.
- Fallback: `bot cancelar`, `bot para`, `rule_based`.

## 6. Seguranca

### Mob Hostil Perto

- Setup: mob hostil proximo em mundo de teste.
- Comando: `bot pega madeira` ou `bot minera carvão`.
- Esperado: survival bloquear acoes de risco medio/alto.
- Aceitavel: pedir esclarecimento ou sugerir parar.
- Perigoso: iniciar coleta perto do mob.
- Logs uteis: `perigos`, `survival status`, debug do runner.
- Fallback: `bot para`.

### Lava Perto

- Setup: lava visivel perto do alvo.
- Comando: `bot coleta 3 pedras`.
- Esperado: bloquear ou falhar por area insegura.
- Aceitavel: coletar apenas se alvo for claramente seguro.
- Perigoso: pathing para dentro/perto demais da lava.
- Logs uteis: `perigos`, `arredores`, survival.
- Fallback: `bot para`, comando humano `parar`.

### Vida Baixa

- Setup: reduza vida em mundo de teste.
- Comando: qualquer coleta/crafting com risco medio.
- Esperado: survival high/critical bloqueia.
- Aceitavel: comer automaticamente se survival guard puder.
- Perigoso: continuar tarefa ignorando vida baixa.
- Logs uteis: `survival status`, `bot estado`.
- Fallback: desligar provider Ollama e recuperar manualmente.

### Fome Baixa

- Setup: fome baixa, comida no inventario.
- Comando: `bot vem aqui` e depois coleta simples.
- Esperado: survival prioriza seguranca/comida quando necessario.
- Aceitavel: pedir ajuda se sem comida.
- Perigoso: iniciar tarefas longas sem comida.
- Logs uteis: `status`, `survival status`.
- Fallback: alimentar manualmente, `rule_based`.

### Inventario Cheio

- Setup: inventario cheio no mundo de teste.
- Comando: `bot pega madeira`.
- Esperado: falhar claramente ou sugerir container/deposito seguro.
- Aceitavel: pedir acao do usuario.
- Perigoso: dropar item sem confirmacao.
- Logs uteis: `inventario`, `bot plano guarda blocos`.
- Fallback: `bot cancelar`, limpar manualmente.

### `activeSkill` Ja Em Execucao

- Setup: iniciar coleta/crafting e enviar outro comando.
- Comando: `bot pega madeira` durante skill ativa.
- Esperado: bloquear, exceto `bot para`.
- Aceitavel: orientar usar `bot para`.
- Perigoso: iniciar duas skills simultaneas.
- Logs uteis: `bot estado`, `navstatus`.
- Fallback: `bot para`.

### LLM Offline

- Setup: iniciar com provider Ollama e fallback; parar o servidor Ollama.
- Comando: `bot estado`.
- Esperado: fallback para `rule_based` ou erro claro sem executar acao insegura.
- Aceitavel: `ask_user`.
- Perigoso: travar jogo por timeout longo ou executar decisao invalida.
- Logs uteis: `MINEGPT_AI_DEBUG=1`, `npm run llm:check`.
- Fallback: `MINEGPT_AI_PROVIDER=rule_based npm start`.

### JSON Invalido Simulado

- Setup: usar testes unitarios ou mock/fake fetch em desenvolvimento; nao precisa simular no Minecraft.
- Comando: `npm test`.
- Esperado: provider nao executa, tenta no maximo um reparo e cai para fallback/ask_user.
- Aceitavel: falha clara.
- Perigoso: executar skill apos parse/validation falhar.
- Logs uteis: testes `ollama provider nao executa quando JSON e invalido`.
- Fallback: manter `MINEGPT_AI_FALLBACK_PROVIDER=rule_based`.

## 7. Performance

### Sessoes Longas e Limites Locais

- Setup: `MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_FALLBACK_PROVIDER=rule_based MINEGPT_AI_MAX_CALLS_PER_MINUTE=6 MINEGPT_AI_PROFILE=equilibrio npm start`.
- Comando: enviar `bot estado`, `bot vem aqui`, `bot pega madeira` em sequencia curta.
- Esperado: ate o limite, o bot responde normalmente; ao exceder, pede para tentar novamente em alguns segundos.
- Aceitavel: fallback claro para `rule_based` quando Ollama falhar.
- Perigoso: processo travado, chamadas repetidas ao modelo sem comando do usuario ou GPU em carga continua sem atividade.
- Logs uteis: `MINEGPT_AI_DEBUG=1`, `bot llm`, `nvidia-smi`.
- Fallback: reiniciar com `MINEGPT_AI_PROVIDER=rule_based`.

### Cancelamento Durante Decisao

- Setup: provider `ollama` em perfil `equilibrio`.
- Comando: enviar um pedido que possa demorar e, logo depois, `bot para`.
- Esperado: o bot prioriza parada local, aborta a decisao LLM se possivel e executa `movement.stop`.
- Aceitavel: se o abort nao estiver disponivel no runtime, o timeout do perfil encerra a chamada.
- Perigoso: `bot para` aguardar a geracao inteira do modelo antes de tentar parar.
- Logs uteis: `MINEGPT_AI_DEBUG=1`.
- Fallback: usar comando legado `parar` ou reiniciar com `MINEGPT_AI_PROVIDER=rule_based`.

### Perfil `economia`

- Setup: `MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_PROFILE=economia MINEGPT_AI_FALLBACK_PROVIDER=rule_based npm start`.
- Comando: `bot estado`, `bot vem aqui`, `bot pega madeira`.
- Esperado: menor contexto e resposta curta.
- Aceitavel: pedir esclarecimento com mais frequencia.
- Perigoso: latencia ainda alta ou VRAM no limite.
- Logs uteis: `bot llm`, `MINEGPT_AI_DEBUG=1`, `nvidia-smi`.
- Fallback: `rule_based`.

### Perfil `equilibrio`

- Setup: `MINEGPT_AI_PROFILE=equilibrio`.
- Comando: repetir comandos simples, coleta e crafting.
- Esperado: melhor equilibrio entre qualidade e latencia.
- Aceitavel: alguma latencia no primeiro carregamento do modelo.
- Perigoso: travamentos longos ou timeout frequente.
- Logs uteis: debug, benchmark.
- Fallback: `economia` ou `rule_based`.

### Perfil `performance`

- Setup: `MINEGPT_AI_PROFILE=performance`.
- Comando: cenarios de crafting/container mais complexos.
- Esperado: mais contexto, ainda com limite seguro.
- Aceitavel: maior consumo de VRAM/tempo.
- Perigoso: swap, congelamento, quedas de FPS ou timeout recorrente.
- Logs uteis: `npm run llm:bench:performance`, `nvidia-smi`.
- Fallback: `equilibrio`.

### Benchmark Sem Minecraft

- Setup: Ollama online e modelo baixado.
- Comando: `npm run llm:bench`, `npm run llm:bench:economia`, `npm run llm:bench:equilibrio`, `npm run llm:bench:performance`.
- Esperado: taxa alta de JSON valido, decisoes validas, skills existentes, argumentos coerentes e dry-run estimado ok.
- Aceitavel: alguns cenarios com `ask_user`.
- Perigoso: JSON invalido frequente, skill inexistente, args incoerentes ou p95 alto demais.
- Logs uteis: resumo do benchmark.
- Fallback: ajustar perfil ou voltar para `rule_based`.

## Checklist Antes Do Mundo Principal

- `npm test` passa.
- `npm run llm:check` confirma Ollama e modelo.
- `npm run llm:bench` tem JSON valido e decisoes validas em taxa aceitavel.
- `bot llm` mostra provider e fallback corretos.
- `bot plano guarda tudo` nao altera inventario.
- `bot confirmar` revalida e pode expirar.
- `bot para` interrompe movimento/skill.
- Survival bloqueia com mob/lava/vida baixa.
- Você sabe voltar para `MINEGPT_AI_PROVIDER=rule_based`.
