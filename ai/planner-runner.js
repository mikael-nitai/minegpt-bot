const { decideNextAction } = require('./planner')
const { validatePlannerDecision, validatePlannerDecisionStructure } = require('./planner-schema')
const { skillRegistryToPlannerTools } = require('./tool-adapter')
const { getSkillsCacheTtlMs } = require('./planner-limits')
const { normalizePlannerDecisionArgs } = require('./argument-normalizer')
const { traceLog } = require('./providers/provider-utils')

const DEFAULT_ALLOWED_RISKS = ['low', 'medium']
const DEFAULT_MAX_STEPS = 1
const HARD_MAX_STEPS = 3
const DEFAULT_RECOVERY_MODE = 'local'
const VALID_RECOVERY_MODES = new Set(['off', 'local', 'llm'])
const DEFAULT_SEMANTIC_GUARD_MODE = 'warn'
const VALID_SEMANTIC_GUARD_MODES = new Set(['off', 'warn', 'strict'])
const VALUABLE_ITEM_NAMES = new Set([
  'diamond',
  'emerald',
  'netherite_scrap',
  'netherite_ingot',
  'ancient_debris',
  'gold_ingot',
  'raw_gold',
  'gold_block',
  'diamond_block',
  'emerald_block',
  'elytra',
  'totem_of_undying',
  'enchanted_golden_apple'
])

function normalizeUserIntentText (text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasIntentTerm (text, terms) {
  const padded = ` ${text} `
  return terms.some(term => padded.includes(` ${term} `))
}

function classifyUserIntentForGuard (userMessage) {
  const text = normalizeUserIntentText(userMessage)
  if (!text) return 'unknown'

  if (
    text.includes('vem aqui') ||
    text.includes('venha aqui') ||
    text.includes('venha ate mim') ||
    text.includes('vem para mim') ||
    text.includes('vem pra mim') ||
    hasIntentTerm(text, ['seguir', 'siga', 'acompanhe', 'acompanhar']) ||
    text.includes('para frente') ||
    text.includes('pra frente') ||
    text.includes('andar') ||
    text.includes('caminhar') ||
    text.includes('caminhe') ||
    text.includes('va para frente') ||
    text.includes('vai para frente')
  ) {
    return 'movement'
  }

  if (hasIntentTerm(text, ['pare', 'para', 'parar', 'cancela', 'cancelar', 'interrompe', 'interromper'])) {
    return 'stop'
  }

  if (hasIntentTerm(text, ['estado', 'status', 'inventario', 'posicao', 'diagnostico'])) return 'state'
  if (hasIntentTerm(text, ['guarda', 'guardar', 'deposita', 'depositar'])) return 'deposit'
  if (hasIntentTerm(text, ['procura', 'procurar', 'busca', 'buscar'])) return 'search'
  if (hasIntentTerm(text, ['crafta', 'craftar', 'crafte', 'faca', 'faz', 'fazer'])) return 'craft'
  if (hasIntentTerm(text, ['coleta', 'coletar', 'pegue', 'pega', 'pegar', 'minera', 'minerar', 'quebra', 'quebrar', 'corta', 'cortar'])) return 'collect'

  return 'unknown'
}

function semanticGuardForDecision (userMessage, decision) {
  if (decision?.intent !== 'execute_skill' || !decision.nextAction?.skill) return null

  const intent = classifyUserIntentForGuard(userMessage)
  const skill = decision.nextAction.skill
  const mismatches = {
    movement: new Set(['movement.stop', 'collection.collect', 'drops.collect', 'crafting.craft', 'containers.deposit', 'containers.search', 'containers.withdraw', 'blocks.place', 'inventory.drop']),
    stop: new Set(['collection.collect', 'drops.collect', 'crafting.craft', 'containers.deposit', 'containers.search', 'containers.withdraw', 'blocks.place', 'inventory.drop']),
    state: new Set(['collection.collect', 'drops.collect', 'crafting.craft', 'containers.deposit', 'containers.withdraw', 'blocks.place', 'inventory.drop']),
    deposit: new Set(['collection.collect', 'drops.collect', 'crafting.craft', 'movement.come_here', 'movement.follow_owner', 'movement.go_to', 'blocks.place', 'inventory.drop']),
    search: new Set(['collection.collect', 'drops.collect', 'crafting.craft', 'movement.come_here', 'movement.follow_owner', 'movement.go_to', 'containers.deposit', 'blocks.place', 'inventory.drop']),
    craft: new Set(['collection.collect', 'drops.collect', 'containers.deposit', 'containers.search', 'containers.withdraw', 'movement.come_here', 'movement.follow_owner', 'movement.go_to', 'blocks.place', 'inventory.drop']),
    collect: new Set(['containers.deposit', 'containers.search', 'containers.withdraw', 'movement.come_here', 'movement.follow_owner', 'movement.go_to', 'blocks.place', 'inventory.drop'])
  }

  if (mismatches[intent]?.has(skill)) {
    return `decisao incoerente com o pedido: intent=${intent} skill=${skill}`
  }

  return null
}

function normalizeSemanticGuardMode (mode) {
  const normalized = String(mode || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  return VALID_SEMANTIC_GUARD_MODES.has(normalized) ? normalized : DEFAULT_SEMANTIC_GUARD_MODE
}

function configuredSemanticGuardMode (config = {}, env = process.env) {
  return normalizeSemanticGuardMode(
    env.MINEGPT_AI_SEMANTIC_GUARD ||
    config.ai?.semanticGuard ||
    config.ai?.semantic_guard ||
    config.semanticGuard ||
    DEFAULT_SEMANTIC_GUARD_MODE
  )
}

function compactDecision (decision) {
  if (!decision) return null
  return {
    intent: decision.intent,
    userGoal: decision.userGoal,
    nextAction: decision.nextAction
      ? {
          skill: decision.nextAction.skill,
          args: decision.nextAction.args
        }
      : null,
    reasonSummary: decision.reasonSummary,
    risk: decision.risk,
    confidence: decision.confidence,
    stopAfterThis: decision.stopAfterThis
  }
}

function debugEnabled (env = process.env) {
  return env.MINEGPT_AI_DEBUG === '1'
}

function debugLog (env, event, details) {
  if (!debugEnabled(env)) return
  console.log(`[minegpt-ai] ${event}: ${JSON.stringify(details)}`)
}

function compactActionResult (result) {
  if (!result) return null
  return {
    ok: Boolean(result.ok),
    skill: result.skill,
    code: result.code,
    message: result.message,
    reason: result.reason,
    retryable: Boolean(result.retryable),
    worldChanged: Boolean(result.worldChanged),
    missingRequirements: Array.isArray(result.missingRequirements) ? result.missingRequirements.slice(0, 5) : [],
    suggestedNextActions: Array.isArray(result.suggestedNextActions) ? result.suggestedNextActions.slice(0, 5) : []
  }
}

function compactPlan (plan) {
  if (!plan) return null
  return {
    ok: Boolean(plan.ok),
    skill: plan.skill,
    code: plan.code,
    reason: plan.reason,
    risk: plan.risk,
    effects: Array.isArray(plan.effects) ? plan.effects : [],
    missingRequirements: Array.isArray(plan.missingRequirements) ? plan.missingRequirements.slice(0, 5) : []
  }
}

function safePlannerState (context) {
  try {
    if (typeof context.stateReporter?.getPlannerSnapshot === 'function') return context.stateReporter.getPlannerSnapshot()
  } catch (error) {
    return {
      online: Boolean(context?.bot),
      activeSkill: context?.activeSkill?.name || null,
      snapshotError: error.message
    }
  }

  return {
    online: Boolean(context?.bot),
    activeSkill: context?.activeSkill?.name || null
  }
}

function plannerSkillsForContext (context = {}, env = process.env, now = Date.now()) {
  const skillRegistry = context.skillRegistry
  const ttlMs = getSkillsCacheTtlMs(context.config || {}, env)
  if (ttlMs <= 0) return skillRegistryToPlannerTools(skillRegistry)

  const cache = context.plannerSkillsCache
  if (cache && cache.registry === skillRegistry && Number(cache.expiresAt || 0) > now && Array.isArray(cache.skills)) {
    return cache.skills
  }

  const skills = skillRegistryToPlannerTools(skillRegistry)
  context.plannerSkillsCache = {
    registry: skillRegistry,
    expiresAt: now + ttlMs,
    skills
  }
  return skills
}

function normalizeSeverityLevel (survivalStatus) {
  const severity = survivalStatus?.severity
  if (typeof severity === 'number') {
    if (severity >= 85) return 'critical'
    if (severity >= 65) return 'high'
    if (severity >= 35) return 'medium'
    return 'low'
  }

  return typeof severity === 'string' ? severity : 'low'
}

function survivalBlocksPlan (survivalStatus, plannedSkill) {
  if (!survivalStatus || !plannedSkill) return null
  const severity = normalizeSeverityLevel(survivalStatus)
  if (severity !== 'critical' && severity !== 'high') return null
  if (plannedSkill.id === 'movement.stop' || plannedSkill.risk === 'low') return null
  return `survival ${severity}: ${survivalStatus.top?.reason || survivalStatus.top || survivalStatus.summary || 'risco alto'}`
}

function actionSignature (action) {
  if (!action) return ''
  return `${action.skill}:${JSON.stringify(canonicalActionArgs(action))}`
}

function canonicalActionArgs (action) {
  const args = action?.args && typeof action.args === 'object' && !Array.isArray(action.args) ? { ...action.args } : {}
  if (action?.skill === 'movement.stop') return {}
  if ((action?.skill === 'crafting.craft' || action?.skill === 'collection.collect' || action?.skill === 'containers.withdraw') && args.target && args.count == null) {
    args.count = 1
  }
  if (action?.skill === 'containers.deposit' && args.mode && args.mode !== 'target') {
    return { mode: args.mode }
  }
  return args
}

function failureSignature (action, code) {
  return `${actionSignature(action)}:${code || 'error'}`
}

function normalizeRecoveryMode (mode) {
  const normalized = String(mode || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  return VALID_RECOVERY_MODES.has(normalized) ? normalized : DEFAULT_RECOVERY_MODE
}

function configuredRecoveryMode (config = {}, env = process.env) {
  return normalizeRecoveryMode(
    env.MINEGPT_AI_RECOVERY ||
    config.ai?.recovery ||
    config.ai?.recoveryMode ||
    config.ai?.recovery_mode ||
    config.recovery ||
    DEFAULT_RECOVERY_MODE
  )
}

function normalizedText (value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function argsMentionValuableItem (args = {}) {
  const text = normalizedText(JSON.stringify(args || {}))
  return [...VALUABLE_ITEM_NAMES].some(item => text.includes(item))
}

function actionRequiresConfirmation ({ skill, args = {}, plan = null } = {}) {
  const reasons = []
  const skillId = skill?.id || plan?.skill || ''
  const risk = skill?.risk || plan?.risk || 'low'
  const plannedArgs = plan?.args && typeof plan.args === 'object' ? plan.args : args

  if (risk === 'high') reasons.push('risco alto')
  if (skillId === 'inventory.drop') reasons.push('remove itens do inventario')
  if (skillId === 'containers.deposit' && plannedArgs.mode === 'all') reasons.push('pode mexer em muitos itens')
  if (skillId === 'blocks.place' && (plannedArgs.mode === 'coords' || plannedArgs.coords)) reasons.push('altera o mundo em coordenadas')
  if (skillId === 'movement.go_to') reasons.push('move o bot para coordenadas')
  if (skill?.requiresConfirmation || skill?.sensitive) reasons.push('skill marcada como sensivel')
  if (Array.isArray(skill?.effects) && skill.effects.some(effect => /destrut|destruct|danger/i.test(String(effect)))) reasons.push('efeito destrutivo')
  if (argsMentionValuableItem(plannedArgs)) reasons.push('envolve item valioso')

  return {
    required: reasons.length > 0,
    reasons: [...new Set(reasons)]
  }
}

function compactConfirmationRequest ({ userMessage, decision, plan, skill, reasons }) {
  return {
    userMessage: String(userMessage || '').slice(0, 160),
    action: decision?.nextAction
      ? {
          skill: decision.nextAction.skill,
          args: decision.nextAction.args || {}
        }
      : null,
    reasonSummary: String(decision?.reasonSummary || '').slice(0, 200),
    risk: skill?.risk || plan?.risk || decision?.risk || 'low',
    plan: compactPlan(plan),
    reasons: Array.isArray(reasons) ? reasons.slice(0, 5) : []
  }
}

function suggestedActionPriority (suggestion) {
  if (suggestion.skill === 'containers.withdraw') return 1
  if (suggestion.skill === 'collection.collect') return 2
  if (suggestion.skill === 'crafting.craft') return 3
  return 99
}

function normalizeSuggestedAction (suggestion) {
  if (!suggestion || suggestion.type !== 'skill') return null
  if (typeof suggestion.skill !== 'string' || suggestion.skill.trim().length === 0) return null
  if (suggestion.args != null && (typeof suggestion.args !== 'object' || Array.isArray(suggestion.args))) return null

  return {
    skill: suggestion.skill,
    args: suggestion.args || {},
    reason: typeof suggestion.reason === 'string' ? suggestion.reason : ''
  }
}

function chooseLocalRecoveryAction (suggestions = [], blockedSignatures = new Set()) {
  const candidates = suggestions
    .map(normalizeSuggestedAction)
    .filter(Boolean)
    .filter(action => !blockedSignatures.has(actionSignature(action)))
    .map(action => ({ action, priority: suggestedActionPriority(action) }))
    .filter(candidate => candidate.priority < 99)
    .sort((a, b) => a.priority - b.priority)

  if (candidates.length === 0) {
    return { action: null, status: 'none', reason: 'nenhuma sugestao local segura' }
  }

  const topPriority = candidates[0].priority
  const top = candidates.filter(candidate => candidate.priority === topPriority)
  const topSignatures = new Set(top.map(candidate => actionSignature(candidate.action)))
  if (topSignatures.size > 1) {
    return { action: null, status: 'ambiguous', reason: 'sugestoes locais ambiguas' }
  }

  return { action: top[0].action, status: 'selected', reason: top[0].action.reason || 'sugestao local selecionada' }
}

function normalizeMaxSteps (maxSteps) {
  const parsed = Number(maxSteps)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_STEPS
  return Math.min(parsed, HARD_MAX_STEPS)
}

function stopRun ({ status, reason, steps, history, decision = null, plan = null, result = null, ok = false, confirmation = null }) {
  return {
    ok,
    status,
    reason,
    steps,
    history,
    decision,
    plan,
    result,
    confirmation
  }
}

async function planRecoveryAction ({
  action,
  skillRegistry,
  safeContext,
  survivalGuard,
  allowedRiskSet,
  repeatedActions,
  executionContext,
  requireConfirmation
}) {
  const plannedSkill = skillRegistry.get(action.skill)
  if (!plannedSkill) return { ok: false, status: 'recovery_invalid', reason: `skill sugerida inexistente: ${action.skill}` }

  if (!allowedRiskSet.has(plannedSkill.risk || 'low')) {
    return { ok: false, status: 'recovery_risk_blocked', reason: `risco ${plannedSkill.risk} nao permitido na recuperacao` }
  }

  if (safeContext.activeSkill && action.skill !== 'movement.stop') {
    return { ok: false, status: 'recovery_active_skill_blocked', reason: `ja estou executando ${safeContext.activeSkill.name}` }
  }

  const survivalStatus = typeof survivalGuard?.assess === 'function' ? survivalGuard.assess() : null
  const survivalBlockReason = survivalBlocksPlan(survivalStatus, plannedSkill)
  if (survivalBlockReason) {
    return { ok: false, status: 'recovery_survival_blocked', reason: survivalBlockReason }
  }

  const signature = actionSignature(action)
  if (repeatedActions.has(signature)) {
    return { ok: false, status: 'recovery_repetition_blocked', reason: `acao sugerida repetida bloqueada: ${action.skill}` }
  }

  const plan = await skillRegistry.plan(action.skill, action.args, executionContext)
  if (!plan.ok) {
    return { ok: false, status: 'recovery_plan_failed', reason: plan.reason || plan.code || 'plan de recuperacao falhou', plan }
  }

  const confirmation = actionRequiresConfirmation({ skill: plannedSkill, args: action.args, plan })
  if (requireConfirmation && confirmation.required) {
    return {
      ok: false,
      status: 'recovery_confirmation_blocked',
      reason: `recuperacao sensivel exige confirmacao: ${confirmation.reasons.join(', ')}`,
      plan
    }
  }

  return { ok: true, status: 'recovery_planned', reason: 'recuperacao local planejada', plan, plannedSkill }
}

async function runPlannerCycles ({
  userMessage,
  context,
  survivalGuard,
  history = [],
  maxSteps = DEFAULT_MAX_STEPS,
  dryRun = false,
  allowedRisks = DEFAULT_ALLOWED_RISKS,
  decide = decideNextAction,
  requireConfirmation = false,
  env = process.env,
  signal = undefined
}) {
  const safeContext = context || {}
  const skillRegistry = safeContext.skillRegistry
  if (!skillRegistry || typeof skillRegistry.get !== 'function' || typeof skillRegistry.plan !== 'function' || typeof skillRegistry.execute !== 'function') {
    return stopRun({
      status: 'registry_unavailable',
      reason: 'skillRegistry indisponivel para planner',
      steps: 0,
      history: Array.isArray(history) ? history.slice(-5) : []
    })
  }

  const skills = plannerSkillsForContext(safeContext, env)
  const allowedRiskSet = new Set(allowedRisks)
  const stepLimit = normalizeMaxSteps(maxSteps)
  const recoveryMode = configuredRecoveryMode(safeContext.config || {}, env)
  const semanticGuardMode = configuredSemanticGuardMode(safeContext.config || {}, env)
  const runHistory = Array.isArray(history) ? history.slice(-5) : []
  const repeatedActions = new Set()
  const failedActionSignatures = new Set()
  const failedActions = new Set()
  let latestDecision = null
  let latestPlan = null
  let latestResult = null

  for (let step = 1; step <= stepLimit; step++) {
    const plannerState = safePlannerState(safeContext)
    const rawDecision = await decide({
      userMessage,
      plannerState,
      skills,
      history: runHistory,
      config: safeContext.config || {},
      signal
    })
    debugLog(env, 'decision_raw', {
      intent: rawDecision?.intent,
      skill: rawDecision?.nextAction?.skill || null,
      args: rawDecision?.nextAction?.args || null,
      provider: rawDecision?.planner?.mode || null,
      fallback: rawDecision?.planner?.providerFallback || null
    })
    traceLog(env, 'decision_from_provider', {
      decision: compactDecision(rawDecision),
      provider: rawDecision?.planner?.mode || null,
      fallback: rawDecision?.planner?.providerFallback || null
    })

    const rawValidation = validatePlannerDecisionStructure(rawDecision, { skills, plannerState })
    traceLog(env, 'validation_initial', { ok: rawValidation.ok, errors: rawValidation.errors })
    const canAttemptNormalization = rawDecision?.intent === 'execute_skill' &&
      rawDecision.nextAction &&
      typeof rawDecision.nextAction.skill === 'string' &&
      rawDecision.nextAction.skill.trim().length > 0
    if (!rawValidation.ok && !canAttemptNormalization) {
      runHistory.push({ step, decision: compactDecision(rawDecision), status: 'invalid_decision', reason: rawValidation.errors.join('; ') })
      return stopRun({ status: 'invalid_decision', reason: rawValidation.errors.join('; '), steps: step, history: runHistory, decision: rawDecision })
    }

    const normalization = normalizePlannerDecisionArgs(rawDecision, {
      skills,
      plannerState,
      catalog: safeContext.catalog || safeContext.minecraftCatalog || null
    })
    const decision = normalization.decision
    if (decision?.planner) {
      decision.planner = {
        ...decision.planner,
        argumentNormalization: {
          changed: normalization.changed,
          warnings: normalization.warnings,
          recoverableErrors: normalization.recoverableErrors,
          fatalErrors: normalization.fatalErrors
        }
      }
    }
    latestDecision = decision

    debugLog(env, 'decision_normalized', {
      changed: normalization.changed,
      warnings: normalization.warnings,
      recoverableErrors: normalization.recoverableErrors,
      fatalErrors: normalization.fatalErrors,
      skill: decision?.nextAction?.skill || null,
      args: decision?.nextAction?.args || null
    })
    traceLog(env, 'decision_normalized', {
      decision: compactDecision(decision),
      changed: normalization.changed,
      warnings: normalization.warnings,
      recoverableErrors: normalization.recoverableErrors,
      fatalErrors: normalization.fatalErrors
    })

    if (normalization.fatalErrors.length > 0) {
      const reason = normalization.fatalErrors.join('; ')
      runHistory.push({ step, decision: compactDecision(decision), status: 'invalid_decision', reason })
      return stopRun({ status: 'invalid_decision', reason, steps: step, history: runHistory, decision })
    }

    const validation = validatePlannerDecision(decision, { skills, plannerState })
    traceLog(env, 'validation_final', { ok: validation.ok, errors: validation.errors })
    if (!validation.ok) {
      runHistory.push({ step, decision: compactDecision(decision), status: 'invalid_decision', reason: validation.errors.join('; ') })
      return stopRun({ status: 'invalid_decision', reason: validation.errors.join('; '), steps: step, history: runHistory, decision })
    }

    if (decision.intent === 'ask_user') {
      const reason = decision.askUser || 'planner pediu esclarecimento'
      runHistory.push({ step, decision: compactDecision(decision), status: 'ask_user', reason })
      return stopRun({ status: 'ask_user', reason, steps: step, history: runHistory, decision })
    }

    if (decision.intent === 'refuse') {
      const reason = decision.reasonSummary || 'planner recusou o pedido'
      runHistory.push({ step, decision: compactDecision(decision), status: 'refused', reason })
      return stopRun({ status: 'refused', reason, steps: step, history: runHistory, decision })
    }

    if (decision.intent === 'stop') {
      const reason = decision.reasonSummary || 'planner parou sem acao'
      runHistory.push({ step, decision: compactDecision(decision), status: 'stopped', reason })
      return stopRun({ status: 'stopped', reason, steps: step, history: runHistory, decision, ok: true })
    }

    const nextAction = decision.nextAction
    const rawSemanticGuardReason = semanticGuardForDecision(userMessage, decision)
    const semanticGuardReason = semanticGuardMode === 'off' ? null : rawSemanticGuardReason
    const semanticGuardResult = {
      mode: semanticGuardMode,
      ok: !semanticGuardReason,
      warning: semanticGuardMode === 'warn' ? semanticGuardReason || null : null,
      blocked: Boolean(semanticGuardReason && semanticGuardMode === 'strict'),
      reason: semanticGuardReason || null
    }
    traceLog(env, 'semantic_guard', semanticGuardResult)
    if (semanticGuardReason) {
      if (decision?.planner) {
        decision.planner = {
          ...decision.planner,
          semanticGuard: semanticGuardResult
        }
      }
      if (semanticGuardMode === 'strict') {
        runHistory.push({ step, decision: compactDecision(decision), status: 'invalid_decision', reason: semanticGuardReason })
        return stopRun({ status: 'invalid_decision', reason: semanticGuardReason, steps: step, history: runHistory, decision })
      }
    }

    const plannedSkill = skillRegistry.get(nextAction.skill)
    if (!plannedSkill) {
      const reason = `skill inexistente: ${nextAction.skill}`
      runHistory.push({ step, decision: compactDecision(decision), status: 'unknown_skill', reason })
      return stopRun({ status: 'unknown_skill', reason, steps: step, history: runHistory, decision })
    }

    if (!requireConfirmation && !allowedRiskSet.has(plannedSkill.risk || 'low')) {
      const reason = `risco ${plannedSkill.risk} nao permitido neste runner`
      runHistory.push({ step, decision: compactDecision(decision), status: 'risk_blocked', reason })
      return stopRun({ status: 'risk_blocked', reason, steps: step, history: runHistory, decision })
    }

    if (safeContext.activeSkill && nextAction.skill !== 'movement.stop') {
      const reason = `ja estou executando ${safeContext.activeSkill.name}`
      runHistory.push({ step, decision: compactDecision(decision), status: 'active_skill_blocked', reason })
      return stopRun({ status: 'active_skill_blocked', reason, steps: step, history: runHistory, decision })
    }

    const survivalStatus = typeof survivalGuard?.assess === 'function' ? survivalGuard.assess() : null
    const survivalBlockReason = survivalBlocksPlan(survivalStatus, plannedSkill)
    if (survivalBlockReason) {
      runHistory.push({ step, decision: compactDecision(decision), status: 'survival_blocked', reason: survivalBlockReason })
      return stopRun({ status: 'survival_blocked', reason: survivalBlockReason, steps: step, history: runHistory, decision })
    }

    const signature = actionSignature(nextAction)
    if (repeatedActions.has(signature)) {
      const reason = `acao repetida bloqueada: ${nextAction.skill}`
      runHistory.push({ step, decision: compactDecision(decision), status: 'repetition_blocked', reason })
      return stopRun({ status: 'repetition_blocked', reason, steps: step, history: runHistory, decision })
    }
    repeatedActions.add(signature)

    const executionContext = {
      plannerMode: true,
      explicitUserIntent: true
    }
    const plan = await skillRegistry.plan(nextAction.skill, nextAction.args, executionContext)
    latestPlan = plan
    debugLog(env, 'plan_result', compactPlan(plan))
    traceLog(env, 'plan_result', compactPlan(plan))
    if (!plan.ok) {
      const reason = plan.reason || plan.code || 'plan falhou'
      runHistory.push({ step, decision: compactDecision(decision), plan: compactPlan(plan), status: 'plan_failed', reason })
      return stopRun({ status: 'plan_failed', reason, steps: step, history: runHistory, decision, plan })
    }

    if (dryRun) {
      const reason = `dry-run: ${nextAction.skill} planejada sem executar`
      runHistory.push({ step, decision: compactDecision(decision), plan: compactPlan(plan), status: 'dry_run', reason })
      return stopRun({ status: 'dry_run', reason, steps: step, history: runHistory, decision, plan, ok: true })
    }

    const confirmation = actionRequiresConfirmation({ skill: plannedSkill, args: nextAction.args, plan })
    const riskAllowed = allowedRiskSet.has(plannedSkill.risk || 'low')
    if (!riskAllowed && !(requireConfirmation && confirmation.required)) {
      const reason = `risco ${plannedSkill.risk} nao permitido neste runner`
      runHistory.push({ step, decision: compactDecision(decision), plan: compactPlan(plan), status: 'risk_blocked', reason })
      return stopRun({ status: 'risk_blocked', reason, steps: step, history: runHistory, decision, plan })
    }

    if (requireConfirmation && confirmation.required) {
      const reason = `acao sensivel exige confirmacao: ${confirmation.reasons.join(', ')}`
      const confirmationRequest = compactConfirmationRequest({
        userMessage,
        decision,
        plan,
        skill: plannedSkill,
        reasons: confirmation.reasons
      })
      runHistory.push({ step, decision: compactDecision(decision), plan: compactPlan(plan), status: 'confirmation_required', reason })
      return stopRun({
        status: 'confirmation_required',
        reason,
        steps: step,
        history: runHistory,
        decision,
        plan,
        ok: false,
        confirmation: confirmationRequest
      })
    }

    const result = await skillRegistry.execute(nextAction.skill, nextAction.args, executionContext)
    latestResult = result
    debugLog(env, 'execute_result', compactActionResult(result))
    traceLog(env, 'execute_result', compactActionResult(result))
    runHistory.push({
      step,
      decision: compactDecision(decision),
      plan: compactPlan(plan),
      result: compactActionResult(result),
      status: result.ok ? 'executed' : 'execute_failed',
      reason: result.ok ? result.message : result.reason
    })

    if (!result.ok) {
      failedActionSignatures.add(failureSignature(nextAction, result.code))
      failedActions.add(actionSignature(nextAction))

      if (step < stepLimit && recoveryMode === 'local') {
        const blockedRecoverySignatures = new Set([
          ...repeatedActions,
          ...failedActions
        ])
        const recoveryChoice = chooseLocalRecoveryAction(result.suggestedNextActions, blockedRecoverySignatures)
        if (recoveryChoice.action) {
          const recoveryStep = step + 1
          const recoveryPlan = await planRecoveryAction({
            action: recoveryChoice.action,
            skillRegistry,
            safeContext,
            survivalGuard,
            allowedRiskSet,
            repeatedActions,
            executionContext,
            requireConfirmation
          })

          if (recoveryPlan.ok) {
            repeatedActions.add(actionSignature(recoveryChoice.action))
            const recoveryResult = await skillRegistry.execute(recoveryChoice.action.skill, recoveryChoice.action.args, executionContext)
            runHistory.push({
              step: recoveryStep,
              decision: null,
              plan: compactPlan(recoveryPlan.plan),
              result: compactActionResult(recoveryResult),
              status: recoveryResult.ok ? 'recovery_executed' : 'recovery_execute_failed',
              reason: recoveryResult.ok ? recoveryResult.message : recoveryResult.reason,
              recovery: {
                source: 'suggestedNextActions',
                action: recoveryChoice.action,
                reason: recoveryChoice.reason
              }
            })

            if (recoveryResult.ok) {
              return stopRun({
                status: 'completed',
                reason: recoveryResult.message || 'recuperacao local concluida',
                steps: recoveryStep,
                history: runHistory,
                decision,
                plan: recoveryPlan.plan,
                result: recoveryResult,
                ok: true
              })
            }

            failedActionSignatures.add(failureSignature(recoveryChoice.action, recoveryResult.code))
            failedActions.add(actionSignature(recoveryChoice.action))
            return stopRun({
              status: recoveryResult.retryable ? 'execute_failed_retryable' : 'execute_failed',
              reason: recoveryResult.reason || recoveryResult.message || recoveryResult.code,
              steps: recoveryStep,
              history: runHistory,
              decision,
              plan: recoveryPlan.plan,
              result: recoveryResult
            })
          }

          runHistory.push({
            step: recoveryStep,
            decision: null,
            plan: compactPlan(recoveryPlan.plan),
            status: recoveryPlan.status,
            reason: recoveryPlan.reason,
            recovery: {
              source: 'suggestedNextActions',
              action: recoveryChoice.action,
              reason: recoveryChoice.reason
            }
          })
        } else if (recoveryChoice.status === 'ambiguous') {
          runHistory.push({
            step: step + 1,
            decision: null,
            status: 'recovery_ambiguous',
            reason: recoveryChoice.reason
          })
        }
      }

      if (step < stepLimit && recoveryMode === 'llm') {
        continue
      }

      return stopRun({
        status: result.retryable ? 'execute_failed_retryable' : 'execute_failed',
        reason: result.reason || result.message || result.code,
        steps: step,
        history: runHistory,
        decision,
        plan,
        result
      })
    }

    if (decision.stopAfterThis || step >= stepLimit) {
      return stopRun({
        status: step >= stepLimit && !decision.stopAfterThis ? 'max_steps_reached' : 'completed',
        reason: result.message || 'acao concluida',
        steps: step,
        history: runHistory,
        decision,
        plan,
        result,
        ok: true
      })
    }
  }

  return stopRun({
    status: 'max_steps_reached',
    reason: 'limite de passos atingido',
    steps: stepLimit,
    history: runHistory,
    decision: latestDecision,
    plan: latestPlan,
    result: latestResult,
    ok: Boolean(latestResult?.ok)
  })
}

module.exports = {
  runPlannerCycles,
  safePlannerState,
  survivalBlocksPlan,
  compactActionResult,
  compactDecision,
  compactPlan,
  normalizeSeverityLevel,
  normalizeMaxSteps,
  actionRequiresConfirmation,
  actionSignature,
  chooseLocalRecoveryAction,
  configuredRecoveryMode,
  failureSignature,
  normalizeRecoveryMode,
  configuredSemanticGuardMode,
  normalizeSemanticGuardMode,
  semanticGuardForDecision,
  DEFAULT_ALLOWED_RISKS,
  DEFAULT_MAX_STEPS,
  DEFAULT_RECOVERY_MODE,
  DEFAULT_SEMANTIC_GUARD_MODE,
  HARD_MAX_STEPS
}
