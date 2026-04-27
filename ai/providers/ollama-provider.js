const { getLocalLlmProfile } = require('../local-llm-profiles')
const { plannerDecisionJsonSchema, validatePlannerDecision } = require('../planner-schema')
const { buildPlannerPromptPayload } = require('../planner-prompt-payload')

class OllamaProviderError extends Error {
  constructor (message, options = {}) {
    super(message)
    this.name = 'OllamaProviderError'
    this.code = options.code || 'ollama_error'
    this.status = options.status || null
    this.retryable = options.retryable !== false
    this.repairable = Boolean(options.repairable)
  }
}

function buildSystemPrompt () {
  return [
    'Voce e o planner JSON de um bot Minecraft survival.',
    'Responda somente um objeto JSON valido no schema. Sem markdown, sem texto extra.',
    'Escolha uma unica proxima acao. Pedido multi-step vira apenas a proxima acao util.',
    'Use somente ids de skills listados. Nunca invente skill, args ou coordenadas.',
    'Se faltar informacao, use intent ask_user.',
    'Nao joga Minecraft, nao escreve codigo e nao chama comandos externos.',
    'Prefira baixo risco; a execucao real sera validada fora do modelo.',
    'Use portugues apenas em reasonSummary e askUser. ids e args devem ser tecnicos e exatos.'
  ].join('\n')
}

function compactForPrompt (value) {
  return JSON.stringify(value)
}

function buildUserPrompt ({ payload }) {
  return [
    'Usuario:',
    payload.userMessage,
    '',
    'Estado JSON:',
    compactForPrompt(payload.plannerState),
    '',
    'Skills JSON:',
    compactForPrompt(payload.skills),
    '',
    'Historico JSON:',
    compactForPrompt(payload.history),
    '',
    'Schema obrigatorio:',
    compactForPrompt(payload.schema),
    '',
    'Retorne somente JSON puro. nextAction.args deve ser objeto. Se incerto, ask_user.'
  ].join('\n')
}

function buildRepairPrompt ({ rawContent, validationErrors = [] }) {
  return [
    'A resposta anterior foi invalida.',
    'Responda somente JSON valido no schema, sem texto antes/depois.',
    'Use exatamente um id de skill listado e nextAction.args como objeto.',
    validationErrors.length ? `Erros: ${validationErrors.slice(0, 4).join('; ')}` : '',
    rawContent ? `Resposta anterior truncada: ${String(rawContent).slice(0, 300)}` : ''
  ].filter(Boolean).join('\n')
}

function buildRepairMessages ({ messages, rawContent, validationErrors }) {
  return [
    messages[0],
    messages[1],
    { role: 'assistant', content: String(rawContent || '').slice(0, 1000) },
    { role: 'user', content: buildRepairPrompt({ rawContent, validationErrors }) }
  ]
}

function safeBaseUrl (baseUrl) {
  return String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
}

function fetchImplementation (providedFetch) {
  const fetchFn = providedFetch || globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new OllamaProviderError('fetch nativo indisponivel no runtime Node.js', {
      code: 'fetch_unavailable',
      retryable: false
    })
  }
  return fetchFn
}

async function requestOllamaChat ({ profile, messages, schema, fetch, signal }) {
  const fetchFn = fetchImplementation(fetch)
  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  const onExternalAbort = controller && signal
    ? () => controller.abort()
    : null
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), profile.timeoutMs)
    : null
  if (onExternalAbort) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const response = await fetchFn(`${safeBaseUrl(profile.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        model: profile.model,
        messages,
        stream: false,
        format: schema,
        keep_alive: profile.keepAlive,
        options: {
          temperature: profile.temperature,
          num_ctx: profile.numCtx,
          num_predict: profile.maxOutputTokens
        }
      })
    })

    if (!response || response.ok !== true) {
      const status = response?.status || null
      const detail = typeof response?.text === 'function' ? await response.text() : ''
      throw new OllamaProviderError(`Ollama HTTP ${status || 'sem status'}: ${detail || response?.statusText || 'sem detalhe'}`, {
        code: status === 404 ? 'model_unavailable' : 'http_error',
        status,
        retryable: true
      })
    }

    return response.json()
  } catch (error) {
    if (error.name === 'AbortError') {
      if (signal?.aborted) {
        throw new OllamaProviderError('chamada Ollama cancelada pelo usuario', {
          code: 'aborted',
          retryable: false
        })
      }
      throw new OllamaProviderError(`timeout ao chamar Ollama apos ${profile.timeoutMs}ms`, {
        code: 'timeout',
        retryable: true
      })
    }

    if (error instanceof OllamaProviderError) throw error
    throw new OllamaProviderError(`falha ao chamar Ollama local: ${error.message}`, {
      code: 'network_error',
      retryable: true
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (onExternalAbort) signal.removeEventListener('abort', onExternalAbort)
  }
}

function debugEnabled (env = process.env) {
  return env.MINEGPT_AI_DEBUG === '1'
}

function debugLog (env, event, details) {
  if (!debugEnabled(env)) return
  console.log(`[minegpt-ai] ${event}: ${JSON.stringify(details)}`)
}

function contentFromOllamaResponse (data) {
  return data?.message?.content || data?.response || ''
}

function extractSingleJsonObject (raw) {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        const before = raw.slice(0, start).trim()
        const after = raw.slice(index + 1).trim()
        if (before || after) {
          throw new OllamaProviderError('Ollama respondeu texto fora do JSON', {
            code: 'json_with_extra_text',
            retryable: false,
            repairable: true
          })
        }
        return raw.slice(start, index + 1)
      }
      if (depth < 0) break
    }
  }

  throw new OllamaProviderError('Ollama respondeu sem objeto JSON completo', {
    code: 'invalid_json',
    retryable: false,
    repairable: true
  })
}

function parseStrictJsonObject (text, options = {}) {
  const raw = String(text || '').trim()
  const allowRepair = options.allowRepair === true
  if (!raw) {
    throw new OllamaProviderError('Ollama respondeu vazio', {
      code: 'empty_response',
      retryable: false,
      repairable: true
    })
  }

  if (raw.startsWith('```')) {
    throw new OllamaProviderError('Ollama respondeu sem JSON puro', {
      code: 'invalid_json',
      retryable: false,
      repairable: allowRepair
    })
  }

  let parsed
  try {
    parsed = JSON.parse(allowRepair ? extractSingleJsonObject(raw) : raw)
  } catch (error) {
    if (error instanceof OllamaProviderError) throw error
    throw new OllamaProviderError(`JSON invalido do Ollama: ${error.message}`, {
      code: 'invalid_json',
      retryable: false,
      repairable: true
    })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OllamaProviderError('Ollama deve responder um objeto JSON', {
      code: 'invalid_json',
      retryable: false,
      repairable: false
    })
  }

  return parsed
}

function validationIsRepairable (validation) {
  const errors = validation?.errors || []
  if (errors.length === 0) return false
  return errors.every(error =>
    /reasonSummary|askUser|confidence|stopAfterThis|risk invalido|intent invalida/.test(error)
  )
}

async function requestAndParseDecision ({ profile, messages, schema, skills, fetch, env, signal }) {
  const startedAt = Date.now()
  const responseData = await requestOllamaChat({ profile, messages, schema, fetch, signal })
  debugLog(env, 'ollama_call', {
    durationMs: Date.now() - startedAt,
    model: profile.model,
    profile: profile.name
  })
  const rawContent = contentFromOllamaResponse(responseData)
  const decision = parseStrictJsonObject(rawContent)
  const validation = validatePlannerDecision(decision, { skills })
  if (!validation.ok) {
    const error = new OllamaProviderError(`decisao invalida do Ollama: ${validation.errors.join('; ')}`, {
      code: 'invalid_decision',
      retryable: false,
      repairable: validationIsRepairable(validation)
    })
    error.validation = validation
    error.decision = decision
    error.rawContent = rawContent
    throw error
  }

  return { decision, validation, rawContent, responseData }
}

async function decideNextAction ({
  userMessage,
  plannerState = {},
  skills = [],
  history = [],
  config = {},
  fetch = undefined,
  signal = undefined,
  env = process.env
}) {
  const profile = getLocalLlmProfile(config)
  const schema = plannerDecisionJsonSchema(skills)
  const payload = buildPlannerPromptPayload({ userMessage, plannerState, skills, history, schema, profile })
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt({ payload }) }
  ]
  debugLog(env, 'payload', {
    approxChars: payload.metrics.approxChars,
    skillsSent: payload.metrics.skillsSent,
    profile: payload.metrics.profile,
    model: payload.metrics.model
  })
  let parsed

  try {
    parsed = await requestAndParseDecision({ profile, messages, schema, skills, fetch, env, signal })
    debugLog(env, 'parse', { ok: true, repaired: false })
  } catch (error) {
    debugLog(env, 'parse', { ok: false, reason: error.message, code: error.code })
    const shouldRetry = error.repairable === true && error.code !== 'invalid_decision'
    if (shouldRetry) {
      try {
        const repairMessages = buildRepairMessages({
          messages,
          rawContent: error.rawContent || '',
          validationErrors: error.validation?.errors || []
        })
        parsed = await requestAndParseDecision({ profile, messages: repairMessages, schema, skills, fetch, env, signal })
        debugLog(env, 'parse', { ok: true, repaired: true })
      } catch (retryError) {
        debugLog(env, 'parse_retry', { ok: false, reason: retryError.message, code: retryError.code })
        throw retryError
      }
    } else {
      throw error
    }

  }

  const { decision, validation } = parsed
  debugLog(env, 'validation', { ok: true, intent: decision.intent, skill: decision.nextAction?.skill || null })

  return {
    ...decision,
    planner: {
      mode: 'ollama',
      stateSeen: Boolean(plannerState),
      historySize: Array.isArray(history) ? history.length : 0,
      providerFallback: null,
      model: profile.model,
      profile: profile.name
    },
    validation
  }
}

module.exports = {
  name: 'ollama',
  local: true,
  decideNextAction,
  buildSystemPrompt,
  buildUserPrompt,
  buildRepairPrompt,
  buildRepairMessages,
  buildPlannerPromptPayload,
  contentFromOllamaResponse,
  extractSingleJsonObject,
  parseStrictJsonObject,
  requestAndParseDecision,
  requestOllamaChat,
  OllamaProviderError
}
