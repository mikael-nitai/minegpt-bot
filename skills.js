const {
  actionFail,
  requirement,
  runAction,
  suggestSkillAction
} = require('./action-result')

const VALID_RISKS = new Set(['low', 'medium', 'high'])
const PLANNER_EXPLICIT_ONLY_SKILLS = new Set([
  'inventory.drop',
  'survival.set_enabled',
  'containers.clear_memory'
])

function asArray (value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function mergeContext (defaultContext, context) {
  return { ...defaultContext, ...context }
}

function parseRule (rule) {
  if (typeof rule === 'string') {
    const optional = /\boptional\b/.test(rule)
    const enumValues = rule.includes('|') && !/\bstring\b|\bnumber\b|\bboolean\b|\bobject\b|\barray\b/.test(rule)
      ? rule.split('|').map(value => value.trim()).filter(Boolean)
      : null
    const rangeMatch = rule.match(/\b(\d+)\s*-\s*(\d+)\b/)
    const maxMatch = rule.match(/\bmax\s+(\d+)\b/)
    const minMatch = rule.match(/\bmin\s+(\d+)\b/)

    return {
      type: rule.includes('number')
        ? 'number'
        : rule.includes('boolean')
          ? 'boolean'
          : rule.includes('object')
            ? 'object'
            : rule.includes('array')
              ? 'array'
              : 'string',
      optional,
      enum: enumValues,
      min: rangeMatch ? Number(rangeMatch[1]) : minMatch ? Number(minMatch[1]) : null,
      max: rangeMatch ? Number(rangeMatch[2]) : maxMatch ? Number(maxMatch[1]) : null
    }
  }

  if (rule && typeof rule === 'object') {
    return {
      type: rule.type || 'string',
      optional: Boolean(rule.optional),
      enum: rule.enum || null,
      min: typeof rule.min === 'number' ? rule.min : null,
      max: typeof rule.max === 'number' ? rule.max : null
    }
  }

  return { type: 'string', optional: false, enum: null, min: null, max: null }
}

function validateValueType (value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value)
  if (type === 'array') return Array.isArray(value)
  return typeof value === 'string' && value.trim().length > 0
}

function validateArgs (inputSchema = {}, args = {}) {
  const errors = []
  const missingRequirements = []
  const cleanArgs = { ...args }

  for (const [field, rawRule] of Object.entries(inputSchema)) {
    const rule = parseRule(rawRule)
    const value = cleanArgs[field]
    const missing = value == null || value === ''

    if (missing) {
      if (!rule.optional) {
        errors.push(`${field} ausente`)
        missingRequirements.push(requirement('argument', { name: field, expected: rawRule }))
      }
      continue
    }

    if (!validateValueType(value, rule.type)) {
      errors.push(`${field} deve ser ${rule.type}`)
      continue
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`${field} deve ser um de: ${rule.enum.join(', ')}`)
    }

    if (rule.type === 'number') {
      if (rule.min != null && value < rule.min) errors.push(`${field} deve ser >= ${rule.min}`)
      if (rule.max != null && value > rule.max) errors.push(`${field} deve ser <= ${rule.max}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    missingRequirements,
    args: cleanArgs
  }
}

function checkBuiltInRequirement (requirement, context) {
  if (requirement === 'botOnline') {
    return context.bot ? null : {
      reason: 'bot offline',
      missingRequirement: { type: 'state', name: 'botOnline' }
    }
  }

  if (requirement === 'notReconnecting') {
    return context.reconnecting ? {
      reason: 'bot reconectando',
      missingRequirement: { type: 'state', name: 'notReconnecting' }
    } : null
  }

  if (requirement === 'navigationReady') {
    return context.navigationController ? null : {
      reason: 'navegacao indisponivel',
      missingRequirement: { type: 'state', name: 'navigationReady' }
    }
  }

  if (requirement === 'stateReporter') {
    return context.stateReporter ? null : {
      reason: 'state reporter indisponivel',
      missingRequirement: { type: 'state', name: 'stateReporter' }
    }
  }

  return null
}

function normalizeCheckResult (result) {
  if (result === true || result == null) return null
  if (result === false) return { reason: 'pre-condicao falhou', missingRequirements: [], suggestedNextActions: [] }
  if (typeof result === 'string') return { reason: result, missingRequirements: [], suggestedNextActions: [] }
  if (result && typeof result === 'object' && result.ok === false) {
    return {
      reason: result.reason || result.message || 'pre-condicao falhou',
      missingRequirements: result.missingRequirements || [],
      suggestedNextActions: result.suggestedNextActions || []
    }
  }
  return null
}

async function runChecks (checks, args, context) {
  const failures = []

  for (const check of checks) {
    if (typeof check !== 'function') continue
    const failure = normalizeCheckResult(await check(args, context))
    if (failure) failures.push(failure)
  }

  return failures
}

function defaultPlannerPolicy (skill, args, context) {
  if (!context.plannerMode) return null
  if (context.explicitUserIntent === true) return null

  if (PLANNER_EXPLICIT_ONLY_SKILLS.has(skill.id)) {
    return {
      ok: false,
      reason: `${skill.id} exige permissao explicita do usuario para planner`,
      missingRequirements: [requirement('permission', { name: 'explicitUserIntent', skill: skill.id })],
      suggestedNextActions: [suggestSkillAction('state.planner_snapshot', {}, 'reavaliar estado e pedir confirmacao ao usuario')]
    }
  }

  if (skill.id === 'movement.go_to') {
    const currentPosition = context.bot?.entity?.position
    if (!currentPosition) return null
    const dx = Number(args.x) - currentPosition.x
    const dy = Number(args.y) - currentPosition.y
    const dz = Number(args.z) - currentPosition.z
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (distance > 48) {
      return {
        ok: false,
        reason: `movement.go_to distante demais para planner sem confirmacao (${Math.round(distance)} blocos)`,
        missingRequirements: [requirement('permission', { name: 'explicitUserIntent', skill: skill.id })],
        suggestedNextActions: [suggestSkillAction('state.planner_snapshot', {}, 'reavaliar rota antes de pedir confirmacao')]
      }
    }
  }

  if (skill.id === 'collection.collect' && Number(args.count || 1) > 3) {
    return {
      ok: false,
      reason: 'collection.collect acima de 3 blocos exige permissao explicita do usuario para planner',
      missingRequirements: [requirement('permission', { name: 'explicitUserIntent', skill: skill.id })],
      suggestedNextActions: [suggestSkillAction('state.planner_snapshot', {}, 'reavaliar necessidade antes de pedir confirmacao')]
    }
  }

  return null
}

function estimateCost (skill, args, context) {
  if (typeof skill.estimateCost === 'function') {
    try {
      return skill.estimateCost(args, context)
    } catch (err) {
      return { ...skill.cost, estimateError: err.message }
    }
  }

  return skill.cost
}

function withExecutionTimeout (promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise

  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} excedeu timeout de ${timeoutMs}ms`)
      err.actionCode = 'timeout'
      err.retryable = true
      reject(err)
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

function createSkillRegistry (options = {}) {
  const skills = new Map()
  const defaultContext = options.defaultContext || {}
  const plannerPolicy = typeof options.plannerPolicy === 'function' ? options.plannerPolicy : defaultPlannerPolicy

  function register (definition) {
    if (!definition?.id) throw new Error('skill sem id')
    if (typeof definition.run !== 'function') throw new Error(`skill ${definition.id} sem run()`)
    if (definition.risk && !VALID_RISKS.has(definition.risk)) throw new Error(`skill ${definition.id} com risk invalido`)

    skills.set(definition.id, {
      description: '',
      inputSchema: {},
      risk: 'low',
      timeoutMs: 10000,
      interruptible: true,
      requires: [],
      preconditions: [],
      postconditions: [],
      effects: [],
      cost: { base: 1 },
      plannerHints: '',
      ...definition
    })
  }

  function get (id) {
    return skills.get(id) || null
  }

  function list () {
    return [...skills.values()]
      .map(({
        id,
        description,
        inputSchema,
        risk,
        timeoutMs,
        interruptible,
        requires,
        effects,
        cost,
        plannerHints
      }) => ({
        id,
        description,
        inputSchema,
        risk,
        timeoutMs,
        interruptible,
        requires: asArray(requires),
        effects: asArray(effects),
        cost,
        plannerHints
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  function describe () {
    const entries = list()
    if (entries.length === 0) return 'Skills: nenhuma registrada.'
    return `Skills: ${entries.map(skill => `${skill.id}(${skill.risk})`).join(', ')}`
  }

  async function plan (id, args = {}, context = {}) {
    const skill = get(id)
    if (!skill) {
      return {
        ok: false,
        skill: id,
        code: 'unknown_skill',
        reason: `skill desconhecida: ${id}`,
        args,
        missingRequirements: [requirement('skill', { id })],
        suggestedNextActions: []
      }
    }

    const mergedContext = mergeContext(defaultContext, context)
    const validation = validateArgs(skill.inputSchema, args)
    const requires = asArray(skill.requires)
    const requirementResults = requires
      .map(requirement => checkBuiltInRequirement(requirement, mergedContext))
      .filter(Boolean)
    const requirementFailures = requirementResults.map(result => result.reason)
    const preconditionFailures = await runChecks(asArray(skill.preconditions), validation.args, mergedContext)
    const policyFailures = await runChecks([plannerPolicy ? (checkedArgs, checkedContext) => plannerPolicy(skill, checkedArgs, checkedContext) : null], validation.args, mergedContext)
    const preconditionReasons = preconditionFailures.map(failure => failure.reason)
    const policyReasons = policyFailures.map(failure => failure.reason)
    const missingRequirements = [
      ...validation.missingRequirements,
      ...requirementResults.map(result => result.missingRequirement).filter(Boolean),
      ...preconditionFailures.flatMap(failure => failure.missingRequirements || []),
      ...policyFailures.flatMap(failure => failure.missingRequirements || [])
    ]
    const suggestedNextActions = [
      ...preconditionFailures.flatMap(failure => failure.suggestedNextActions || []),
      ...policyFailures.flatMap(failure => failure.suggestedNextActions || [])
    ]
    const failures = [...validation.errors, ...requirementFailures, ...preconditionReasons, ...policyReasons]

    return {
      ok: failures.length === 0,
      skill: id,
      code: failures.length === 0 ? 'ok' : validation.ok ? 'precondition_failed' : 'validation_failed',
      description: skill.description,
      args: validation.args,
      inputSchema: skill.inputSchema,
      risk: skill.risk,
      timeoutMs: skill.timeoutMs,
      interruptible: skill.interruptible,
      requires,
      effects: asArray(skill.effects),
      cost: estimateCost(skill, validation.args, mergedContext),
      plannerHints: skill.plannerHints,
      validation,
      failures,
      missingRequirements,
      suggestedNextActions,
      reason: failures.join('; ')
    }
  }

  async function execute (id, args = {}, context = {}) {
    const skill = get(id)
    if (!skill) {
      return actionFail(id, `skill desconhecida: ${id}`, {}, Date.now(), {
        code: 'unknown_skill',
        missingRequirements: [requirement('skill', { id })],
        suggestedNextActions: []
      })
    }

    const executionPlan = await plan(id, args, context)
    if (!executionPlan.ok) {
      return actionFail(id, executionPlan.reason || 'pre-condicoes falharam', { plan: executionPlan }, Date.now(), {
        code: executionPlan.code,
        retryable: executionPlan.missingRequirements.length > 0,
        missingRequirements: executionPlan.missingRequirements,
        suggestedNextActions: executionPlan.suggestedNextActions
      })
    }

    const mergedContext = mergeContext(defaultContext, context)
    const result = await runAction(id, () => withExecutionTimeout(
      Promise.resolve(skill.run(executionPlan.args, mergedContext)),
      skill.timeoutMs,
      id
    ))

    if (!result.ok) return result

    const postconditionFailures = await runChecks(asArray(skill.postconditions), executionPlan.args, mergedContext)
    if (postconditionFailures.length > 0) {
      return actionFail(id, postconditionFailures.map(failure => failure.reason).join('; '), { result, plan: executionPlan }, Date.now(), {
        code: 'postcondition_failed',
        retryable: true,
        missingRequirements: postconditionFailures.flatMap(failure => failure.missingRequirements || []),
        suggestedNextActions: [
          ...postconditionFailures.flatMap(failure => failure.suggestedNextActions || []),
          suggestSkillAction('state.snapshot', {}, 'reavaliar estado depois de pos-condicao falhar')
        ]
      })
    }

    result.data = {
      ...result.data,
      plan: executionPlan
    }
    return result
  }

  return {
    register,
    get,
    list,
    describe,
    plan,
    execute
  }
}

module.exports = {
  createSkillRegistry,
  validateArgs,
  defaultPlannerPolicy
}
