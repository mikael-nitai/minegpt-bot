const VALID_INTENTS = new Set(['execute_skill', 'ask_user', 'refuse', 'stop'])
const VALID_RISKS = new Set(['low', 'medium', 'high'])
const COLLECT_SKILLS = new Set(['collection.collect', 'collection.collect_block'])
const DEPOSIT_MODES = ['target', 'all', 'resources', 'blocks', 'drops']
const DEPOSIT_GROUP_MODES = ['all', 'resources', 'blocks', 'drops']

function skillIdsFromTools (skills = []) {
  return new Set(skills.map(skill => skill.id).filter(Boolean))
}

function isPlainObject (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asArray (value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function allowedCollectTargetsFromState (plannerState = {}) {
  const allowedActions = plannerState.allowedActions || {}
  return [...new Set(asArray(allowedActions.collectTargets)
    .filter(value => typeof value === 'string' && value.trim().length > 0))]
}

function skillById (skills = []) {
  return new Map(skills.filter(skill => skill?.id).map(skill => [skill.id, skill]))
}

function validateArgsForSkill (action, options = {}) {
  const errors = []
  const skill = action?.skill
  const args = action?.args

  if (!isPlainObject(args)) return errors

  if (COLLECT_SKILLS.has(skill)) {
    const allowedTargets = allowedCollectTargetsFromState(options.plannerState || {})
    if (allowedTargets.length > 0 && !allowedTargets.includes(args.target)) {
      errors.push(`${skill}.target fora do vocabulario permitido: ${args.target}`)
    }
  }

  if (skill === 'containers.deposit') {
    if (!DEPOSIT_MODES.includes(args.mode)) {
      errors.push(`containers.deposit.mode invalido: ${args.mode}`)
    } else if (args.mode === 'target') {
      if (typeof args.target !== 'string' || args.target.trim().length === 0) {
        errors.push('containers.deposit.target obrigatorio quando mode=target')
      }
    } else {
      if ('target' in args) errors.push(`containers.deposit.target nao permitido quando mode=${args.mode}`)
      if ('count' in args) errors.push(`containers.deposit.count nao permitido quando mode=${args.mode}`)
    }
  }

  return errors
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
      } else {
        errors.push(...validateArgsForSkill(decision.nextAction, options))
      }
    }
  } else if (decision.nextAction !== null) {
    errors.push('nextAction deve ser null quando intent nao executa skill')
  }

  if (decision.intent === 'ask_user' && (!decision.askUser || decision.askUser.trim().length === 0)) {
    errors.push('askUser obrigatorio para ask_user')
  }

  if (decision.intent === 'stop' && decision.askUser != null) {
    errors.push('askUser deve ser null para stop')
  }

  return {
    ok: errors.length === 0,
    errors,
    decision: errors.length === 0 ? decision : null
  }
}

function validatePlannerDecisionStructure (decision, options = {}) {
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

      if (!isPlainObject(decision.nextAction.args)) errors.push('nextAction.args deve ser objeto')
    }
  } else if (decision.nextAction !== null) {
    errors.push('nextAction deve ser null quando intent nao executa skill')
  }

  if (decision.intent === 'ask_user' && (!decision.askUser || decision.askUser.trim().length === 0)) {
    errors.push('askUser obrigatorio para ask_user')
  }

  if (decision.intent === 'stop' && decision.askUser != null) {
    errors.push('askUser deve ser null para stop')
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

function objectSchemaForSkillArgs (skill, options = {}) {
  if (skill?.id === 'containers.deposit') return objectSchemaForDepositArgs()

  const base = skill?.inputSchema && typeof skill.inputSchema === 'object' && skill.inputSchema.type === 'object'
    ? JSON.parse(JSON.stringify(skill.inputSchema))
    : { type: 'object', properties: {}, additionalProperties: false }

  if (COLLECT_SKILLS.has(skill?.id)) {
    const allowedTargets = allowedCollectTargetsFromState(options.plannerState || {})
    if (allowedTargets.length > 0) {
      base.properties = {
        ...(base.properties || {}),
        target: { type: 'string', enum: allowedTargets }
      }
      base.required = [...new Set([...(base.required || []), 'target'])]
      base.additionalProperties = false
    }
  }

  return base
}

function objectSchemaForDepositArgs () {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: DEPOSIT_GROUP_MODES }
        },
        required: ['mode']
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['target'] },
          target: { type: 'string', minLength: 1 },
          count: { type: 'number', minimum: 1, maximum: 64 }
        },
        required: ['mode', 'target']
      }
    ]
  }
}

function nextActionSchemaForSkills (skills = [], options = {}) {
  const byId = skillById(skills)
  const skillIds = [...byId.keys()]

  if (skillIds.length === 0) {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', minLength: 1 },
        args: { type: 'object', additionalProperties: true }
      },
      required: ['skill', 'args']
    }
  }

  return {
    oneOf: skillIds.map((id) => {
      const skill = byId.get(id)
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', enum: [id] },
          args: objectSchemaForSkillArgs(skill, options)
        },
        required: ['skill', 'args']
      }
    })
  }
}

function plannerDecisionJsonSchema (skills = [], options = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...VALID_INTENTS] },
      userGoal: { type: 'string', minLength: 1 },
      nextAction: {
        anyOf: [
          { type: 'null' },
          nextActionSchemaForSkills(skills, options)
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

function plannerDecisionSimpleJsonSchema (skills = []) {
  const skillIds = [...skillIdsFromTools(skills)]
  const skillSchema = skillIds.length > 0
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
              skill: skillSchema,
              args: { type: 'object', additionalProperties: true }
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
  validatePlannerDecisionStructure,
  makePlannerDecision,
  plannerDecisionJsonSchema,
  plannerDecisionSimpleJsonSchema,
  allowedCollectTargetsFromState
}
