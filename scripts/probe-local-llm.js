const { performance } = require('perf_hooks')
const { createSkillRegistry } = require('../skills')
const { actionOk } = require('../action-result')
const { getLocalLlmProfile } = require('../ai/local-llm-profiles')
const { plannerDecisionJsonSchema, validatePlannerDecision } = require('../ai/planner-schema')
const { skillRegistryToPlannerTools } = require('../ai/tool-adapter')
const { normalizePlannerDecisionArgs } = require('../ai/providers/provider-utils')
const { actionRequiresConfirmation } = require('../ai/planner-runner')
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildPlannerPromptPayload,
  contentFromOllamaResponse,
  parseStrictJsonObject,
  requestOllamaChat
} = require('../ai/providers/ollama-provider')
const { checkOllamaReady } = require('./bench-local-llm')

function registerProbeSkill (registry, definition) {
  registry.register({
    timeoutMs: 1000,
    run: () => actionOk(definition.id, 'probe: nao executado'),
    ...definition
  })
}

function createProbeRegistry () {
  const registry = createSkillRegistry()

  registerProbeSkill(registry, {
    id: 'movement.come_here',
    description: 'Ir ate a posicao atual do jogador dono.',
    inputSchema: {},
    risk: 'low',
    effects: ['position', 'movement'],
    cost: { base: 2, movement: true },
    plannerHints: 'Use para aproximar do jogador. Exemplo: "venha ate mim" -> args {}.'
  })

  registerProbeSkill(registry, {
    id: 'movement.follow_owner',
    description: 'Seguir o jogador dono de forma continua.',
    inputSchema: {},
    risk: 'low',
    effects: ['position', 'movement'],
    cost: { base: 2, movement: true },
    plannerHints: 'Use para acompanhar o dono. Exemplo: "acompanhe meus passos" -> args {}.'
  })

  registerProbeSkill(registry, {
    id: 'movement.stop',
    description: 'Para movimento e cancela skill atual.',
    inputSchema: {},
    risk: 'low',
    effects: ['movement', 'activeSkill'],
    cost: { base: 1 },
    plannerHints: 'Use para interromper movimento. Exemplo: "cessa" -> args {}.'
  })

  registerProbeSkill(registry, {
    id: 'state.snapshot',
    description: 'Consultar estado compacto do bot.',
    inputSchema: {},
    risk: 'low',
    effects: ['chat'],
    cost: { base: 1 },
    plannerHints: 'Use para perguntas sobre estado, inventario resumido ou diagnostico.'
  })

  registerProbeSkill(registry, {
    id: 'collection.collect',
    description: 'Coleta/minera um bloco alvo percebido.',
    inputSchema: { target: 'string', count: 'number optional max 10' },
    risk: 'medium',
    effects: ['world', 'inventory', 'position', 'drops'],
    cost: { base: 5, movement: true, worldChange: true },
    plannerHints: 'Use target como bloco concreto listado em plannerState.allowedActions.collectTargets. Use collectCategories apenas para entender a intencao; nao envie categoria como target. Nao invente nomes como oak_tree. Exemplo: "arranque madeira de carvalho" -> { "target": "oak_log", "count": 1 }.'
  })

  registerProbeSkill(registry, {
    id: 'drops.collect',
    description: 'Coleta drops proximos, opcionalmente por alvo.',
    inputSchema: { target: 'string optional' },
    risk: 'low',
    effects: ['inventory', 'position', 'drops'],
    cost: { base: 3, movement: true },
    plannerHints: 'Use para recolher itens caidos no chao. Exemplo: "apanhe o que caiu" -> args {}.'
  })

  registerProbeSkill(registry, {
    id: 'crafting.craft',
    description: 'Crafta item se houver receita e materiais.',
    inputSchema: { target: 'string', count: 'number optional' },
    risk: 'medium',
    effects: ['inventory'],
    cost: { base: 4 },
    plannerHints: 'Use para fabricar item conhecido. Exemplo: "faz uma mesa de trabalho" -> { "target": "crafting_table", "count": 1 }.'
  })

  registerProbeSkill(registry, {
    id: 'containers.search',
    description: 'Procura item na memoria e em containers proximos.',
    inputSchema: { target: 'string' },
    risk: 'low',
    effects: ['position', 'containerMemory'],
    cost: { base: 3, movement: true },
    plannerHints: 'Use para localizar item em bau/container sem retirar. Exemplo: "ve se ha carvao no bau" -> { "target": "coal" }.'
  })

  registerProbeSkill(registry, {
    id: 'containers.withdraw',
    description: 'Retira item de containers proximos.',
    inputSchema: { target: 'string', count: 'number optional' },
    risk: 'medium',
    effects: ['inventory', 'position', 'containerMemory'],
    cost: { base: 5, movement: true },
    plannerHints: 'Use para pegar item de bau/container. Exemplo: "traga carvao do bau" -> { "target": "coal", "count": 1 }.'
  })

  registerProbeSkill(registry, {
    id: 'containers.deposit',
    description: 'Guarda item, blocos, recursos, drops ou tudo em containers proximos.',
    inputSchema: { mode: 'target|all|resources|blocks|drops', target: 'string optional', count: 'number optional' },
    risk: 'medium',
    effects: ['inventory', 'position', 'containerMemory'],
    cost: { base: 5, movement: true },
    plannerHints: 'Use mode explicito: blocks, resources, drops, all ou target. Exemplo: "livra-me dos blocos" -> { "mode": "blocks" }.'
  })

  return registry
}

function fakePlannerState () {
  return {
    status: { online: true, canAct: true, busy: false, activeSkill: null },
    vitals: { health: 20, food: 20, oxygen: 20, position: { x: 10, y: 64, z: -8 } },
    inventory: {
      items: [
        { name: 'oak_log', count: 4 },
        { name: 'cobblestone', count: 32 },
        { name: 'coal', count: 3 },
        { name: 'stick', count: 4 },
        { name: 'bread', count: 2 }
      ],
      focus: {
        tools: [{ name: 'stone_pickaxe', count: 1 }],
        food: [{ name: 'bread', count: 2 }],
        basicBlocks: [{ name: 'cobblestone', count: 32 }],
        resources: [{ name: 'coal', count: 3 }],
        hasFreeSlot: true
      }
    },
    perception: {
      topAttention: [
        { kind: 'resource', name: 'oak_log', distance: 5 },
        { kind: 'resource', name: 'stone', distance: 4 },
        { kind: 'resource', name: 'coal_ore', distance: 8 },
        { kind: 'drop', name: 'oak_log', count: 1, distance: 3 },
        { kind: 'container', name: 'chest', distance: 3 }
      ],
      hazards: [],
      resources: [
        { name: 'oak_log', distance: 5 },
        { name: 'stone', distance: 4 },
        { name: 'coal_ore', distance: 8 }
      ],
      drops: [{ name: 'oak_log', count: 1, distance: 3 }],
      containers: [{ type: 'chest', distance: 3, knownItems: ['coal', 'cobblestone'] }]
    },
    allowedActions: {
      collectTargets: ['oak_log', 'stone', 'coal_ore'],
      collectCategories: ['wood', 'stone', 'ore']
    },
    survival: { risk: 'low', reasons: [] },
    containers: { nearby: [{ type: 'chest', distance: 3, knownItems: ['coal', 'cobblestone'] }] }
  }
}

function parseArgs (argv) {
  const args = argv.slice(2)
  const json = args.includes('--json')
  const message = args.filter(arg => arg !== '--json').join(' ').trim()
  return { json, message }
}

function printHuman ({ message, profile, rawContent, parsedDecision, normalizedDecision, validation, plan, confirmation, elapsedMs }) {
  console.log('Probe LLM local MineGPT')
  console.log(`Mensagem: ${message}`)
  console.log(`Modelo: ${profile.model}`)
  console.log(`Perfil: ${profile.name}`)
  console.log(`Tempo: ${Math.round(elapsedMs)}ms`)
  console.log('')
  console.log('Output bruto do modelo:')
  console.log(rawContent)
  console.log('')
  console.log('Decisao parseada:')
  console.log(JSON.stringify(parsedDecision, null, 2))
  console.log('')
  console.log('Decisao normalizada:')
  console.log(JSON.stringify(normalizedDecision, null, 2))
  console.log('')
  console.log(`Validacao: ${validation.ok ? 'ok' : validation.errors.join('; ')}`)
  console.log('')
  console.log('Comando final planejado:')
  if (normalizedDecision.intent !== 'execute_skill') {
    console.log(`intent=${normalizedDecision.intent}`)
    if (normalizedDecision.askUser) console.log(`askUser=${normalizedDecision.askUser}`)
  } else {
    console.log(`${normalizedDecision.nextAction.skill} ${JSON.stringify(normalizedDecision.nextAction.args || {})}`)
  }
  console.log('')
  console.log('Plan:')
  console.log(JSON.stringify(plan, null, 2))
  console.log('')
  console.log(`Confirmacao: ${confirmation.required ? confirmation.reasons.join(', ') : 'nao exigida'}`)
}

async function probeLocalLlm ({ message, json = false, fetch = globalThis.fetch } = {}) {
  if (!message) {
    throw new Error('Uso: npm run llm:probe -- "<mensagem>"')
  }

  const profile = getLocalLlmProfile({}, process.env)
  const ready = await checkOllamaReady({ profile, fetch })
  if (!ready.ok) throw new Error(ready.reason)
  profile.model = ready.selectedModel

  const registry = createProbeRegistry()
  const skills = skillRegistryToPlannerTools(registry)
  const plannerState = fakePlannerState()
  const schema = plannerDecisionJsonSchema(skills, { plannerState })
  const payload = buildPlannerPromptPayload({
    userMessage: message,
    plannerState,
    skills,
    history: [],
    schema,
    profile
  })
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt({ payload }) }
  ]

  const startedAt = performance.now()
  const responseData = await requestOllamaChat({ profile, messages, schema, fetch })
  const rawContent = contentFromOllamaResponse(responseData)
  const parsedDecision = parseStrictJsonObject(rawContent)
  const normalizedDecision = normalizePlannerDecisionArgs(parsedDecision, skills)
  const validation = validatePlannerDecision(normalizedDecision, { skills, plannerState })

  let plan = null
  let confirmation = { required: false, reasons: [] }
  if (validation.ok && normalizedDecision.intent === 'execute_skill') {
    const action = normalizedDecision.nextAction
    plan = await registry.plan(action.skill, action.args, {
      plannerMode: true,
      explicitUserIntent: true
    })
    confirmation = actionRequiresConfirmation({
      skill: registry.get(action.skill),
      args: action.args,
      plan
    })
  }

  const result = {
    message,
    profile: {
      name: profile.name,
      model: profile.model,
      numCtx: profile.numCtx,
      maxOutputTokens: profile.maxOutputTokens
    },
    elapsedMs: performance.now() - startedAt,
    rawContent,
    parsedDecision,
    normalizedDecision,
    validation,
    finalAction: normalizedDecision.intent === 'execute_skill' ? normalizedDecision.nextAction : null,
    plan,
    confirmation
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printHuman(result)
  }

  return result
}

if (require.main === module) {
  const args = parseArgs(process.argv)
  probeLocalLlm(args).catch((error) => {
    console.error(`Falha no probe local: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  createProbeRegistry,
  fakePlannerState,
  probeLocalLlm
}
