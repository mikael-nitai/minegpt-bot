const { URL } = require('url')
const {
  actionSignature,
  normalizeSeverityLevel,
  runPlannerCycles,
  survivalBlocksPlan
} = require('./planner-runner')
const {
  PROVIDERS,
  configuredFallbackProviderName,
  getPlannerProvider,
  normalizeProviderName
} = require('./providers')
const {
  LOCAL_LLM_PROFILES,
  getLocalLlmProfile,
  resolveProfileName
} = require('./local-llm-profiles')
const { makePlannerDecision } = require('./planner-schema')
const { traceLog } = require('./providers/provider-utils')

const DEFAULT_CONFIRMATION_TTL_MS = 30000

function parseBotCommand (text) {
  const raw = String(text || '').trim()
  const match = raw.match(/^bot(?:\s+(.+))?$/i)
  if (!match) return null
  return (match[1] || '').trim()
}

function summarizeActionResult (result) {
  if (!result) return 'resultado vazio'
  return result.ok
    ? `feito — ${result.message || result.code || result.skill}.`
    : `não consegui — ${result.reason || result.message || result.code || 'falha desconhecida'}.`
}

function formatArgs (args = {}) {
  const text = JSON.stringify(args || {})
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function summarizePlan (run) {
  const action = run?.decision?.nextAction
  const plan = run?.plan
  if (!action) return run?.reason || 'nenhuma acao planejada'
  const description = plan?.description ? `${plan.description}; ` : ''
  return `${description}faria ${action.skill} com args ${formatArgs(action.args)}`
}

function plannerChatResponse (run, chat, env = process.env) {
  traceLog(env, 'final_chat_status', {
    ok: Boolean(run?.ok),
    status: run?.status || null,
    reason: run?.reason || null,
    chat
  })
  return { ...run, chat }
}

function normalizeDiagnosticText (userMessage) {
  const text = String(userMessage || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
  return text.replace(/\s+/g, ' ')
}

function parsePlannerControlCommand (userMessage) {
  const text = normalizeDiagnosticText(userMessage)
  if (text === 'para' || text === 'pare' || text === 'parar') return { kind: 'stop' }
  if (text === 'confirmar') return { kind: 'confirm' }
  if (text.startsWith('confirmar ')) return { kind: 'confirm_extra' }
  if (text === 'cancelar') return { kind: 'cancel' }
  if (text === 'plano') return { kind: 'dry_run', userMessage: '' }
  if (text.startsWith('plano ')) {
    return {
      kind: 'dry_run',
      userMessage: String(userMessage || '').trim().replace(/^plano\s+/i, '').trim()
    }
  }
  return null
}

function stopDecision (userMessage) {
  return makePlannerDecision({
    intent: 'execute_skill',
    userGoal: String(userMessage || '').trim() || 'parar',
    nextAction: { skill: 'movement.stop', args: {} },
    reasonSummary: 'Usuario pediu para parar.',
    risk: 'low',
    confidence: 1,
    stopAfterThis: true
  })
}

function parsePlannerDiagnosticCommand (userMessage) {
  const text = normalizeDiagnosticText(userMessage)
  if (text === 'llm' || text === 'modelo') return { kind: 'llm' }
  if (text === 'perfil') return { kind: 'profile' }
  if (text.startsWith('perfil ')) return { kind: 'set_profile', value: text.slice('perfil '.length).trim() }
  if (text === 'provider') return { kind: 'provider' }
  if (text.startsWith('provider ')) return { kind: 'set_provider', value: text.slice('provider '.length).trim() }
  return null
}

function isLlmDiagnosticCommand (userMessage) {
  return Boolean(parsePlannerDiagnosticCommand(userMessage))
}

function maskUrl (rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.username = url.username ? '***' : ''
    url.password = url.password ? '***' : ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return String(rawUrl || '')
  }
}

async function checkOllamaStatus ({ profile, fetch = globalThis.fetch, timeoutMs = 600 } = {}) {
  if (typeof fetch !== 'function') return 'indisponivel (fetch nativo ausente)'

  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const baseUrl = String(profile?.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller?.signal
    })
    return response?.ok ? `online (HTTP ${response.status})` : `indisponivel (HTTP ${response?.status || 'sem status'})`
  } catch (error) {
    return error.name === 'AbortError'
      ? `indisponivel (timeout ${timeoutMs}ms)`
      : `indisponivel (${error.message})`
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function describePlannerProvider (context = {}, env = process.env, options = {}) {
  const config = context.config || {}
  const provider = getPlannerProvider(config, env)
  const profile = getLocalLlmProfile(config, env)
  const fallbackProvider = configuredFallbackProviderName(config, env) || 'nenhum'
  const providerKind = provider.name === 'mock'
    ? 'mock'
    : provider.name === 'ollama'
      ? 'local'
      : 'local_deterministico'
  const ollamaStatus = await checkOllamaStatus({ profile, fetch: options.fetch, timeoutMs: options.timeoutMs })

  return [
    `provider=${provider.name}`,
    `fallback=${fallbackProvider}`,
    `tipo=${providerKind}`,
    `modelo=${profile.model}`,
    `perfil=${profile.name}`,
    `num_ctx=${profile.numCtx}`,
    `max_output_tokens=${profile.maxOutputTokens}`,
    `timeout_ms=${profile.timeoutMs}`,
    `url=${maskUrl(profile.baseUrl)}`,
    `ollama=${ollamaStatus}`
  ].join(' | ')
}

function describeProfileCommand (context = {}, env = process.env) {
  const profile = getLocalLlmProfile(context.config || {}, env)
  return [
    `perfil=${profile.name}`,
    `modelo=${profile.model}`,
    `num_ctx=${profile.numCtx}`,
    `max_output_tokens=${profile.maxOutputTokens}`,
    `timeout_ms=${profile.timeoutMs}`,
    `keep_alive=${profile.keepAlive}`
  ].join(' | ')
}

function describeProviderCommand (context = {}, env = process.env) {
  const provider = getPlannerProvider(context.config || {}, env)
  const fallbackProvider = configuredFallbackProviderName(context.config || {}, env) || 'nenhum'
  return [
    `provider=${provider.name}`,
    `fallback=${fallbackProvider}`,
    `tipo=${provider.local ? 'local' : 'desconhecido'}`
  ].join(' | ')
}

function runtimeChangeResponse (diagnostic, context = {}, env = process.env) {
  if (diagnostic.kind === 'set_profile') {
    const resolved = resolveProfileName(diagnostic.value)
    if (!LOCAL_LLM_PROFILES[resolved]) {
      return `Bot: perfil desconhecido: ${diagnostic.value}. Use economia, equilibrio ou performance.`
    }
    return `Bot: perfil ${resolved} e valido, mas alteracao em runtime esta desativada por seguranca. Reinicie com MINEGPT_AI_PROFILE=${resolved}.`
  }

  if (diagnostic.kind === 'set_provider') {
    const providerName = normalizeProviderName(diagnostic.value)
    if (!PROVIDERS[providerName]) {
      return `Bot: provider desconhecido: ${diagnostic.value}. Use mock, rule_based ou ollama.`
    }
    return `Bot: provider ${providerName} e valido, mas alteracao em runtime esta desativada por seguranca. Reinicie com MINEGPT_AI_PROVIDER=${providerName}.`
  }

  if (diagnostic.kind === 'profile') return `Bot: ${describeProfileCommand(context, env)}`
  if (diagnostic.kind === 'provider') return `Bot: ${describeProviderCommand(context, env)}`
  return null
}

function clearPendingConfirmation (context = {}) {
  context.plannerPendingConfirmation = null
}

function pendingIsExpired (pending, now = Date.now()) {
  return !pending || Number(pending.expiresAt || 0) <= now
}

function createPendingConfirmation (run, now = Date.now(), ttlMs = DEFAULT_CONFIRMATION_TTL_MS) {
  const action = run.confirmation?.action || run.decision?.nextAction
  return {
    type: 'planner_confirmation',
    createdAt: now,
    expiresAt: now + ttlMs,
    userMessage: String(run.confirmation?.userMessage || run.decision?.userGoal || '').slice(0, 160),
    action: action
      ? {
          skill: action.skill,
          args: action.args || {}
        }
      : null,
    signature: actionSignature(action),
    reasonSummary: String(run.confirmation?.reasonSummary || run.decision?.reasonSummary || '').slice(0, 200),
    reasons: Array.isArray(run.confirmation?.reasons) ? run.confirmation.reasons.slice(0, 5) : [],
    risk: run.confirmation?.risk || run.plan?.risk || run.decision?.risk || 'low'
  }
}

function formatConfirmationPrompt (pending) {
  const reasons = pending.reasons?.length ? pending.reasons.join(', ') : 'acao sensivel'
  return `Bot: isso exige confirmacao (${reasons}). Eu faria ${pending.action.skill} com args ${formatArgs(pending.action.args)}. Confirme com "bot confirmar" ou cancele com "bot cancelar".`
}

async function confirmPendingPlannerAction ({
  context = {},
  survivalGuard,
  now = Date.now()
}) {
  const pending = context.plannerPendingConfirmation
  if (!pending) {
    return {
      ok: false,
      status: 'confirmation_missing',
      chat: 'Bot: nao ha acao pendente para confirmar.'
    }
  }

  if (pendingIsExpired(pending, now)) {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'confirmation_expired',
      chat: 'Bot: a confirmacao expirou. Envie o pedido novamente.'
    }
  }

  if (!pending.action || actionSignature(pending.action) !== pending.signature) {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'confirmation_invalid',
      chat: 'Bot: acao pendente invalida. Envie o pedido novamente.'
    }
  }

  if (context.activeSkill) {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'active_skill_blocked',
      chat: `Bot: nao vou confirmar agora — ja estou executando ${context.activeSkill.name}.`
    }
  }

  const survivalStatus = typeof survivalGuard?.assess === 'function' ? survivalGuard.assess() : null
  const severity = normalizeSeverityLevel(survivalStatus)
  if (severity === 'high' || severity === 'critical') {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'survival_blocked',
      chat: `Bot: nao vou confirmar agora — survival ${severity}.`
    }
  }

  const skillRegistry = context.skillRegistry
  if (!skillRegistry || typeof skillRegistry.get !== 'function' || typeof skillRegistry.plan !== 'function' || typeof skillRegistry.execute !== 'function') {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'registry_unavailable',
      chat: 'Bot: skillRegistry indisponivel para confirmar acao.'
    }
  }

  const plannedSkill = skillRegistry.get(pending.action.skill)
  if (!plannedSkill) {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'unknown_skill',
      chat: `Bot: skill pendente nao existe mais: ${pending.action.skill}.`
    }
  }

  const executionContext = {
    plannerMode: true,
    explicitUserIntent: true,
    confirmedPlannerAction: true
  }
  const plan = await skillRegistry.plan(pending.action.skill, pending.action.args, executionContext)
  if (!plan.ok) {
    clearPendingConfirmation(context)
    return {
      ok: false,
      status: 'plan_failed',
      plan,
      chat: `Bot: nao vou executar a acao confirmada — ${plan.reason || plan.code || 'plan falhou'}.`
    }
  }

  clearPendingConfirmation(context)
  const result = await skillRegistry.execute(pending.action.skill, pending.action.args, executionContext)
  return {
    ok: Boolean(result.ok),
    status: result.ok ? 'completed' : result.retryable ? 'execute_failed_retryable' : 'execute_failed',
    plan,
    result,
    chat: `Bot: ${summarizeActionResult(result)}`
  }
}

async function runPlannerCommand ({
  userMessage,
  context,
  survivalGuard,
  history = [],
  maxSteps = 1,
  dryRun = false,
  allowedRisks = ['low', 'medium'],
  decide = undefined,
  env = process.env,
  diagnosticFetch = globalThis.fetch,
  now = Date.now(),
  confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS
}) {
  traceLog(env, 'user_message', { userMessage })
  const control = parsePlannerControlCommand(userMessage)
  if (control?.kind === 'stop') {
    if (context?.plannerDecisionAbortController && !context.plannerDecisionAbortController.signal?.aborted) {
      context.plannerDecisionAbortController.abort()
    }
    clearPendingConfirmation(context)
    const stopRun = await runPlannerCycles({
      userMessage,
      context,
      survivalGuard,
      history,
      maxSteps: 1,
      dryRun: false,
      allowedRisks,
      decide: async () => stopDecision(userMessage),
      requireConfirmation: false,
      env
    })
    return plannerChatResponse(
      stopRun,
      stopRun.ok
        ? `Bot: ${summarizeActionResult(stopRun.result)}`
        : `Bot: não consegui parar via planner — ${stopRun.reason || stopRun.status}.`,
      env
    )
  }

  if (control?.kind === 'confirm') {
    const confirmed = await confirmPendingPlannerAction({ context, survivalGuard, now })
    return plannerChatResponse(confirmed, confirmed.chat, env)
  }

  if (control?.kind === 'confirm_extra') {
    return plannerChatResponse({
      ok: false,
      status: 'confirmation_invalid',
    }, 'Bot: use apenas "bot confirmar" para confirmar a acao pendente atual.', env)
  }

  if (control?.kind === 'cancel') {
    const hadPending = Boolean(context?.plannerPendingConfirmation)
    clearPendingConfirmation(context)
    return plannerChatResponse({
      ok: true,
      status: 'confirmation_cancelled',
    }, hadPending ? 'Bot: acao pendente cancelada.' : 'Bot: nao havia acao pendente.', env)
  }

  if (control?.kind === 'dry_run') {
    if (!control.userMessage) {
      return plannerChatResponse({
        ok: false,
        status: 'dry_run_empty',
      }, 'Bot: use "bot plano <pedido>".', env)
    }

    const dryRunResult = await runPlannerCycles({
      userMessage: control.userMessage,
      context,
      survivalGuard,
      history,
      maxSteps,
      dryRun: true,
      allowedRisks,
      decide,
      env
    })

    if (dryRunResult.status === 'dry_run') {
      return plannerChatResponse(dryRunResult, `Bot: plano — ${summarizePlan(dryRunResult)}. Nada foi executado.`, env)
    }

    return plannerChatResponse(
      dryRunResult,
      dryRunResult.ok
        ? `Bot: plano — ${dryRunResult.reason || 'concluido sem executar'}.`
        : `Bot: nao consegui montar um plano — ${dryRunResult.reason || dryRunResult.status}.`,
      env
    )
  }

  const diagnostic = parsePlannerDiagnosticCommand(userMessage)
  if (diagnostic) {
    const chat = diagnostic.kind === 'llm'
      ? `Bot: ${await describePlannerProvider(context, env, { fetch: diagnosticFetch })}`
      : runtimeChangeResponse(diagnostic, context, env)

    return plannerChatResponse({
      ok: true,
      status: 'llm_diagnostic',
      reason: 'diagnostico local de planner',
      steps: 0,
      history: [],
      decision: null,
      plan: null,
      result: null
    }, chat, env)
  }

  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  if (controller && context) context.plannerDecisionAbortController = controller
  let run
  try {
    run = await runPlannerCycles({
      userMessage,
      context,
      survivalGuard,
      history,
      maxSteps,
      dryRun,
      allowedRisks,
      decide,
      requireConfirmation: !dryRun,
      env,
      signal: controller?.signal
    })
  } finally {
    if (controller && context?.plannerDecisionAbortController === controller) {
      context.plannerDecisionAbortController = null
    }
  }

  if (run.status === 'ask_user') {
    return plannerChatResponse(run, `Bot: ${run.reason || 'Preciso de mais informacao.'}`, env)
  }

  if (run.status === 'completed' || run.status === 'max_steps_reached') {
    return plannerChatResponse(run, `Bot: ${summarizeActionResult(run.result)}`, env)
  }

  if (run.status === 'dry_run') {
    return plannerChatResponse(run, `Bot: feito — ${run.reason}.`, env)
  }

  if (run.status === 'confirmation_required') {
    const pending = createPendingConfirmation(run, now, confirmationTtlMs)
    if (!pending.action) {
      return plannerChatResponse(run, 'Bot: acao sensivel sem detalhes suficientes; nao vou executar.', env)
    }
    context.plannerPendingConfirmation = pending
    return plannerChatResponse(run, formatConfirmationPrompt(pending), env)
  }

  if (run.status === 'execute_failed' || run.status === 'execute_failed_retryable') {
    return plannerChatResponse(run, `Bot: ${summarizeActionResult(run.result)}`, env)
  }

  if (run.status === 'stopped') {
    return plannerChatResponse(run, `Bot: ${run.reason || 'parando.'}`, env)
  }

  if (run.status === 'refused') {
    return plannerChatResponse(run, `Bot: não vou fazer isso agora — ${run.reason || 'pedido recusado'}.`, env)
  }

  if (run.status === 'invalid_decision' || run.status === 'unknown_skill') {
    return plannerChatResponse(run, `Bot: não consegui montar uma ação válida — ${run.reason}.`, env)
  }

  if (run.status === 'plan_failed') {
    return plannerChatResponse(run, `Bot: não vou fazer isso agora — ${run.reason}.`, env)
  }

  if (run.status === 'active_skill_blocked' || run.status === 'survival_blocked' || run.status === 'risk_blocked' || run.status === 'repetition_blocked') {
    return plannerChatResponse(run, `Bot: não vou fazer isso agora — ${run.reason}.`, env)
  }

  return plannerChatResponse(
    run,
    run.ok ? `Bot: feito — ${run.reason}.` : `Bot: não consegui — ${run.reason || run.status}.`,
    env
  )
}

module.exports = {
  parseBotCommand,
  parsePlannerControlCommand,
  runPlannerCommand,
  summarizeActionResult,
  survivalBlocksPlan,
  isLlmDiagnosticCommand,
  parsePlannerDiagnosticCommand,
  describePlannerProvider,
  checkOllamaStatus,
  confirmPendingPlannerAction,
  createPendingConfirmation,
  DEFAULT_CONFIRMATION_TTL_MS
}
