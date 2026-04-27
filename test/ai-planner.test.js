const test = require('node:test')
const assert = require('node:assert/strict')
const { createSkillRegistry } = require('../skills')
const { actionOk, actionFail } = require('../action-result')
const {
  decideNextAction,
  DEFAULT_PROVIDER,
  DEFAULT_LLM_PROFILE,
  getLocalLlmProfile,
  getPlannerProvider,
  makePlannerDecision,
  runPlannerCycles,
  validatePlannerDecision,
  plannerDecisionJsonSchema,
  buildPlannerPromptPayload,
  compactPlannerStateForLlm,
  compactSkillsForLlm,
  compactHistoryForLlm,
  createAiRateLimiter,
  configuredRecoveryMode,
  skillsToPlannerTools,
  skillRegistryToPlannerTools
} = require('../ai')
const { requestOllamaChat } = require('../ai/providers/ollama-provider')
const {
  parseBotCommand,
  parsePlannerControlCommand,
  parsePlannerDiagnosticCommand,
  runPlannerCommand,
  survivalBlocksPlan
} = require('../ai/planner-executor')

function plannerTools () {
  return [
    { id: 'movement.stop', description: 'parar', inputSchema: {}, risk: 'low', effects: ['movement'], cost: { base: 1 }, plannerHints: '' },
    { id: 'movement.come_here', description: 'vem aqui', inputSchema: {}, risk: 'low', effects: ['position'], cost: { base: 2 }, plannerHints: '' },
    { id: 'movement.follow_owner', description: 'seguir', inputSchema: {}, risk: 'low', effects: ['position'], cost: { base: 2 }, plannerHints: '' },
    { id: 'state.snapshot', description: 'estado', inputSchema: {}, risk: 'low', effects: [], cost: { base: 1 }, plannerHints: '' },
    { id: 'collection.collect', description: 'coletar', inputSchema: { target: 'string', count: 'number optional' }, risk: 'medium', effects: ['world', 'inventory'], cost: { base: 5 }, plannerHints: '' },
    { id: 'drops.collect', description: 'drops', inputSchema: { target: 'string optional' }, risk: 'low', effects: ['inventory'], cost: { base: 3 }, plannerHints: '' },
    { id: 'crafting.craft', description: 'craftar', inputSchema: { target: 'string', count: 'number optional' }, risk: 'medium', effects: ['inventory'], cost: { base: 4 }, plannerHints: '' },
    { id: 'containers.search', description: 'procurar container', inputSchema: { target: 'string' }, risk: 'low', effects: ['containerMemory'], cost: { base: 3 }, plannerHints: '' },
    { id: 'containers.deposit', description: 'guardar container', inputSchema: { mode: 'target|all|resources|blocks|drops', target: 'string optional', count: 'number optional' }, risk: 'medium', effects: ['inventory'], cost: { base: 5 }, plannerHints: '' }
  ]
}

function plannerExecuteDecision (skill, args = {}, options = {}) {
  return makePlannerDecision({
    intent: 'execute_skill',
    userGoal: options.userGoal || 'teste',
    nextAction: { skill, args },
    reasonSummary: options.reasonSummary || 'teste',
    risk: options.risk || 'low',
    confidence: options.confidence ?? 0.9,
    stopAfterThis: options.stopAfterThis ?? true
  })
}

function plannerAskDecision (askUser = 'Pode esclarecer?') {
  return makePlannerDecision({
    intent: 'ask_user',
    userGoal: 'teste',
    nextAction: null,
    reasonSummary: 'precisa esclarecer',
    askUser,
    risk: 'low',
    confidence: 0.5,
    stopAfterThis: true
  })
}

function plannerRefuseDecision (reasonSummary = 'pedido recusado') {
  return makePlannerDecision({
    intent: 'refuse',
    userGoal: 'teste',
    nextAction: null,
    reasonSummary,
    risk: 'low',
    confidence: 0.8,
    stopAfterThis: true
  })
}

function createRunnerContext ({ planOk = true, executeOk = true, retryable = false, onRun = () => {} } = {}) {
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'demo.skill',
    description: 'demo',
    inputSchema: { step: 'number optional' },
    risk: 'low',
    run: (args) => {
      onRun(args)
      return executeOk
        ? actionOk('demo.skill', 'demo ok')
        : actionFail('demo.skill', 'demo fail', {}, Date.now(), { code: 'demo_failed', retryable })
    }
  })

  if (!planOk) {
    registry.plan = async (skill) => ({
      ok: false,
      skill,
      code: 'precondition_failed',
      reason: 'plan falhou',
      missingRequirements: [],
      suggestedNextActions: []
    })
  }

  return {
    skillRegistry: registry,
    stateReporter: { getPlannerSnapshot: () => ({ online: true, activeSkill: null }) },
    activeSkill: null
  }
}

test('planner mockado escolhe uma unica skill para comandos conhecidos', async () => {
  const skills = plannerTools()

  const stop = await decideNextAction({ userMessage: 'bot parar agora', plannerState: {}, skills, history: [], config: { ai: { provider: 'mock' } } })
  assert.equal(stop.intent, 'execute_skill')
  assert.equal(stop.nextAction.skill, 'movement.stop')
  assert.deepEqual(Object.keys(stop.nextAction), ['skill', 'args'])
  assert.equal(Array.isArray(stop.nextAction), false)
  assert.equal(stop.stopAfterThis, true)

  const comeHere = await decideNextAction({ userMessage: 'vem aqui', plannerState: {}, skills, config: { ai: { provider: 'mock' } } })
  assert.equal(comeHere.nextAction.skill, 'movement.come_here')

  const follow = await decideNextAction({ userMessage: 'seguir', plannerState: {}, skills, config: { ai: { provider: 'mock' } } })
  assert.equal(follow.nextAction.skill, 'movement.follow_owner')

  const state = await decideNextAction({ userMessage: 'estado', plannerState: {}, skills, config: { ai: { provider: 'mock' } } })
  assert.equal(state.nextAction.skill, 'state.snapshot')
})

test('planner mockado mapeia alvos simples para skills com args', async () => {
  const skills = plannerTools()

  const wood = await decideNextAction({ userMessage: 'pega madeira', plannerState: {}, skills, config: { ai: { provider: 'mock' } } })
  assert.equal(wood.intent, 'execute_skill')
  assert.equal(wood.nextAction.skill, 'collection.collect')
  assert.deepEqual(wood.nextAction.args, { target: 'madeira', count: 1 })
  assert.equal(wood.risk, 'medium')

  const table = await decideNextAction({ userMessage: 'faz uma crafting table', plannerState: {}, skills, config: { ai: { provider: 'mock' } } })
  assert.equal(table.intent, 'execute_skill')
  assert.equal(table.nextAction.skill, 'crafting.craft')
  assert.deepEqual(table.nextAction.args, { target: 'crafting_table', count: 1 })
})

test('planner mockado pergunta quando nao entende ou skill nao esta disponivel', async () => {
  const unknown = await decideNextAction({ userMessage: 'organize minha base inteira', plannerState: {}, skills: plannerTools(), config: { ai: { provider: 'mock' } } })
  assert.equal(unknown.intent, 'ask_user')
  assert.equal(unknown.nextAction, null)
  assert.match(unknown.askUser, /Nao entendi/)

  const unavailable = await decideNextAction({
    userMessage: 'vem aqui',
    plannerState: {},
    skills: plannerTools().filter(skill => skill.id !== 'movement.come_here'),
    config: { ai: { provider: 'mock' } }
  })
  assert.equal(unavailable.intent, 'ask_user')
  assert.equal(unavailable.nextAction, null)
  assert.match(unavailable.askUser, /nao esta disponivel/)

  const empty = await decideNextAction({ userMessage: '', plannerState: {}, skills: plannerTools(), config: { ai: { provider: 'mock' } } })
  assert.equal(empty.intent, 'ask_user')
  assert.equal(empty.userGoal, 'comando vazio')
  assert.match(empty.askUser, /O que voce quer/)
})

test('provider resolver usa rule_based como padrao e aceita env/config', () => {
  assert.equal(DEFAULT_PROVIDER, 'rule_based')
  assert.equal(getPlannerProvider({}, {}).name, 'rule_based')
  assert.equal(getPlannerProvider({ ai: { provider: 'mock' } }, {}).name, 'mock')
  assert.equal(getPlannerProvider({ ai: { provider: 'mock' } }, { MINEGPT_AI_PROVIDER: 'ollama' }).name, 'ollama')
})

test('provider invalido cai para mock com motivo claro', () => {
  const provider = getPlannerProvider({}, { MINEGPT_AI_PROVIDER: 'desconhecido' })
  assert.equal(provider.name, 'mock')
  assert.equal(provider.requestedName, 'desconhecido')
  assert.match(provider.fallbackReason, /provider desconhecido/)
})

test('perfis locais usam equilibrio como padrao e limites seguros', () => {
  const profile = getLocalLlmProfile({}, {})
  assert.equal(DEFAULT_LLM_PROFILE, 'equilibrio')
  assert.equal(profile.name, 'equilibrio')
  assert.equal(profile.numCtx, 4096)
  assert.equal(profile.maxOutputTokens, 256)
  assert.equal(profile.timeoutMs, 20000)
  assert.equal(profile.maxSteps, 1)
})

test('perfis locais aceitam aliases e perfil invalido cai para equilibrio', () => {
  assert.equal(getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: 'economia' }).name, 'economia')
  assert.equal(getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: 'equilibrio' }).name, 'equilibrio')
  assert.equal(getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: 'performance' }).name, 'performance')
  assert.equal(getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: 'desempenho' }).name, 'performance')
  assert.equal(getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: 'balanced' }).name, 'equilibrio')

  const invalid = getLocalLlmProfile({}, { MINEGPT_AI_PROFILE: '128k-insano' })
  assert.equal(invalid.name, 'equilibrio')
  assert.match(invalid.fallbackReason, /perfil desconhecido/)
})

test('perfis locais limitam contexto, saida e maxSteps mesmo com env exagerada', () => {
  const profile = getLocalLlmProfile({}, {
    MINEGPT_AI_PROFILE: 'performance',
    MINEGPT_AI_NUM_CTX: '131072',
    MINEGPT_AI_MAX_OUTPUT_TOKENS: '4096',
    MINEGPT_AI_MAX_STEPS: '5',
    MINEGPT_AI_MODEL: 'qwen2.5:14b'
  })

  assert.equal(profile.name, 'performance')
  assert.equal(profile.model, 'qwen2.5:14b')
  assert.equal(profile.numCtx, 8192)
  assert.equal(profile.maxOutputTokens, 384)
  assert.equal(profile.maxSteps, 1)
})

test('diagnostico bot llm mostra provider e perfil atuais sem executar skill', async () => {
  const response = await runPlannerCommand({
    userMessage: 'llm',
    context: {
      config: {
        ai: {
          provider: 'ollama',
          profile: 'economia',
          ollama: { model: 'qwen2.5:14b' }
        }
      }
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    diagnosticFetch: async () => ({ ok: true, status: 200 })
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 'llm_diagnostic')
  assert.match(response.chat, /provider=ollama/)
  assert.match(response.chat, /fallback=nenhum/)
  assert.match(response.chat, /perfil=economia/)
  assert.match(response.chat, /modelo=qwen2.5:14b/)
  assert.match(response.chat, /num_ctx=2048/)
  assert.match(response.chat, /url=http:\/\/localhost:11434/)
  assert.match(response.chat, /ollama=online/)
})

test('diagnostico bot perfil e provider consulta sem mudar runtime', async () => {
  assert.deepEqual(parsePlannerDiagnosticCommand('perfil performance'), { kind: 'set_profile', value: 'performance' })
  assert.deepEqual(parsePlannerDiagnosticCommand('provider rule_based'), { kind: 'set_provider', value: 'rule_based' })

  const profile = await runPlannerCommand({
    userMessage: 'perfil',
    context: { config: { ai: { profile: 'performance' } } },
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.equal(profile.status, 'llm_diagnostic')
  assert.match(profile.chat, /perfil=performance/)
  assert.match(profile.chat, /num_ctx=8192/)

  const provider = await runPlannerCommand({
    userMessage: 'provider',
    context: { config: { ai: { provider: 'rule_based', fallbackProvider: 'mock' } } },
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.match(provider.chat, /provider=rule_based/)
  assert.match(provider.chat, /fallback=mock/)
})

test('diagnostico recusa mudanca de perfil/provider em runtime com validacao', async () => {
  const validProfile = await runPlannerCommand({
    userMessage: 'perfil economia',
    context: {},
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.match(validProfile.chat, /MINEGPT_AI_PROFILE=economia/)
  assert.match(validProfile.chat, /desativada por seguranca/)

  const invalidProfile = await runPlannerCommand({
    userMessage: 'perfil turbo',
    context: {},
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.match(invalidProfile.chat, /perfil desconhecido/)

  const validProvider = await runPlannerCommand({
    userMessage: 'provider ollama',
    context: {},
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.match(validProvider.chat, /MINEGPT_AI_PROVIDER=ollama/)

  const invalidProvider = await runPlannerCommand({
    userMessage: 'provider externo',
    context: {},
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })
  assert.match(invalidProvider.chat, /provider desconhecido/)
})

test('ollama offline sem fallback retorna erro claro sem executar nada', async () => {
  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: {},
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    }
  })

  assert.equal(decision.intent, 'ask_user')
  assert.match(decision.askUser, /Provider ollama indisponivel/)
  assert.equal(decision.planner.mode, 'ollama')
})

test('rule_based cobre comandos naturais basicos', async () => {
  const skills = plannerTools()
  const cases = [
    ['vem aqui', 'movement.come_here', {}],
    ['venha', 'movement.come_here', {}],
    ['me segue', 'movement.follow_owner', {}],
    ['para', 'movement.stop', {}],
    ['pare', 'movement.stop', {}],
    ['estado', 'state.snapshot', {}],
    ['status', 'state.snapshot', {}],
    ['pega madeira', 'collection.collect', { target: 'madeira', count: 1 }],
    ['coleta madeira', 'collection.collect', { target: 'madeira', count: 1 }],
    ['coleta 3 pedras', 'collection.collect', { target: 'pedra', count: 3 }],
    ['minera carvao', 'collection.collect', { target: 'carvao', count: 1 }],
    ['faz crafting table', 'crafting.craft', { target: 'crafting_table', count: 1 }],
    ['crafta mesa de trabalho', 'crafting.craft', { target: 'crafting_table', count: 1 }],
    ['faz tochas', 'crafting.craft', { target: 'torch', count: 1 }],
    ['pega drops', 'drops.collect', {}],
    ['procura carvao no bau', 'containers.search', { target: 'carvao' }],
    ['busca carvao no container', 'containers.search', { target: 'carvao' }],
    ['guarda blocos', 'containers.deposit', { mode: 'blocks' }],
    ['guarda recursos', 'containers.deposit', { mode: 'resources' }],
    ['guarda drops', 'containers.deposit', { mode: 'drops' }],
    ['guarda tudo', 'containers.deposit', { mode: 'all' }]
  ]

  for (const [userMessage, skill, args] of cases) {
    const decision = await decideNextAction({
      userMessage,
      plannerState: {},
      skills,
      config: { ai: { provider: 'rule_based' } }
    })
    assert.equal(decision.intent, 'execute_skill', userMessage)
    assert.equal(decision.nextAction.skill, skill, userMessage)
    assert.deepEqual(decision.nextAction.args, args, userMessage)
    assert.equal(decision.validation.ok, true, userMessage)
    assert.equal(decision.planner.mode, 'rule_based')
  }
})

test('rule_based pergunta em ambiguidade e quando skill nao existe', async () => {
  const ambiguous = await decideNextAction({
    userMessage: 'coleta',
    plannerState: {},
    skills: plannerTools(),
    config: { ai: { provider: 'rule_based' } }
  })
  assert.equal(ambiguous.intent, 'ask_user')
  assert.match(ambiguous.askUser, /Qual recurso/)

  const unavailable = await decideNextAction({
    userMessage: 'pega drops',
    plannerState: {},
    skills: plannerTools().filter(skill => skill.id !== 'drops.collect'),
    config: { ai: { provider: 'rule_based' } }
  })
  assert.equal(unavailable.intent, 'ask_user')
  assert.match(unavailable.askUser, /nao esta disponivel/)
})

test('schema rejeita skill inexistente e nextAction invalido', () => {
  const skills = plannerTools()
  const nonexistent = makePlannerDecision({
    intent: 'execute_skill',
    userGoal: 'teste',
    nextAction: { skill: 'missing.skill', args: {} },
    reasonSummary: 'teste',
    confidence: 0.5
  })
  const missingResult = validatePlannerDecision(nonexistent, { skills })
  assert.equal(missingResult.ok, false)
  assert.match(missingResult.errors.join('; '), /skill inexistente/)

  const invalidAsk = makePlannerDecision({
    intent: 'ask_user',
    userGoal: 'teste',
    nextAction: { skill: 'movement.stop', args: {} },
    reasonSummary: 'teste',
    askUser: 'confirmar?',
    confidence: 0.5
  })
  const invalidAskResult = validatePlannerDecision(invalidAsk, { skills })
  assert.equal(invalidAskResult.ok, false)
  assert.match(invalidAskResult.errors.join('; '), /nextAction deve ser null/)

  const invalidArgs = makePlannerDecision({
    intent: 'execute_skill',
    userGoal: 'teste',
    nextAction: { skill: 'movement.stop', args: [] },
    reasonSummary: 'teste',
    confidence: 0.5
  })
  const invalidArgsResult = validatePlannerDecision(invalidArgs, { skills })
  assert.equal(invalidArgsResult.ok, false)
  assert.match(invalidArgsResult.errors.join('; '), /args deve ser objeto/)
})

test('schema de planner decision expoe JSON Schema com skills registradas', () => {
  const schema = plannerDecisionJsonSchema(plannerTools())
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties.intent.enum, ['execute_skill', 'ask_user', 'refuse', 'stop'])
  assert(schema.properties.nextAction.anyOf[1].properties.skill.enum.includes('movement.stop'))
})

test('ollama provider aceita decisao valida usando fetch mockado', async () => {
  const calls = []
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify(makePlannerDecision({
            intent: 'execute_skill',
            userGoal: 'estado',
            nextAction: { skill: 'state.snapshot', args: {} },
            reasonSummary: 'Usuario pediu estado.',
            risk: 'low',
            confidence: 0.9,
            stopAfterThis: true
          }))
        }
      })
    }
  }

  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama', profile: 'economia' } },
    fetch: fakeFetch
  })

  assert.equal(decision.intent, 'execute_skill')
  assert.equal(decision.nextAction.skill, 'state.snapshot')
  assert.equal(decision.planner.mode, 'ollama')
  assert.equal(decision.planner.profile, 'economia')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.stream, false)
  assert.equal(calls[0].body.options.num_ctx, 2048)
  assert.equal(calls[0].body.options.num_predict, 160)
  assert.equal(calls[0].body.format.type, 'object')
  assert(calls[0].body.messages[1].content.includes('Estado JSON'))
})

test('payload do planner para LLM e JSON serializavel e remove funcoes', () => {
  const circular = { online: true }
  circular.self = circular
  circular.fn = () => 'nao enviar'
  circular.inventory = {
    items: Array.from({ length: 40 }, (_, index) => ({ name: `item_${index}`, count: index + 1, fn: () => {} })),
    focus: {
      tools: [{ name: 'iron_pickaxe', count: 1 }],
      food: [{ name: 'bread', count: 3 }],
      basicBlocks: [{ name: 'cobblestone', count: 32 }],
      resources: [{ name: 'coal', count: 8 }],
      hasFreeSlot: true
    }
  }
  circular.perception = {
    topAttention: Array.from({ length: 20 }, (_, index) => ({ kind: 'block', name: `token_${index}`, score: 100 - index, position: { x: index, y: 64, z: 0 }, blocks: Array(50).fill({ x: 1 }) })),
    hazards: Array.from({ length: 10 }, (_, index) => ({ kind: 'entity', name: `zombie_${index}`, score: 90 })),
    resources: Array.from({ length: 10 }, (_, index) => ({ kind: 'block', name: `coal_${index}`, score: 70 })),
    drops: Array.from({ length: 10 }, (_, index) => ({ kind: 'drop', name: `drop_${index}`, score: 50 })),
    containers: Array.from({ length: 10 }, (_, index) => ({ kind: 'container', name: `chest_${index}`, score: 40 }))
  }

  const payload = buildPlannerPromptPayload({
    userMessage: 'pega coal',
    plannerState: circular,
    skills: [{ id: 'demo', description: 'x'.repeat(400), inputSchema: {}, risk: 'low', plannerHints: 'h'.repeat(400), run: () => {} }],
    history: [{ step: 1, status: 'execute_failed', reason: 'r'.repeat(400), result: { missingRequirements: Array(10).fill({ type: 'item', name: 'coal' }) } }],
    schema: plannerDecisionJsonSchema(plannerTools()),
    profile: { name: 'equilibrio', model: 'qwen2.5:14b-instruct' }
  })

  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes('function'), false)
  assert.equal(payload.plannerState.inventory.items.length <= 16, true)
  assert.equal(payload.plannerState.perception.topAttention.length, 5)
  assert.equal(payload.plannerState.perception.hazards.length, 3)
  assert.equal(payload.plannerState.perception.resources.length, 4)
  assert.equal(payload.plannerState.perception.drops.length, 3)
  assert.equal(payload.plannerState.perception.containers.length, 3)
  assert.equal(payload.skills[0].run, undefined)
  assert.equal(payload.history[0].result.missingRequirements.length, 3)
})

test('compactadores do LLM preservam itens mencionados e historico recente', () => {
  const state = {
    online: true,
    canAct: true,
    inventory: {
      items: [
        { name: 'dirt', count: 64 },
        { name: 'oak_log', count: 3 },
        { name: 'diamond', count: 1 }
      ],
      focus: {
        tools: [],
        food: [],
        basicBlocks: [],
        resources: [],
        hasFreeSlot: false
      }
    }
  }
  const compactState = compactPlannerStateForLlm(state, { userMessage: 'usa diamond' })
  assert.equal(compactState.inventory.items[0].name, 'diamond')

  const compactSkills = compactSkillsForLlm([{ id: 'x', description: 'ok', inputSchema: {}, risk: 'low', plannerHints: 'hint', run: () => {} }])
  assert.deepEqual(Object.keys(compactSkills[0]), ['id', 'description', 'inputSchema', 'risk', 'plannerHints'])

  const compactHistory = compactHistoryForLlm(Array.from({ length: 8 }, (_, index) => ({
    step: index,
    status: 'execute_failed',
    reason: `falha ${index}`,
    result: {
      missingRequirements: [{ type: 'item', name: 'coal' }],
      suggestedNextActions: [{ type: 'skill', skill: 'containers.search', args: { target: 'coal' } }],
      data: { stack: 'nao enviar' }
    }
  })))
  assert.equal(compactHistory.length, 5)
  assert.equal(compactHistory[0].step, 3)
  assert.equal('data' in compactHistory[0].result, false)
})

test('ollama provider nao executa quando JSON e invalido', async () => {
  let runs = 0
  let calls = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'state.snapshot',
    description: 'estado',
    requires: ['botOnline'],
    run: () => {
      runs++
      return actionOk('state.snapshot', 'estado')
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'estado',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null,
      config: { ai: { provider: 'ollama' } }
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: args => decideNextAction({
      ...args,
      fetch: async () => {
        calls++
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: { content: 'nao sou json' } })
        }
      }
    })
  })

  assert.equal(response.status, 'ask_user')
  assert.match(response.reason, /Provider ollama indisponivel|decisao invalida/i)
  assert.equal(runs, 0)
  assert.equal(calls, 2)
})

test('ollama provider rejeita texto antes do JSON e usa retry curto', async () => {
  const valid = JSON.stringify(makePlannerDecision({
    intent: 'execute_skill',
    userGoal: 'estado',
    nextAction: { skill: 'state.snapshot', args: {} },
    reasonSummary: 'Usuario pediu estado.',
    risk: 'low',
    confidence: 0.9,
    stopAfterThis: true
  }))
  const calls = []
  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            content: calls.length === 1 ? `texto antes ${valid}` : valid
          }
        })
      }
    }
  })

  assert.equal(decision.intent, 'execute_skill')
  assert.equal(decision.nextAction.skill, 'state.snapshot')
  assert.equal(calls.length, 2)
  assert.match(calls[1].messages.at(-1).content, /somente JSON valido/)
})

test('ollama provider rejeita args invalido sem executar', async () => {
  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify(makePlannerDecision({
            intent: 'execute_skill',
            userGoal: 'estado',
            nextAction: { skill: 'state.snapshot', args: [] },
            reasonSummary: 'Usuario pediu estado.',
            risk: 'low',
            confidence: 0.9,
            stopAfterThis: true
          }))
        }
      })
    })
  })

  assert.equal(decision.intent, 'ask_user')
  assert.match(decision.askUser, /Provider ollama indisponivel|decisao valida/i)
})

test('ollama provider trata resposta vazia e timeout sem executar', async () => {
  const empty = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '' } })
    })
  })
  assert.equal(empty.intent, 'ask_user')

  const timedOut = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async () => {
      const error = new Error('abortado')
      error.name = 'AbortError'
      throw error
    }
  })
  assert.equal(timedOut.intent, 'ask_user')
  assert.match(timedOut.askUser, /timeout|Provider ollama indisponivel/i)
})

test('ollama JSON invalido repetido cai para fallback configurado', async () => {
  let calls = 0
  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama', fallbackProvider: 'rule_based' } },
    fetch: async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: 'nao sou json' } })
      }
    }
  })

  assert.equal(decision.intent, 'execute_skill')
  assert.equal(decision.nextAction.skill, 'state.snapshot')
  assert.equal(decision.planner.mode, 'rule_based')
  assert.match(decision.planner.providerFallback, /ollama falhou/)
  assert.equal(calls, 2)
})

test('ollama provider nao executa skill inventada', async () => {
  const decision = await decideNextAction({
    userMessage: 'use comando direto',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama' } },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify(makePlannerDecision({
            intent: 'execute_skill',
            userGoal: 'use comando direto',
            nextAction: { skill: 'minecraft.raw_command', args: { command: '/kill @e' } },
            reasonSummary: 'Usar comando direto.',
            risk: 'high',
            confidence: 0.9,
            stopAfterThis: true
          }))
        }
      })
    })
  })

  assert.equal(decision.intent, 'ask_user')
  assert.match(decision.askUser, /Provider ollama indisponivel|decisao invalida/i)
})

test('ollama offline cai para fallback configurado', async () => {
  const decision = await decideNextAction({
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama', fallbackProvider: 'rule_based' } },
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    }
  })

  assert.equal(decision.intent, 'execute_skill')
  assert.equal(decision.nextAction.skill, 'state.snapshot')
  assert.equal(decision.planner.mode, 'rule_based')
  assert.match(decision.planner.providerFallback, /ollama falhou/)
})

test('rate limit local limita chamadas ao Ollama por minuto sem cair para fallback', async () => {
  let now = 1000
  let calls = 0
  const limiter = createAiRateLimiter({ now: () => now })
  const validStateDecision = JSON.stringify(makePlannerDecision({
    intent: 'execute_skill',
    userGoal: 'estado',
    nextAction: { skill: 'state.snapshot', args: {} },
    reasonSummary: 'Usuario pediu estado.',
    risk: 'low',
    confidence: 0.9,
    stopAfterThis: true
  }))
  const fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: validStateDecision } })
    }
  }
  const baseArgs = {
    userMessage: 'estado',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama', fallbackProvider: 'rule_based' } },
    env: { MINEGPT_AI_MAX_CALLS_PER_MINUTE: '1' },
    fetch,
    rateLimiter: limiter
  }

  const first = await decideNextAction(baseArgs)
  const second = await decideNextAction(baseArgs)
  now += 60001
  const third = await decideNextAction(baseArgs)

  assert.equal(first.intent, 'execute_skill')
  assert.equal(second.intent, 'ask_user')
  assert.match(second.askUser, /comandos rapido demais/)
  assert.equal(second.planner.mode, 'ollama')
  assert.equal(third.intent, 'execute_skill')
  assert.equal(calls, 2)
})

test('requestOllamaChat aplica timeout por chamada', async () => {
  await assert.rejects(
    requestOllamaChat({
      profile: {
        model: 'qwen2.5:14b-instruct',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 5,
        keepAlive: '30s',
        temperature: 0,
        numCtx: 2048,
        maxOutputTokens: 160
      },
      messages: [],
      schema: { type: 'object' },
      fetch: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('abortado')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }),
    error => error.code === 'timeout'
  )
})

test('AbortController cancela chamada Ollama sem acionar fallback', async () => {
  const controller = new globalThis.AbortController()
  let calls = 0
  const decisionPromise = decideNextAction({
    userMessage: 'pega madeira',
    plannerState: { online: true },
    skills: plannerTools(),
    config: { ai: { provider: 'ollama', fallbackProvider: 'rule_based' } },
    signal: controller.signal,
    fetch: async (url, options) => {
      calls++
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('abortado')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
    rateLimiter: createAiRateLimiter({ now: () => 1000 })
  })

  controller.abort()
  const decision = await decisionPromise

  assert.equal(calls, 1)
  assert.equal(decision.intent, 'ask_user')
  assert.match(decision.askUser, /cancelada/)
  assert.equal(decision.planner.mode, 'ollama')
  assert.equal(decision.planner.providerFallback, 'cancelado')
})

test('tool adapter remove funcoes e contexto interno das skills', () => {
  const registry = createSkillRegistry()
  registry.register({
    id: 'demo.skill',
    description: 'demo',
    inputSchema: { target: 'string' },
    risk: 'medium',
    effects: ['inventory'],
    cost: { base: 2 },
    plannerHints: 'hint',
    run: () => actionOk('demo.skill')
  })

  const tools = skillRegistryToPlannerTools(registry)
  assert.deepEqual(tools, [{
    id: 'demo.skill',
    description: 'demo',
    inputSchema: { target: 'string' },
    risk: 'medium',
    effects: ['inventory'],
    cost: { base: 2 },
    plannerHints: 'hint'
  }])
  assert.equal('run' in tools[0], false)

  const fromList = skillsToPlannerTools([{ id: 'x', run: () => {}, context: { secret: true }, inputSchema: {} }])
  assert.equal(fromList[0].id, 'x')
  assert.equal('run' in fromList[0], false)
  assert.equal('context' in fromList[0], false)
})

test('parser do prefixo bot aceita somente comando oficial', () => {
  assert.equal(parseBotCommand('bot vem aqui'), 'vem aqui')
  assert.equal(parseBotCommand('BOT estado'), 'estado')
  assert.equal(parseBotCommand('bot'), '')
  assert.equal(parseBotCommand('ia vem aqui'), null)
  assert.equal(parseBotCommand('mente vem aqui'), null)
  assert.deepEqual(parsePlannerControlCommand('plano pega madeira'), { kind: 'dry_run', userMessage: 'pega madeira' })
  assert.deepEqual(parsePlannerControlCommand('para'), { kind: 'stop' })
  assert.deepEqual(parsePlannerControlCommand('confirmar'), { kind: 'confirm' })
  assert.deepEqual(parsePlannerControlCommand('cancelar'), { kind: 'cancel' })
})

test('executor do planner chama plan antes de execute e responde resultado curto', async () => {
  const calls = []
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'movement.stop',
    description: 'parar',
    requires: ['botOnline'],
    run: () => {
      calls.push('run')
      return actionOk('movement.stop', 'movimento parado')
    }
  })
  const originalPlan = registry.plan
  const originalExecute = registry.execute
  registry.plan = async (skill, args, context) => {
    calls.push('plan')
    return originalPlan(skill, args, context)
  }
  registry.execute = async (skill, args, context) => {
    calls.push('execute')
    return originalExecute(skill, args, context)
  }

  const response = await runPlannerCommand({
    userMessage: 'parar',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: { name: 'coletar' }
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })

  assert.equal(response.ok, true)
  assert.match(response.chat, /Bot: feito/)
  assert.deepEqual(calls, ['plan', 'execute', 'run'])
})

test('bot para aborta decisao pendente e executa movement.stop localmente', async () => {
  let aborted = false
  let runs = 0
  const controller = new globalThis.AbortController()
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'movement.stop',
    description: 'parar',
    risk: 'low',
    run: () => {
      runs++
      return actionOk('movement.stop', 'movimento parado')
    }
  })
  controller.signal.addEventListener('abort', () => {
    aborted = true
  })

  const response = await runPlannerCommand({
    userMessage: 'para',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: { name: 'coletar' },
      plannerDecisionAbortController: controller
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => {
      throw new Error('nao deveria chamar planner externo')
    }
  })

  assert.equal(aborted, true)
  assert.equal(response.status, 'completed')
  assert.equal(runs, 1)
  assert.match(response.chat, /movimento parado/)
})

test('bot plano faz dry-run sem executar skill', async () => {
  let runs = 0
  let plans = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'demo.skill',
    description: 'demo',
    inputSchema: { target: 'string optional' },
    risk: 'low',
    run: () => {
      runs++
      return actionOk('demo.skill', 'executado')
    }
  })
  const originalPlan = registry.plan
  registry.plan = async (skill, args, context) => {
    plans++
    return originalPlan(skill, args, context)
  }

  const response = await runPlannerCommand({
    userMessage: 'plano pega madeira',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('demo.skill', { target: 'oak_log' })
  })

  assert.equal(response.status, 'dry_run')
  assert.equal(response.ok, true)
  assert.equal(plans, 1)
  assert.equal(runs, 0)
  assert.match(response.chat, /Nada foi executado/)
})

test('acao sensivel exige confirmacao e confirmar revalida plan antes de executar', async () => {
  let runs = 0
  let plans = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'containers.deposit',
    description: 'guardar',
    inputSchema: { mode: 'target|all|resources|blocks|drops' },
    risk: 'medium',
    run: () => {
      runs++
      return actionOk('containers.deposit', 'guardado')
    }
  })
  const originalPlan = registry.plan
  registry.plan = async (skill, args, context) => {
    plans++
    return originalPlan(skill, args, context)
  }
  const context = {
    skillRegistry: registry,
    stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
    activeSkill: null
  }

  const pending = await runPlannerCommand({
    userMessage: 'guarda tudo',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('containers.deposit', { mode: 'all' }),
    now: 1000
  })

  assert.equal(pending.status, 'confirmation_required')
  assert.equal(runs, 0)
  assert.equal(Boolean(context.plannerPendingConfirmation), true)
  assert.match(pending.chat, /bot confirmar/)
  assert.match(pending.chat, /pode mexer em muitos itens/)

  const confirmed = await runPlannerCommand({
    userMessage: 'confirmar',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    now: 2000
  })

  assert.equal(confirmed.status, 'completed')
  assert.equal(runs, 1)
  assert.equal(plans >= 2, true)
  assert.equal(context.plannerPendingConfirmation, null)
})

test('confirmacao expira e nao executa acao pendente', async () => {
  let runs = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'inventory.drop',
    description: 'drop',
    inputSchema: { item: 'string' },
    risk: 'medium',
    run: () => {
      runs++
      return actionOk('inventory.drop', 'dropado')
    }
  })
  const context = {
    skillRegistry: registry,
    stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
    activeSkill: null
  }

  await runPlannerCommand({
    userMessage: 'drop diamond',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('inventory.drop', { item: 'diamond' }),
    now: 1000,
    confirmationTtlMs: 10
  })

  const expired = await runPlannerCommand({
    userMessage: 'confirmar',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    now: 2000
  })

  assert.equal(expired.status, 'confirmation_expired')
  assert.equal(runs, 0)
  assert.equal(context.plannerPendingConfirmation, null)
})

test('confirmacao bloqueia activeSkill antes de executar pendencia', async () => {
  let runs = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'inventory.drop',
    description: 'drop',
    inputSchema: { item: 'string' },
    risk: 'medium',
    run: () => {
      runs++
      return actionOk('inventory.drop', 'dropado')
    }
  })
  const context = {
    skillRegistry: registry,
    stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
    activeSkill: null
  }

  await runPlannerCommand({
    userMessage: 'drop diamond',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('inventory.drop', { item: 'diamond' }),
    now: 1000
  })
  context.activeSkill = { name: 'coletar' }

  const blocked = await runPlannerCommand({
    userMessage: 'confirmar',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    now: 2000
  })

  assert.equal(blocked.status, 'active_skill_blocked')
  assert.equal(runs, 0)
  assert.equal(context.plannerPendingConfirmation, null)
})

test('confirmacao revalida plan e bloqueia quando estado muda', async () => {
  let runs = 0
  let plans = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'inventory.drop',
    description: 'drop',
    inputSchema: { item: 'string' },
    risk: 'medium',
    run: () => {
      runs++
      return actionOk('inventory.drop', 'dropado')
    }
  })
  const originalPlan = registry.plan
  registry.plan = async (skill, args, context) => {
    plans++
    if (plans >= 2) {
      return {
        ok: false,
        skill,
        code: 'state_changed',
        reason: 'estado mudou',
        args,
        missingRequirements: [],
        suggestedNextActions: []
      }
    }
    return originalPlan(skill, args, context)
  }
  const context = {
    skillRegistry: registry,
    stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
    activeSkill: null
  }

  await runPlannerCommand({
    userMessage: 'drop diamond',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('inventory.drop', { item: 'diamond' }),
    now: 1000
  })

  const blocked = await runPlannerCommand({
    userMessage: 'confirmar',
    context,
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    now: 2000
  })

  assert.equal(blocked.status, 'plan_failed')
  assert.match(blocked.chat, /estado mudou/)
  assert.equal(runs, 0)
  assert.equal(context.plannerPendingConfirmation, null)
})

test('executor do planner bloqueia activeSkill exceto movement.stop', async () => {
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'collection.collect',
    description: 'coletar',
    inputSchema: { target: 'string', count: 'number optional' },
    risk: 'medium',
    run: () => actionOk('collection.collect', 'coletado')
  })

  const response = await runPlannerCommand({
    userMessage: 'pega madeira',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: { name: 'crafting' }
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) }
  })

  assert.equal(response.ok, false)
  assert.match(response.chat, /ja estou executando crafting/)
})

test('executor do planner bloqueia risco medio ou alto em survival alto', async () => {
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'collection.collect',
    description: 'coletar',
    inputSchema: { target: 'string', count: 'number optional' },
    risk: 'medium',
    run: () => actionOk('collection.collect', 'coletado')
  })

  assert.equal(survivalBlocksPlan({ severity: 'high', top: 'zombie perto' }, { id: 'collection.collect', risk: 'medium' }), 'survival high: zombie perto')

  const response = await runPlannerCommand({
    userMessage: 'pega madeira',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'high', top: 'zombie perto' }) }
  })

  assert.equal(response.ok, false)
  assert.match(response.chat, /não vou fazer isso agora/)
  assert.match(response.chat, /zombie perto/)
})

test('executor do planner traduz recusa explicita do runner', async () => {
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'movement.stop',
    description: 'parar',
    risk: 'low',
    run: () => actionOk('movement.stop', 'parado')
  })

  const response = await runPlannerCommand({
    userMessage: 'teste',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    history: [],
    maxSteps: 1,
    dryRun: false,
    allowedRisks: ['low'],
    decide: async () => plannerRefuseDecision('nao e seguro')
  })

  assert.equal(response.status, 'refused')
  assert.match(response.chat, /não vou fazer isso agora/)
  assert.match(response.chat, /nao e seguro/)
})

test('runner executa uma acao com sucesso em um ciclo', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('demo.skill')
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 'completed')
  assert.equal(response.steps, 1)
  assert.equal(response.history[0].status, 'executed')
  assert.equal(runs, 1)
})

test('runner usa suggestedNextActions local para recuperar falha simples', async () => {
  let failingRuns = 0
  let recoveryRuns = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => {
      failingRuns++
      return actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
        code: 'missing_materials',
        retryable: true,
        suggestedNextActions: [
          { type: 'skill', skill: 'containers.withdraw', args: { target: 'coal', count: 1 }, reason: 'buscar coal em container' }
        ]
      })
    }
  })
  registry.register({
    id: 'containers.withdraw',
    description: 'retirar',
    inputSchema: { target: 'string', count: 'number optional' },
    risk: 'medium',
    run: () => {
      recoveryRuns++
      return actionOk('containers.withdraw', 'coal retirado')
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 'completed')
  assert.equal(failingRuns, 1)
  assert.equal(recoveryRuns, 1)
  assert.equal(response.history[0].status, 'execute_failed')
  assert.equal(response.history[1].status, 'recovery_executed')
})

test('runner nao executa sugestao invalida de recuperacao', async () => {
  let failingRuns = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => {
      failingRuns++
      return actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
        code: 'missing_materials',
        retryable: true,
        suggestedNextActions: [
          { type: 'skill', skill: 'containers.withdraw', args: { target: 'coal' }, reason: 'sugestao invalida' }
        ]
      })
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(failingRuns, 1)
  assert.equal(response.history.some(entry => entry.status === 'recovery_invalid'), true)
})

test('runner respeita maxSteps antes de recuperar falha sugerida', async () => {
  let recoveryRuns = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
      code: 'missing_materials',
      retryable: true,
      suggestedNextActions: [
        { type: 'skill', skill: 'containers.withdraw', args: { target: 'coal' }, reason: 'buscar coal' }
      ]
    })
  })
  registry.register({
    id: 'containers.withdraw',
    description: 'retirar',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => {
      recoveryRuns++
      return actionOk('containers.withdraw', 'coal retirado')
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 1,
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(recoveryRuns, 0)
  assert.equal(response.steps, 1)
})

test('runner bloqueia recuperacao sugerida por risco nao permitido', async () => {
  let recoveryRuns = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
      code: 'missing_materials',
      retryable: true,
      suggestedNextActions: [
        { type: 'skill', skill: 'containers.withdraw', args: { target: 'coal' }, reason: 'buscar coal' }
      ]
    })
  })
  registry.register({
    id: 'containers.withdraw',
    description: 'retirar perigoso',
    inputSchema: { target: 'string' },
    risk: 'high',
    run: () => {
      recoveryRuns++
      return actionOk('containers.withdraw', 'coal retirado')
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    allowedRisks: ['low', 'medium'],
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(recoveryRuns, 0)
  assert.equal(response.history.some(entry => entry.status === 'recovery_risk_blocked'), true)
})

test('runner nao repete mesma acao sugerida apos falha', async () => {
  let runs = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => {
      runs++
      return actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
        code: 'missing_materials',
        retryable: true,
        suggestedNextActions: [
          { type: 'skill', skill: 'crafting.craft', args: { target: 'torch' }, reason: 'tentar de novo' }
        ]
      })
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(runs, 1)
  assert.equal(response.history.length, 1)
})

test('runner permite desligar recuperacao local por env', async () => {
  assert.equal(configuredRecoveryMode({}, { MINEGPT_AI_RECOVERY: 'off' }), 'off')
  assert.equal(configuredRecoveryMode({}, { MINEGPT_AI_RECOVERY: 'llm' }), 'llm')
  assert.equal(configuredRecoveryMode({}, { MINEGPT_AI_RECOVERY: 'x' }), 'local')

  let recoveryRuns = 0
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'crafting.craft',
    description: 'craft',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => actionFail('crafting.craft', 'faltou coal', {}, Date.now(), {
      code: 'missing_materials',
      retryable: true,
      suggestedNextActions: [
        { type: 'skill', skill: 'containers.withdraw', args: { target: 'coal' }, reason: 'buscar coal' }
      ]
    })
  })
  registry.register({
    id: 'containers.withdraw',
    description: 'retirar',
    inputSchema: { target: 'string' },
    risk: 'medium',
    run: () => {
      recoveryRuns++
      return actionOk('containers.withdraw', 'coal retirado')
    }
  })

  const response = await runPlannerCycles({
    userMessage: 'faz tochas',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    env: { MINEGPT_AI_RECOVERY: 'off' },
    decide: async () => plannerExecuteDecision('crafting.craft', { target: 'torch' })
  })

  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(recoveryRuns, 0)
})

test('runner retorna registry_unavailable quando nao ha SkillRegistry executavel', async () => {
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: {},
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('demo.skill')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'registry_unavailable')
  assert.equal(response.steps, 0)
})

test('runner bloqueia decisoes invalidas antes de plan', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => ({ intent: 'execute_skill', userGoal: '', nextAction: null })
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'invalid_decision')
  assert.match(response.reason, /userGoal ausente/)
  assert.equal(runs, 0)
})

test('runner bloqueia skill inexistente sem executar', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => makePlannerDecision({
      intent: 'execute_skill',
      userGoal: 'teste',
      nextAction: { skill: 'missing.skill', args: {} },
      reasonSummary: 'teste',
      risk: 'low',
      confidence: 0.9,
      stopAfterThis: true
    })
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'invalid_decision')
  assert.match(response.reason, /skill inexistente/)
  assert.equal(runs, 0)
})

test('runner retorna unknown_skill se a lista de tools estiver inconsistente com registry.get', async () => {
  let planned = false
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: {
      skillRegistry: {
        list: () => [{ id: 'phantom.skill', description: 'fantasma', inputSchema: {}, risk: 'low' }],
        get: () => null,
        plan: async () => { planned = true },
        execute: async () => actionOk('phantom.skill', 'nao deveria executar')
      },
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('phantom.skill')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'unknown_skill')
  assert.equal(planned, false)
})

test('runner bloqueia risco nao permitido', async () => {
  const registry = createSkillRegistry({ defaultContext: { bot: {}, stateReporter: {} } })
  registry.register({
    id: 'demo.medium',
    description: 'demo medio',
    risk: 'medium',
    run: () => actionOk('demo.medium', 'ok')
  })

  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: {
      skillRegistry: registry,
      stateReporter: { getPlannerSnapshot: () => ({ online: true }) },
      activeSkill: null
    },
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    allowedRisks: ['low'],
    decide: async () => plannerExecuteDecision('demo.medium', {}, { risk: 'medium' })
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'risk_blocked')
})

test('runner faz dryRun depois de plan e antes de execute', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    dryRun: true,
    decide: async () => plannerExecuteDecision('demo.skill')
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 'dry_run')
  assert.equal(response.plan.ok, true)
  assert.equal(runs, 0)
})

test('runner retorna refused sem executar', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerRefuseDecision('nao e seguro')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'refused')
  assert.equal(response.reason, 'nao e seguro')
  assert.equal(runs, 0)
})

test('runner para quando plan falha e nao executa a skill', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ planOk: false, onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('demo.skill')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'plan_failed')
  assert.equal(response.reason, 'plan falhou')
  assert.equal(runs, 0)
})

test('runner para quando execute falha e preserva retryable', async () => {
  const response = await runPlannerCycles({
    userMessage: 'teste',
    context: createRunnerContext({ executeOk: false, retryable: true }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerExecuteDecision('demo.skill')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'execute_failed_retryable')
  assert.equal(response.result.ok, false)
  assert.equal(response.result.retryable, true)
})

test('runner retorna ask_user sem planejar ou executar', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'teste ambiguo',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    decide: async () => plannerAskDecision('Qual item?')
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'ask_user')
  assert.equal(response.reason, 'Qual item?')
  assert.equal(runs, 0)
})

test('runner bloqueia repeticao da mesma skill com os mesmos args', async () => {
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'repete',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 3,
    decide: async () => plannerExecuteDecision('demo.skill', { step: 1 }, { stopAfterThis: false })
  })

  assert.equal(response.ok, false)
  assert.equal(response.status, 'repetition_blocked')
  assert.equal(response.steps, 2)
  assert.equal(response.history[0].status, 'executed')
  assert.equal(response.history[1].status, 'repetition_blocked')
  assert.equal(runs, 1)
})

test('runner respeita maxSteps em ciclos curtos', async () => {
  let decisions = 0
  let runs = 0
  const response = await runPlannerCycles({
    userMessage: 'ciclo curto',
    context: createRunnerContext({ onRun: () => { runs++ } }),
    survivalGuard: { assess: () => ({ severity: 'low' }) },
    maxSteps: 2,
    decide: async () => {
      decisions++
      return plannerExecuteDecision('demo.skill', { step: decisions }, { stopAfterThis: false })
    }
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 'max_steps_reached')
  assert.equal(response.steps, 2)
  assert.equal(decisions, 2)
  assert.equal(runs, 2)
})
