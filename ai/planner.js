const { getPlannerProvider, getFallbackPlannerProvider } = require('./providers')
const { askUserDecision, normalizeText, validateOrAsk } = require('./providers/provider-utils')
const { defaultAiRateLimiter, getAiMaxCallsPerMinute } = require('./planner-limits')

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
  let decision
  const userGoal = String(userMessage || '').trim() || 'comando vazio'

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
      return {
        ...fallbackDecision,
        planner: {
          ...fallbackDecision.planner,
          providerFallback
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
