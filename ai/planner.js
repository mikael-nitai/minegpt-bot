const { getPlannerProvider, getFallbackPlannerProvider } = require('./providers')
const { askUserDecision, normalizeText, validateOrAsk } = require('./providers/provider-utils')
const { defaultAiRateLimiter, getAiMaxCallsPerMinute } = require('./planner-limits')

function shortErrorMessage (error) {
  return String(error?.message || error || 'erro desconhecido').slice(0, 180)
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

    const fallbackProvider = getFallbackPlannerProvider(config, env)
    if (fallbackProvider) {
      const fallbackDecision = await fallbackProvider.decideNextAction({ userMessage, plannerState, skills, history, config, env, fetch, signal })
      return {
        ...fallbackDecision,
        planner: {
          ...fallbackDecision.planner,
          providerFallback: `${provider.name} falhou: ${shortErrorMessage(error)}; fallback=${fallbackProvider.name}`
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
      providerFallback: shortErrorMessage(error)
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
