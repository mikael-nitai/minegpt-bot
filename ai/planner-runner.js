const { decideNextAction } = require('./planner')
const { validatePlannerDecision } = require('./planner-schema')
const { skillRegistryToPlannerTools } = require('./tool-adapter')

const DEFAULT_ALLOWED_RISKS = ['low', 'medium']
const DEFAULT_MAX_STEPS = 1
const HARD_MAX_STEPS = 3

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
      online: Boolean(context.bot),
      activeSkill: context.activeSkill?.name || null,
      snapshotError: error.message
    }
  }

  return {
    online: Boolean(context.bot),
    activeSkill: context.activeSkill?.name || null
  }
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
  return `${action.skill}:${JSON.stringify(action.args || {})}`
}

function normalizeMaxSteps (maxSteps) {
  const parsed = Number(maxSteps)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_STEPS
  return Math.min(parsed, HARD_MAX_STEPS)
}

function stopRun ({ status, reason, steps, history, decision = null, plan = null, result = null, ok = false }) {
  return {
    ok,
    status,
    reason,
    steps,
    history,
    decision,
    plan,
    result
  }
}

async function runPlannerCycles ({
  userMessage,
  context,
  survivalGuard,
  history = [],
  maxSteps = DEFAULT_MAX_STEPS,
  dryRun = false,
  allowedRisks = DEFAULT_ALLOWED_RISKS,
  decide = decideNextAction
}) {
  const skillRegistry = context.skillRegistry
  const skills = skillRegistryToPlannerTools(skillRegistry)
  const allowedRiskSet = new Set(allowedRisks)
  const stepLimit = normalizeMaxSteps(maxSteps)
  const runHistory = Array.isArray(history) ? history.slice(-5) : []
  const repeatedActions = new Set()
  let latestDecision = null
  let latestPlan = null
  let latestResult = null

  for (let step = 1; step <= stepLimit; step++) {
    const plannerState = safePlannerState(context)
    const decision = await decide({
      userMessage,
      plannerState,
      skills,
      history: runHistory
    })
    latestDecision = decision

    const validation = validatePlannerDecision(decision, { skills })
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
      const reason = decision.reasonSummary || 'planner decidiu parar'
      runHistory.push({ step, decision: compactDecision(decision), status: 'stopped', reason })
      return stopRun({ status: 'stopped', reason, steps: step, history: runHistory, decision, ok: true })
    }

    const nextAction = decision.nextAction
    const plannedSkill = skillRegistry.get(nextAction.skill)
    if (!plannedSkill) {
      const reason = `skill inexistente: ${nextAction.skill}`
      runHistory.push({ step, decision: compactDecision(decision), status: 'unknown_skill', reason })
      return stopRun({ status: 'unknown_skill', reason, steps: step, history: runHistory, decision })
    }

    if (!allowedRiskSet.has(plannedSkill.risk || 'low')) {
      const reason = `risco ${plannedSkill.risk} nao permitido neste runner`
      runHistory.push({ step, decision: compactDecision(decision), status: 'risk_blocked', reason })
      return stopRun({ status: 'risk_blocked', reason, steps: step, history: runHistory, decision })
    }

    if (context.activeSkill && nextAction.skill !== 'movement.stop') {
      const reason = `ja estou executando ${context.activeSkill.name}`
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

    const result = await skillRegistry.execute(nextAction.skill, nextAction.args, executionContext)
    latestResult = result
    runHistory.push({
      step,
      decision: compactDecision(decision),
      plan: compactPlan(plan),
      result: compactActionResult(result),
      status: result.ok ? 'executed' : 'execute_failed',
      reason: result.ok ? result.message : result.reason
    })

    if (!result.ok) {
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
  DEFAULT_ALLOWED_RISKS,
  DEFAULT_MAX_STEPS,
  HARD_MAX_STEPS
}
