const { getPlannerProvider, getFallbackPlannerProvider } = require('./providers')
const { askUserDecision, normalizeText, traceLog, validateOrAsk } = require('./providers/provider-utils')
const ruleBasedProvider = require('./providers/rule-based-provider')
const { defaultAiRateLimiter, getAiMaxCallsPerMinute } = require('./planner-limits')
const { getLocalLlmProfile } = require('./local-llm-profiles')

const BASIC_CONTROL_FALLBACK_SKILLS = new Set([
  'movement.come_here',
  'movement.stop',
  'state.snapshot',
  'state.planner_snapshot'
])

function debugEnabled (env = process.env) {
  return env.MINEGPT_AI_DEBUG === '1'
}

function debugLog (env, event, details) {
  if (!debugEnabled(env)) return
  console.log(`[minegpt-ai] ${event}: ${JSON.stringify(details)}`)
}

function shortErrorMessage (error) {
  return String(error?.message || error || 'erro desconhecido').slice(0, 180)
}

function providerFailureMeta ({ providerName, error, fallbackProviderName = null, finalProviderName = null }) {
  const errorMessage = shortErrorMessage(error)
  return fallbackProviderName
    ? `provider=${providerName}; erro=${errorMessage}; fallback=${fallbackProviderName}; decisao_final=${finalProviderName || fallbackProviderName}`
    : `provider=${providerName}; erro=${errorMessage}; fallback=nenhum; decisao_final=ask_user`
}

function ollamaWarmupInProgress (config = {}) {
  const runtime = config.ai?.ollamaRuntime
  return runtime?.status === 'warming'
}

function canUseBasicControlFallback (error) {
  return ['timeout', 'invalid_json', 'empty_response', 'json_with_extra_text'].includes(error?.code)
}

async function tryBasicControlFallback ({ userMessage, plannerState, skills, history, config, env, signal }) {
  const fallbackDecision = await ruleBasedProvider.decideNextAction({
    userMessage,
    plannerState,
    skills,
    history,
    config,
    env,
    signal
  })
  const skill = fallbackDecision?.nextAction?.skill
  if (fallbackDecision.intent !== 'execute_skill' || !BASIC_CONTROL_FALLBACK_SKILLS.has(skill)) return null

  return {
    ...fallbackDecision,
    planner: {
      ...fallbackDecision.planner,
      mode: 'rule_based_basic_fallback'
    }
  }
}

async function decideNextAction ({
  userMessage,
  plannerState = {},
  skills = [],
  history = [],
  config = {},
  env = process.env,
  fetch = undefined,
  signal = undefined,
  rateLimiter = defaultAiRateLimiter
}) {
  const provider = getPlannerProvider(config, env)
  const profile = getLocalLlmProfile(config, env)
  const startedAt = Date.now()
  let decision
  const userGoal = String(userMessage || '').trim() || 'comando vazio'

  debugLog(env, 'provider_start', {
    requested: provider.requestedName || provider.name,
    effective: provider.name,
    fallbackReason: provider.fallbackReason || null,
    configuredFallback: config.ai?.fallbackProvider || config.ai?.fallback_provider || env.MINEGPT_AI_FALLBACK_PROVIDER || null,
    model: profile.model,
    profile: profile.name,
    timeoutMs: profile.timeoutMs
  })
  traceLog(env, 'provider', {
    requested: provider.requestedName || provider.name,
    effective: provider.name,
    fallbackReason: provider.fallbackReason || null,
    configuredFallback: config.ai?.fallbackProvider || config.ai?.fallback_provider || env.MINEGPT_AI_FALLBACK_PROVIDER || null,
    model: profile.model,
    profile: profile.name
  })

  const shouldRateLimit = provider.name === 'ollama' && (!fetch || rateLimiter !== defaultAiRateLimiter)
  if (shouldRateLimit) {
    const rateLimit = rateLimiter.check({
      key: 'ollama',
      limit: getAiMaxCallsPerMinute(config, env)
    })

    if (!rateLimit.ok) {
      const seconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))
      const limitedDecision = askUserDecision(
        userGoal,
        `Estou recebendo comandos rapido demais; tente em ${seconds} segundo(s).`,
        `Rate limit local do LLM excedido (${rateLimit.limit}/min).`
      )
      return validateOrAsk({
        decision: limitedDecision,
        skills,
        userGoal,
        mode: provider.name,
        plannerState,
        history
      })
    }
  }

  try {
    decision = await provider.decideNextAction({ userMessage, plannerState, skills, history, config, env, fetch, signal })
    traceLog(env, 'provider_result', {
      requested: provider.requestedName || provider.name,
      effective: decision?.planner?.mode || provider.name,
      fallbackUsed: false,
      intent: decision?.intent,
      skill: decision?.nextAction?.skill || null
    })
    debugLog(env, 'provider_result', {
      requested: provider.requestedName || provider.name,
      effective: decision?.planner?.mode || provider.name,
      fallbackUsed: false,
      durationMs: Date.now() - startedAt,
      intent: decision?.intent,
      skill: decision?.nextAction?.skill || null
    })
  } catch (error) {
    if (error?.code === 'aborted') {
      const abortedDecision = askUserDecision(
        userGoal,
        'Decisao cancelada pelo comando parar.',
        `Provider ${provider.name} cancelado.`
      )
      return validateOrAsk({
        decision: abortedDecision,
        skills,
        userGoal,
        mode: provider.name,
        plannerState,
        history,
        providerFallback: 'cancelado'
      })
    }

    if (provider.name === 'ollama' && ollamaWarmupInProgress(config)) {
      const warmupDecision = askUserDecision(
        userGoal,
        `O modelo local ainda esta aquecendo (${shortErrorMessage(error)}). Tente novamente em alguns segundos.`,
        'Ollama em warmup; fallback bloqueado para evitar decisao divergente.'
      )
      return validateOrAsk({
        decision: warmupDecision,
        skills,
        userGoal,
        mode: provider.name,
        plannerState,
        history,
        providerFallback: providerFailureMeta({ providerName: provider.name, error })
      })
    }

    const fallbackProvider = getFallbackPlannerProvider(config, env)
    if (fallbackProvider) {
      const fallbackDecision = await fallbackProvider.decideNextAction({ userMessage, plannerState, skills, history, config, env, fetch, signal })
      const providerFallback = providerFailureMeta({
        providerName: provider.name,
        error,
        fallbackProviderName: fallbackProvider.name,
        finalProviderName: fallbackDecision.planner?.mode || fallbackProvider.name
      })
      debugLog(env, 'provider_result', {
        requested: provider.requestedName || provider.name,
        effective: fallbackDecision.planner?.mode || fallbackProvider.name,
        fallbackUsed: true,
        fallback: fallbackProvider.name,
        reason: providerFallback,
        durationMs: Date.now() - startedAt,
        intent: fallbackDecision.intent,
        skill: fallbackDecision.nextAction?.skill || null
      })
      traceLog(env, 'provider_fallback', {
        requested: provider.name,
        effective: fallbackDecision.planner?.mode || fallbackProvider.name,
        reason: providerFallback,
        intent: fallbackDecision.intent,
        skill: fallbackDecision.nextAction?.skill || null
      })
      return {
        ...fallbackDecision,
        planner: {
          ...fallbackDecision.planner,
          providerFallback
        }
      }
    }

    if (provider.name === 'ollama' && canUseBasicControlFallback(error)) {
      const basicFallbackDecision = await tryBasicControlFallback({ userMessage, plannerState, skills, history, config, env, signal })
      if (basicFallbackDecision) {
        const providerFallback = providerFailureMeta({
          providerName: provider.name,
          error,
          fallbackProviderName: 'rule_based_basic',
          finalProviderName: basicFallbackDecision.planner?.mode || 'rule_based_basic_fallback'
        })
        traceLog(env, 'provider_fallback', {
          requested: provider.name,
          effective: basicFallbackDecision.planner?.mode || 'rule_based_basic_fallback',
          reason: providerFallback,
          intent: basicFallbackDecision.intent,
          skill: basicFallbackDecision.nextAction?.skill || null
        })
        return {
          ...basicFallbackDecision,
          planner: {
            ...basicFallbackDecision.planner,
            providerFallback
          }
        }
      }
    }

    const errorDecision = askUserDecision(
      userGoal,
      `Provider ${provider.name} indisponivel: ${shortErrorMessage(error)}`,
      `Falha no provider ${provider.name}.`
    )
    return validateOrAsk({
      decision: errorDecision,
      skills,
      userGoal,
      mode: provider.name,
      plannerState,
      history,
      providerFallback: providerFailureMeta({ providerName: provider.name, error })
    })
  }

  if (!provider.fallbackReason || !decision?.planner) return decision
  return {
    ...decision,
    planner: {
      ...decision.planner,
      providerFallback: provider.fallbackReason
    }
  }
}

module.exports = {
  decideNextAction,
  normalizeText
}
