const { actionFail, runAction } = require('./action-result')

const VALID_RISKS = new Set(['low', 'medium', 'high'])

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
  const cleanArgs = { ...args }

  for (const [field, rawRule] of Object.entries(inputSchema)) {
    const rule = parseRule(rawRule)
    const value = cleanArgs[field]
    const missing = value == null || value === ''

    if (missing) {
      if (!rule.optional) errors.push(`${field} ausente`)
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
    args: cleanArgs
  }
}

function checkBuiltInRequirement (requirement, context) {
  if (requirement === 'botOnline') return context.bot ? null : 'bot offline'
  if (requirement === 'notReconnecting') return context.reconnecting ? 'bot reconectando' : null
  if (requirement === 'navigationReady') return context.navigationController ? null : 'navegacao indisponivel'
  if (requirement === 'stateReporter') return context.stateReporter ? null : 'state reporter indisponivel'
  return null
}

function normalizeCheckResult (result) {
  if (result === true || result == null) return null
  if (result === false) return 'pre-condicao falhou'
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && result.ok === false) return result.reason || result.message || 'pre-condicao falhou'
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
    timeoutId = setTimeout(() => reject(new Error(`${label} excedeu timeout de ${timeoutMs}ms`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

function createSkillRegistry (options = {}) {
  const skills = new Map()
  const defaultContext = options.defaultContext || {}

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
        reason: `skill desconhecida: ${id}`,
        args
      }
    }

    const mergedContext = mergeContext(defaultContext, context)
    const validation = validateArgs(skill.inputSchema, args)
    const requires = asArray(skill.requires)
    const requirementFailures = requires
      .map(requirement => checkBuiltInRequirement(requirement, mergedContext))
      .filter(Boolean)
    const preconditionFailures = await runChecks(asArray(skill.preconditions), validation.args, mergedContext)
    const failures = [...validation.errors, ...requirementFailures, ...preconditionFailures]

    return {
      ok: failures.length === 0,
      skill: id,
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
      reason: failures.join('; ')
    }
  }

  async function execute (id, args = {}, context = {}) {
    const skill = get(id)
    if (!skill) return actionFail(id, `skill desconhecida: ${id}`)

    const executionPlan = await plan(id, args, context)
    if (!executionPlan.ok) {
      return actionFail(id, executionPlan.reason || 'pre-condicoes falharam', { plan: executionPlan })
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
      return actionFail(id, postconditionFailures.join('; '), { result, plan: executionPlan })
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
  validateArgs
}
