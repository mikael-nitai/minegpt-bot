const test = require('node:test')
const assert = require('node:assert/strict')
const { createSkillRegistry } = require('../skills')
const { actionOk } = require('../action-result')
const {
  decideNextAction,
  makePlannerDecision,
  validatePlannerDecision,
  skillsToPlannerTools,
  skillRegistryToPlannerTools
} = require('../ai')
const { parseBotCommand, runPlannerCommand, survivalBlocksPlan } = require('../ai/planner-executor')

function plannerTools () {
  return [
    { id: 'movement.stop', description: 'parar', inputSchema: {}, risk: 'low', effects: ['movement'], cost: { base: 1 }, plannerHints: '' },
    { id: 'movement.come_here', description: 'vem aqui', inputSchema: {}, risk: 'low', effects: ['position'], cost: { base: 2 }, plannerHints: '' },
    { id: 'movement.follow_owner', description: 'seguir', inputSchema: {}, risk: 'low', effects: ['position'], cost: { base: 2 }, plannerHints: '' },
    { id: 'state.snapshot', description: 'estado', inputSchema: {}, risk: 'low', effects: [], cost: { base: 1 }, plannerHints: '' },
    { id: 'collection.collect', description: 'coletar', inputSchema: { target: 'string', count: 'number optional' }, risk: 'medium', effects: ['world', 'inventory'], cost: { base: 5 }, plannerHints: '' },
    { id: 'crafting.craft', description: 'craftar', inputSchema: { target: 'string', count: 'number optional' }, risk: 'medium', effects: ['inventory'], cost: { base: 4 }, plannerHints: '' }
  ]
}

test('planner mockado escolhe uma unica skill para comandos conhecidos', async () => {
  const skills = plannerTools()

  const stop = await decideNextAction({ userMessage: 'bot parar agora', plannerState: {}, skills, history: [] })
  assert.equal(stop.intent, 'execute_skill')
  assert.equal(stop.nextAction.skill, 'movement.stop')
  assert.deepEqual(Object.keys(stop.nextAction), ['skill', 'args'])
  assert.equal(Array.isArray(stop.nextAction), false)
  assert.equal(stop.stopAfterThis, true)

  const comeHere = await decideNextAction({ userMessage: 'vem aqui', plannerState: {}, skills })
  assert.equal(comeHere.nextAction.skill, 'movement.come_here')

  const follow = await decideNextAction({ userMessage: 'seguir', plannerState: {}, skills })
  assert.equal(follow.nextAction.skill, 'movement.follow_owner')

  const state = await decideNextAction({ userMessage: 'estado', plannerState: {}, skills })
  assert.equal(state.nextAction.skill, 'state.snapshot')
})

test('planner mockado mapeia alvos simples para skills com args', async () => {
  const skills = plannerTools()

  const wood = await decideNextAction({ userMessage: 'pega madeira', plannerState: {}, skills })
  assert.equal(wood.intent, 'execute_skill')
  assert.equal(wood.nextAction.skill, 'collection.collect')
  assert.deepEqual(wood.nextAction.args, { target: 'madeira', count: 1 })
  assert.equal(wood.risk, 'medium')

  const table = await decideNextAction({ userMessage: 'faz uma crafting table', plannerState: {}, skills })
  assert.equal(table.intent, 'execute_skill')
  assert.equal(table.nextAction.skill, 'crafting.craft')
  assert.deepEqual(table.nextAction.args, { target: 'crafting_table', count: 1 })
})

test('planner mockado pergunta quando nao entende ou skill nao esta disponivel', async () => {
  const unknown = await decideNextAction({ userMessage: 'organize minha base inteira', plannerState: {}, skills: plannerTools() })
  assert.equal(unknown.intent, 'ask_user')
  assert.equal(unknown.nextAction, null)
  assert.match(unknown.askUser, /Nao entendi/)

  const unavailable = await decideNextAction({
    userMessage: 'vem aqui',
    plannerState: {},
    skills: plannerTools().filter(skill => skill.id !== 'movement.come_here')
  })
  assert.equal(unavailable.intent, 'ask_user')
  assert.equal(unavailable.nextAction, null)
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
  assert.match(response.chat, /já estou executando crafting/)
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
