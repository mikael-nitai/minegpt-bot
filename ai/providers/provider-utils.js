const { makePlannerDecision, validatePlannerDecision } = require('../planner-schema')
const { resolveContainerModeAlias } = require('../semantic-aliases')

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

function normalizeDepositModeAlias (value) {
  return resolveContainerModeAlias(value)
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
  normalizeDepositModeAlias
}
