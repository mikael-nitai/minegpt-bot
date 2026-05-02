const { makePlannerDecision, validatePlannerDecision } = require('../planner-schema')

function normalizeText (text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function hasAny (text, terms) {
  return terms.some(term => text.includes(term))
}

function skillExists (skills, id) {
  return skills.some(skill => skill.id === id)
}

function executionDecision ({ userGoal, skill, args = {}, reasonSummary, risk = 'low', confidence = 0.75, stopAfterThis = false }) {
  return makePlannerDecision({
    intent: 'execute_skill',
    userGoal,
    nextAction: { skill, args },
    reasonSummary,
    risk,
    confidence,
    stopAfterThis
  })
}

function askUserDecision (userGoal, askUser, reasonSummary = 'Comando ambiguo para o planner local.') {
  return makePlannerDecision({
    intent: 'ask_user',
    userGoal,
    nextAction: null,
    reasonSummary,
    askUser,
    risk: 'low',
    confidence: 0.35,
    stopAfterThis: true
  })
}

function attachPlannerMeta ({ decision, mode, plannerState, history, validation, providerFallback = null }) {
  return {
    ...decision,
    planner: {
      mode,
      stateSeen: Boolean(plannerState),
      historySize: Array.isArray(history) ? history.length : 0,
      providerFallback
    },
    validation
  }
}

function validateOrAsk ({ decision, skills, userGoal, mode, plannerState, history, providerFallback = null }) {
  const validation = validatePlannerDecision(decision, { skills })
  if (!validation.ok) {
    const fallbackDecision = askUserDecision(
      userGoal,
      'Nao consegui montar uma decisao valida para esse pedido.',
      validation.errors.join('; ')
    )
    return attachPlannerMeta({
      decision: fallbackDecision,
      mode,
      plannerState,
      history,
      validation,
      providerFallback
    })
  }

  return attachPlannerMeta({
    decision,
    mode,
    plannerState,
    history,
    validation,
    providerFallback
  })
}

function requireSkillOrAsk ({ decision, skills, userGoal, mode }) {
  if (decision.intent !== 'execute_skill') return decision
  if (skillExists(skills, decision.nextAction.skill)) return decision
  return askUserDecision(
    userGoal,
    `A skill ${decision.nextAction.skill} nao esta disponivel agora.`,
    `Planner ${mode} escolheu skill ausente.`
  )
}

function firstPositiveInteger (text) {
  const match = String(text || '').match(/\b([1-9]\d*)\b/)
  return match ? Number(match[1]) : null
}

function normalizeAlias (value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function normalizeDepositModeAlias (value) {
  const normalized = normalizeAlias(value)
  if (!normalized) return null
  if (['blocks', 'block', 'blocos', 'bloco'].includes(normalized)) return 'blocks'
  if (['resources', 'resource', 'recursos', 'recurso'].includes(normalized)) return 'resources'
  if (['drops', 'drop'].includes(normalized)) return 'drops'
  if (['all', 'tudo', 'todos', 'todo'].includes(normalized)) return 'all'
  return null
}

function normalizePlannerActionArgs (action, skills = []) {
  if (!action || typeof action !== 'object' || typeof action.skill !== 'string') return action
  if (action.args != null && (typeof action.args !== 'object' || Array.isArray(action.args))) return action

  const skillKnown = skills.length === 0 || skillExists(skills, action.skill)
  if (!skillKnown) return action

  if (action.skill === 'movement.stop') {
    return { ...action, args: {} }
  }

  if (action.skill !== 'containers.deposit') {
    return { ...action, args: action.args || {} }
  }

  const args = { ...(action.args || {}) }
  const modeAlias = normalizeDepositModeAlias(args.mode) ||
    normalizeDepositModeAlias(args.category) ||
    (args.all === true ? 'all' : null) ||
    normalizeDepositModeAlias(args.target) ||
    normalizeDepositModeAlias(args.item)

  if (modeAlias) {
    args.mode = modeAlias
    delete args.category
    delete args.all
    if (normalizeDepositModeAlias(args.target) === modeAlias) delete args.target
    if (normalizeDepositModeAlias(args.item) === modeAlias) delete args.item
    if (modeAlias !== 'target') {
      delete args.target
      delete args.item
      delete args.count
    }
  }

  return { ...action, args }
}

function normalizePlannerDecisionArgs (decision, skills = []) {
  if (!decision || decision.intent !== 'execute_skill') return decision
  return {
    ...decision,
    nextAction: normalizePlannerActionArgs(decision.nextAction, skills)
  }
}

module.exports = {
  normalizeText,
  hasAny,
  skillExists,
  executionDecision,
  askUserDecision,
  validateOrAsk,
  requireSkillOrAsk,
  firstPositiveInteger,
  normalizeDepositModeAlias,
  normalizePlannerActionArgs,
  normalizePlannerDecisionArgs
}
