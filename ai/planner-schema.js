const VALID_INTENTS = new Set(['execute_skill', 'ask_user', 'refuse', 'stop'])
const VALID_RISKS = new Set(['low', 'medium', 'high'])

function skillIdsFromTools (skills = []) {
  return new Set(skills.map(skill => skill.id).filter(Boolean))
}

function isPlainObject (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validatePlannerDecision (decision, options = {}) {
  const errors = []
  const skillIds = skillIdsFromTools(options.skills || [])

  if (!isPlainObject(decision)) {
    return { ok: false, errors: ['decisao deve ser objeto'], decision: null }
  }

  if (!VALID_INTENTS.has(decision.intent)) errors.push('intent invalida')
  if (typeof decision.userGoal !== 'string' || decision.userGoal.trim().length === 0) errors.push('userGoal ausente')
  if (typeof decision.reasonSummary !== 'string' || decision.reasonSummary.trim().length === 0) errors.push('reasonSummary ausente')
  if (decision.reasonSummary && decision.reasonSummary.length > 240) errors.push('reasonSummary deve ser curto')
  if (!VALID_RISKS.has(decision.risk)) errors.push('risk invalido')
  if (typeof decision.confidence !== 'number' || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    errors.push('confidence deve estar entre 0 e 1')
  }
  if (typeof decision.stopAfterThis !== 'boolean') errors.push('stopAfterThis deve ser boolean')
  if (decision.askUser != null && typeof decision.askUser !== 'string') errors.push('askUser deve ser string ou null')

  if (decision.intent === 'execute_skill') {
    if (!isPlainObject(decision.nextAction)) {
      errors.push('nextAction obrigatorio para execute_skill')
    } else {
      if (typeof decision.nextAction.skill !== 'string' || decision.nextAction.skill.trim().length === 0) {
        errors.push('nextAction.skill ausente')
      } else if (skillIds.size > 0 && !skillIds.has(decision.nextAction.skill)) {
        errors.push(`skill inexistente: ${decision.nextAction.skill}`)
      }

      if (!isPlainObject(decision.nextAction.args)) {
        errors.push('nextAction.args deve ser objeto')
      }
    }
  } else if (decision.nextAction !== null) {
    errors.push('nextAction deve ser null quando intent nao executa skill')
  }

  if (decision.intent === 'ask_user' && (!decision.askUser || decision.askUser.trim().length === 0)) {
    errors.push('askUser obrigatorio para ask_user')
  }

  return {
    ok: errors.length === 0,
    errors,
    decision: errors.length === 0 ? decision : null
  }
}

function makePlannerDecision ({
  intent,
  userGoal,
  nextAction = null,
  reasonSummary,
  askUser = null,
  risk = 'low',
  confidence = 0.5,
  stopAfterThis = false
}) {
  return {
    intent,
    userGoal,
    nextAction,
    reasonSummary,
    askUser,
    risk,
    confidence,
    stopAfterThis
  }
}

function plannerDecisionJsonSchema (skills = []) {
  const skillIds = [...skillIdsFromTools(skills)]
  const skillProperty = skillIds.length > 0
    ? { type: 'string', enum: skillIds }
    : { type: 'string', minLength: 1 }

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...VALID_INTENTS] },
      userGoal: { type: 'string', minLength: 1 },
      nextAction: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              skill: skillProperty,
              args: {
                type: 'object',
                additionalProperties: true
              }
            },
            required: ['skill', 'args']
          }
        ]
      },
      reasonSummary: { type: 'string', minLength: 1, maxLength: 240 },
      askUser: {
        anyOf: [
          { type: 'string' },
          { type: 'null' }
        ]
      },
      risk: { type: 'string', enum: [...VALID_RISKS] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      stopAfterThis: { type: 'boolean' }
    },
    required: ['intent', 'userGoal', 'nextAction', 'reasonSummary', 'askUser', 'risk', 'confidence', 'stopAfterThis']
  }
}

module.exports = {
  VALID_INTENTS,
  VALID_RISKS,
  validatePlannerDecision,
  makePlannerDecision,
  plannerDecisionJsonSchema
}
