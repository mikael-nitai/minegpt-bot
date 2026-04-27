const { performance } = require('perf_hooks')
const { TextDecoder } = require('util')
const { getLocalLlmProfile } = require('../ai/local-llm-profiles')
const { plannerDecisionJsonSchema, validatePlannerDecision } = require('../ai/planner-schema')
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildPlannerPromptPayload,
  contentFromOllamaResponse,
  parseStrictJsonObject,
  requestOllamaChat
} = require('../ai/providers/ollama-provider')

const SCENARIOS = [
  'vem aqui',
  'para',
  'me segue',
  'pega madeira',
  'coleta 3 pedras',
  'faz crafting table',
  'faz tochas',
  'procura carvao no bau',
  'guarda blocos',
  'pega madeira e faz uma crafting table'
]

const BENCH_SKILLS = [
  {
    id: 'movement.come_here',
    description: 'Ir ate a posicao atual do jogador dono.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'low',
    plannerHints: 'Use para comandos como vem aqui, venha ou venha ate mim.'
  },
  {
    id: 'movement.follow_owner',
    description: 'Seguir o jogador dono de forma continua.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'low',
    plannerHints: 'Use para me segue ou siga-me.'
  },
  {
    id: 'movement.stop',
    description: 'Parar navegacao, coleta ou comportamento continuo planejado.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'low',
    plannerHints: 'Use para para, pare ou interrompa.'
  },
  {
    id: 'state.snapshot',
    description: 'Consultar estado compacto do bot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'low',
    plannerHints: 'Use para estado, status ou diagnostico.'
  },
  {
    id: 'collection.collect_block',
    description: 'Coletar ou minerar blocos conhecidos no mundo.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 16 }
      },
      required: ['target'],
      additionalProperties: false
    },
    risk: 'medium',
    plannerHints: 'Use para madeira, pedra, carvao e outros blocos. Extraia count quando houver numero.'
  },
  {
    id: 'crafting.craft_item',
    description: 'Craftar item conhecido usando recursos disponiveis.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 64 }
      },
      required: ['item'],
      additionalProperties: false
    },
    risk: 'low',
    plannerHints: 'Use para crafting_table, torch, stick e itens basicos. Escolha uma unica proxima acao.'
  },
  {
    id: 'drops.pickup',
    description: 'Pegar drops proximos no chao.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'low',
    plannerHints: 'Use para pega drops.'
  },
  {
    id: 'containers.find_item',
    description: 'Procurar item em bau ou container conhecido/proximo.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 64 }
      },
      required: ['item'],
      additionalProperties: false
    },
    risk: 'low',
    plannerHints: 'Use para procurar/buscar item em bau ou container.'
  },
  {
    id: 'containers.deposit',
    description: 'Guardar itens em bau ou container.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        item: { type: 'string' },
        all: { type: 'boolean' }
      },
      additionalProperties: false
    },
    risk: 'medium',
    plannerHints: 'Use para guardar blocos, recursos, drops ou tudo.'
  }
]

function formatPct (value) {
  return `${Math.round(value * 100)}%`
}

function formatMs (value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${Math.round(value)}ms`
}

function fakePlannerState () {
  return {
    status: {
      online: true,
      canAct: true,
      busy: false,
      activeSkill: null
    },
    vitals: {
      health: 20,
      food: 20,
      oxygen: 20,
      position: { x: 10, y: 64, z: -8 }
    },
    inventory: {
      summary: [
        { name: 'oak_log', count: 2 },
        { name: 'cobblestone', count: 8 },
        { name: 'stick', count: 4 },
        { name: 'coal', count: 2 },
        { name: 'torch', count: 4 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'bread', count: 3 }
      ]
    },
    perception: {
      topAttention: [
        { kind: 'resource', name: 'oak_log', distance: 6 },
        { kind: 'resource', name: 'stone', distance: 4 },
        { kind: 'resource', name: 'coal_ore', distance: 9 },
        { kind: 'container', name: 'chest', distance: 3 }
      ],
      hazards: [],
      resources: [
        { name: 'oak_log', distance: 6 },
        { name: 'stone', distance: 4 },
        { name: 'coal_ore', distance: 9 }
      ],
      drops: [
        { name: 'oak_log', count: 1, distance: 3 }
      ],
      containers: [
        { type: 'chest', distance: 3, knownItems: ['coal', 'cobblestone'] }
      ]
    },
    survival: {
      risk: 'low',
      reasons: []
    },
    containers: {
      nearby: [
        { type: 'chest', distance: 3, knownItems: ['coal', 'cobblestone'] }
      ]
    }
  }
}

function expectedHintsForScenario (scenario) {
  const text = scenario.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (text.includes('vem')) return { skills: ['movement.come_here'] }
  if (text === 'para') return { skills: ['movement.stop'] }
  if (text.includes('segue')) return { skills: ['movement.follow_owner'] }
  if (text.includes('madeira') && text.includes('crafting')) {
    return { skills: ['collection.collect_block', 'crafting.craft_item'], targets: ['wood', 'oak_log', 'log', 'madeira', 'crafting_table'] }
  }
  if (text.includes('madeira')) return { skills: ['collection.collect_block'], targets: ['wood', 'oak_log', 'log', 'madeira'] }
  if (text.includes('pedras')) return { skills: ['collection.collect_block'], targets: ['stone', 'cobblestone', 'pedra'], count: 3 }
  if (text.includes('tochas')) return { skills: ['crafting.craft_item'], targets: ['torch', 'tocha'] }
  if (text.includes('crafting table')) return { skills: ['crafting.craft_item'], targets: ['crafting_table', 'crafting table', 'mesa_de_trabalho'] }
  if (text.includes('carvao')) return { skills: ['containers.find_item'], targets: ['coal', 'carvao'] }
  if (text.includes('guarda')) return { skills: ['containers.deposit'], targets: ['blocks', 'blocos'] }
  return { skills: [] }
}

function extractArgumentText (args = {}) {
  return JSON.stringify(args).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function checkArgumentCoherence (scenario, decision) {
  if (decision.intent !== 'execute_skill') return { ok: decision.intent === 'ask_user', detail: decision.intent }

  const hints = expectedHintsForScenario(scenario)
  const skill = decision.nextAction?.skill
  const argsText = extractArgumentText(decision.nextAction?.args || {})
  const errors = []

  if (hints.skills.length > 0 && !hints.skills.includes(skill)) {
    errors.push(`skill esperada: ${hints.skills.join(' ou ')}`)
  }

  if (hints.targets?.length && !hints.targets.some(target => argsText.includes(target))) {
    errors.push(`args sem alvo esperado: ${hints.targets.join(' ou ')}`)
  }

  if (hints.count && !argsText.includes(String(hints.count))) {
    errors.push(`args sem quantidade ${hints.count}`)
  }

  return {
    ok: errors.length === 0,
    detail: errors.join('; ') || 'ok'
  }
}

function tryReadResponseTimings (data) {
  const totalDurationNs = Number(data?.total_duration)
  const evalDurationNs = Number(data?.eval_duration)
  const loadDurationNs = Number(data?.load_duration)
  return {
    totalDurationMs: Number.isFinite(totalDurationNs) && totalDurationNs > 0 ? totalDurationNs / 1e6 : null,
    evalDurationMs: Number.isFinite(evalDurationNs) && evalDurationNs > 0 ? evalDurationNs / 1e6 : null,
    loadDurationMs: Number.isFinite(loadDurationNs) && loadDurationNs > 0 ? loadDurationNs / 1e6 : null
  }
}

function safeBaseUrl (baseUrl) {
  return String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
}

function parseOllamaStreamLine (line) {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

async function requestOllamaChatStream ({ profile, messages, schema, fetch = globalThis.fetch }) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch nativo indisponivel no Node.js')
  }

  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  const timeoutId = controller ? setTimeout(() => controller.abort(), profile.timeoutMs) : null
  const startedAt = performance.now()
  let firstResponseMs = null
  let content = ''
  let finalData = null
  let buffered = ''

  try {
    const response = await fetch(`${safeBaseUrl(profile.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        model: profile.model,
        messages,
        stream: true,
        format: schema,
        keep_alive: profile.keepAlive,
        options: {
          temperature: profile.temperature,
          num_ctx: profile.numCtx,
          num_predict: profile.maxOutputTokens
        }
      })
    })

    if (!response.ok) {
      const detail = typeof response.text === 'function' ? await response.text() : ''
      throw new Error(`Ollama HTTP ${response.status}: ${detail || response.statusText || 'sem detalhe'}`)
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error('stream da resposta indisponivel')
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstResponseMs == null) firstResponseMs = performance.now() - startedAt
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''

      for (const line of lines) {
        const parsed = parseOllamaStreamLine(line)
        if (!parsed) continue
        finalData = parsed
        content += parsed.message?.content || parsed.response || ''
      }
    }

    buffered += decoder.decode()
    const finalParsed = parseOllamaStreamLine(buffered)
    if (finalParsed) {
      finalData = finalParsed
      content += finalParsed.message?.content || finalParsed.response || ''
    }

    return {
      content,
      data: finalData,
      firstResponseMs,
      totalMs: performance.now() - startedAt
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function checkOllamaReady ({ profile, fetch }) {
  if (typeof fetch !== 'function') {
    return { ok: false, reason: 'fetch nativo indisponivel no Node.js. Use Node 18+.' }
  }

  let tagsResponse
  try {
    tagsResponse = await fetch(`${String(profile.baseUrl).replace(/\/+$/, '')}/api/tags`)
  } catch (error) {
    return {
      ok: false,
      reason: `Ollama offline ou inacessivel em ${profile.baseUrl}: ${error.message}`
    }
  }

  if (!tagsResponse.ok) {
    return {
      ok: false,
      reason: `Ollama respondeu HTTP ${tagsResponse.status} em /api/tags`
    }
  }

  let tags
  try {
    tags = await tagsResponse.json()
  } catch (error) {
    return { ok: false, reason: `Resposta invalida de /api/tags: ${error.message}` }
  }

  const available = Array.isArray(tags.models) ? tags.models.map(model => model.name).filter(Boolean) : []
  const candidates = [...new Set([profile.model, profile.fallbackModel].filter(Boolean))]
  const selectedModel = candidates.find(candidate => available.some(name => name === candidate || name === `${candidate}:latest` || name.replace(/:latest$/, '') === candidate))

  if (!selectedModel) {
    return {
      ok: false,
      reason: `Modelo ausente. Esperado: ${candidates.join(' ou ') || profile.model}.`,
      available
    }
  }

  return { ok: true, selectedModel, available }
}

async function runScenario ({ scenario, profile, schema, skills }) {
  const plannerState = fakePlannerState()
  const payload = buildPlannerPromptPayload({
    userMessage: scenario,
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
  let responseData
  let rawContent
  let firstResponseMs = null
  try {
    if (process.env.MINEGPT_AI_BENCH_STREAM === '0') {
      responseData = await requestOllamaChat({ profile, messages, schema })
      rawContent = contentFromOllamaResponse(responseData)
    } else {
      const streamed = await requestOllamaChatStream({ profile, messages, schema })
      responseData = streamed.data
      rawContent = streamed.content
      firstResponseMs = streamed.firstResponseMs
    }
  } catch (error) {
    return {
      scenario,
      ok: false,
      jsonValid: false,
      decisionValid: false,
      skillExists: false,
      argsCoherent: false,
      totalMs: performance.now() - startedAt,
      error: error.message
    }
  }
  const totalMs = performance.now() - startedAt
  const timings = tryReadResponseTimings(responseData)

  let decision
  try {
    decision = parseStrictJsonObject(rawContent)
  } catch (error) {
    return {
      scenario,
      ok: false,
      jsonValid: false,
      decisionValid: false,
      skillExists: false,
      argsCoherent: false,
      totalMs,
      firstResponseMs,
      timings,
      error: error.message,
      raw: String(rawContent || '').slice(0, 240)
    }
  }

  const validation = validatePlannerDecision(decision, { skills })
  const skillExists = decision.intent !== 'execute_skill' || skills.some(skill => skill.id === decision.nextAction?.skill)
  const coherence = checkArgumentCoherence(scenario, decision)

  return {
    scenario,
    ok: validation.ok && skillExists && coherence.ok,
    jsonValid: true,
    decisionValid: validation.ok,
    skillExists,
    argsCoherent: coherence.ok,
    totalMs,
    firstResponseMs,
    timings,
    skill: decision.nextAction?.skill || null,
    args: decision.nextAction?.args || null,
    intent: decision.intent,
    errors: [
      ...validation.errors,
      ...(skillExists ? [] : [`skill inexistente: ${decision.nextAction?.skill}`]),
      ...(coherence.ok ? [] : [`argumentos incoerentes: ${coherence.detail}`])
    ]
  }
}

function summarize (results) {
  const total = results.length
  const durations = results.map(result => result.totalMs).filter(Number.isFinite).sort((a, b) => a - b)
  const firstResponses = results.map(result => result.firstResponseMs).filter(Number.isFinite).sort((a, b) => a - b)
  const validJson = results.filter(result => result.jsonValid).length
  const validDecisions = results.filter(result => result.decisionValid).length
  const existingSkills = results.filter(result => result.skillExists).length
  const coherentArgs = results.filter(result => result.argsCoherent).length
  const average = durations.reduce((sum, value) => sum + value, 0) / (durations.length || 1)
  const worst = durations[durations.length - 1]
  const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1)

  return {
    total,
    averageMs: average,
    averageFirstResponseMs: firstResponses.reduce((sum, value) => sum + value, 0) / (firstResponses.length || 1),
    p95Ms: durations[p95Index],
    worstMs: worst,
    jsonRate: validJson / total,
    decisionRate: validDecisions / total,
    skillRate: existingSkills / total,
    argsRate: coherentArgs / total
  }
}

async function benchLocalLlm () {
  const profile = getLocalLlmProfile({}, process.env)
  const fetchFn = globalThis.fetch
  const ready = await checkOllamaReady({ profile, fetch: fetchFn })

  console.log('Benchmark LLM local MineGPT')
  console.log(`Ollama: ${profile.baseUrl}`)
  console.log(`Perfil: ${profile.name}`)
  console.log(`Modelo solicitado: ${profile.model}`)
  console.log(`num_ctx=${profile.numCtx} | max_output_tokens=${profile.maxOutputTokens} | timeout_ms=${profile.timeoutMs} | keep_alive=${profile.keepAlive}`)

  if (!ready.ok) {
    console.log('')
    console.log(`Nao foi possivel iniciar o benchmark: ${ready.reason}`)
    if (ready.available?.length) console.log(`Modelos disponiveis: ${ready.available.join(', ')}`)
    console.log('')
    console.log('Sugestoes:')
    console.log('- Rode: npm run llm:check')
    console.log('- Inicie o servidor com: ollama serve')
    console.log('- Baixe o modelo com: npm run llm:pull')
    return { ok: false, reason: ready.reason }
  }

  profile.model = ready.selectedModel
  const skills = BENCH_SKILLS
  const schema = plannerDecisionJsonSchema(skills)
  console.log(`Modelo usado: ${profile.model}`)
  console.log(`Cenarios: ${SCENARIOS.length}`)
  console.log('')

  const results = []
  for (const scenario of SCENARIOS) {
    const result = await runScenario({ scenario, profile, schema, skills })
    results.push(result)
    const status = result.ok ? 'ok' : 'falha'
    const detail = result.error || result.errors?.join('; ') || `${result.intent}${result.skill ? ` -> ${result.skill}` : ''}`
    console.log(`- ${scenario}: ${status} | ${formatMs(result.totalMs)} | ${detail}`)
  }

  const summary = summarize(results)
  console.log('')
  console.log('Resumo')
  console.log(`Modelo: ${profile.model}`)
  console.log(`Perfil: ${profile.name}`)
  console.log(`Tempo medio: ${formatMs(summary.averageMs)}`)
  console.log(`Primeira resposta media: ${summary.averageFirstResponseMs > 0 ? formatMs(summary.averageFirstResponseMs) : 'indisponivel'}`)
  console.log(`p95 simples: ${formatMs(summary.p95Ms)}`)
  console.log(`Maior tempo: ${formatMs(summary.worstMs)}`)
  console.log(`JSON valido: ${formatPct(summary.jsonRate)}`)
  console.log(`Decisoes validas: ${formatPct(summary.decisionRate)}`)
  console.log(`Skills existentes: ${formatPct(summary.skillRate)}`)
  console.log(`Argumentos coerentes: ${formatPct(summary.argsRate)}`)

  const failures = results.filter(result => !result.ok)
  if (failures.length > 0) {
    console.log('')
    console.log('Erros por cenario')
    for (const failure of failures) {
      console.log(`- ${failure.scenario}: ${failure.error || failure.errors?.join('; ') || 'falha sem detalhe'}`)
    }
  }

  return { ok: failures.length === 0, results, summary }
}

if (require.main === module) {
  benchLocalLlm().catch((error) => {
    console.error(`Falha inesperada no benchmark local: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  BENCH_SKILLS,
  SCENARIOS,
  benchLocalLlm,
  checkArgumentCoherence,
  checkOllamaReady,
  expectedHintsForScenario,
  fakePlannerState,
  runScenario,
  summarize
}
