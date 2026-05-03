const {
  resolveCollectTargetAlias,
  resolveContainerModeAlias,
  resolveItemAlias
} = require('./semantic-aliases')

function isPlainObject (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneDecision (decision) {
  if (!decision || typeof decision !== 'object') return decision
  return {
    ...decision,
    nextAction: decision.nextAction
      ? {
          ...decision.nextAction,
          args: isPlainObject(decision.nextAction.args) ? { ...decision.nextAction.args } : decision.nextAction.args
        }
      : decision.nextAction
  }
}

const NO_ARG_SKILLS = new Set([
  'movement.stop',
  'movement.come_here',
  'movement.follow_owner',
  'state.snapshot',
  'state.planner_snapshot',
  'survival.status'
])

function normalizeCount (value, warnings, field = 'count') {
  if (value == null || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    warnings.push(`${field} invalido removido: ${JSON.stringify(value)}`)
    return null
  }
  return number
}

function normalizeMovementStopArgs (args, warnings) {
  if (Object.keys(args).length > 0) warnings.push('movement.stop nao aceita argumentos; args extras removidos')
  return {}
}

function normalizeNoArgSkillArgs (skillId, args, warnings) {
  if (Object.keys(args).length > 0) warnings.push(`${skillId} nao aceita argumentos; args extras removidos`)
  return {}
}

function normalizeDepositArgs (args, warnings, errors) {
  const clean = { ...args }
  const modeAlias = resolveContainerModeAlias(clean.mode) ||
    resolveContainerModeAlias(clean.category) ||
    (clean.all === true ? 'all' : null) ||
    resolveContainerModeAlias(clean.target) ||
    resolveContainerModeAlias(clean.item)

  if (modeAlias) {
    if (clean.mode !== modeAlias) warnings.push(`containers.deposit.mode normalizado para ${modeAlias}`)
    clean.mode = modeAlias
    delete clean.category
    delete clean.all
    if (resolveContainerModeAlias(clean.target) === modeAlias) delete clean.target
    if (resolveContainerModeAlias(clean.item) === modeAlias) delete clean.item
  }

  if (clean.mode && clean.mode !== 'target') {
    for (const field of ['target', 'item', 'count', 'amount']) {
      if (field in clean) warnings.push(`containers.deposit.${field} removido para mode=${clean.mode}`)
      delete clean[field]
    }
    return { mode: clean.mode }
  }

  if (!clean.mode && (clean.target || clean.item)) {
    clean.mode = 'target'
    warnings.push('containers.deposit.mode ausente inferido como target')
  }

  if (clean.item && !clean.target) {
    clean.target = clean.item
    warnings.push('containers.deposit.item convertido para target')
  }
  delete clean.item

  const count = normalizeCount(clean.count ?? clean.amount, warnings)
  delete clean.amount
  if (count != null) clean.count = count
  else delete clean.count

  if (!clean.mode) errors.push('containers.deposit.mode ausente')
  if (clean.mode === 'target' && (typeof clean.target !== 'string' || clean.target.trim().length === 0)) {
    errors.push('containers.deposit.target ausente para mode=target')
  }

  return clean
}

function normalizeCollectArgs (args, warnings, errors, options) {
  const clean = { ...args }
  if (clean.item && !clean.target) {
    clean.target = clean.item
    warnings.push('collection.collect.item convertido para target')
  }
  if (clean.block && !clean.target) {
    clean.target = clean.block
    warnings.push('collection.collect.block convertido para target')
  }

  if (typeof clean.target === 'string') {
    const resolved = resolveCollectTargetAlias(clean.target, options)
    if (resolved && resolved !== clean.target) {
      warnings.push(`collection.collect.target normalizado de ${JSON.stringify(clean.target)} para ${resolved}`)
      clean.target = resolved
    } else if (!resolved) {
      errors.push(`collection.collect.target nao resolvido: ${clean.target}`)
    }
  }

  const count = normalizeCount(clean.count ?? clean.amount ?? clean.quantity, warnings)
  delete clean.amount
  delete clean.quantity
  delete clean.item
  delete clean.block
  if (count != null) clean.count = Math.min(count, 10)
  else if (!('count' in clean)) clean.count = 1

  if (typeof clean.target !== 'string' || clean.target.trim().length === 0) errors.push('collection.collect.target ausente')
  return clean
}

function normalizeCraftArgs (args, warnings, errors, options) {
  const clean = { ...args }
  if (clean.item && !clean.target) {
    clean.target = clean.item
    warnings.push('crafting.craft.item convertido para target')
  }

  if (typeof clean.target === 'string') {
    const resolved = resolveItemAlias(clean.target, { catalog: options.catalog, context: 'item' })
    if (resolved && resolved !== clean.target) {
      warnings.push(`crafting.craft.target normalizado de ${JSON.stringify(clean.target)} para ${resolved}`)
      clean.target = resolved
    }
  }

  const count = normalizeCount(clean.count ?? clean.amount ?? clean.quantity, warnings)
  delete clean.amount
  delete clean.quantity
  delete clean.item
  if (count != null) clean.count = Math.min(count, 64)
  else if (!('count' in clean)) clean.count = 1

  if (typeof clean.target !== 'string' || clean.target.trim().length === 0) errors.push('crafting.craft.target ausente')
  return clean
}

function normalizeContainerItemArgs (skillId, args, warnings, errors, options) {
  const clean = { ...args }
  if (clean.item && !clean.target) {
    clean.target = clean.item
    warnings.push(`${skillId}.item convertido para target`)
  }

  if (typeof clean.target === 'string') {
    const resolved = resolveItemAlias(clean.target, { catalog: options.catalog, context: 'item' })
    if (resolved && resolved !== clean.target) {
      warnings.push(`${skillId}.target normalizado de ${JSON.stringify(clean.target)} para ${resolved}`)
      clean.target = resolved
    }
  }

  const count = normalizeCount(clean.count ?? clean.amount ?? clean.quantity, warnings)
  delete clean.amount
  delete clean.quantity
  delete clean.item
  if (count != null) clean.count = Math.min(count, 64)
  else if (skillId === 'containers.withdraw' && !('count' in clean)) clean.count = 1

  if (typeof clean.target !== 'string' || clean.target.trim().length === 0) errors.push(`${skillId}.target ausente`)
  return clean
}

function normalizePlannerDecisionArgs (decision, options = {}) {
  const warnings = []
  const recoverableErrors = []
  const fatalErrors = []
  const normalized = cloneDecision(decision)

  if (!normalized || normalized.intent !== 'execute_skill') {
    return { decision: normalized, warnings, recoverableErrors, fatalErrors, changed: false }
  }

  const action = normalized.nextAction
  if (!action || typeof action.skill !== 'string') {
    fatalErrors.push('nextAction.skill ausente')
    return { decision: normalized, warnings, recoverableErrors, fatalErrors, changed: false }
  }

  if (action.args != null && !isPlainObject(action.args)) {
    fatalErrors.push(`${action.skill}.args deve ser objeto`)
    return { decision: normalized, warnings, recoverableErrors, fatalErrors, changed: false }
  }

  const before = JSON.stringify(action.args || {})
  const args = isPlainObject(action.args) ? action.args : {}

  if (NO_ARG_SKILLS.has(action.skill)) {
    action.args = action.skill === 'movement.stop'
      ? normalizeMovementStopArgs(args, warnings)
      : normalizeNoArgSkillArgs(action.skill, args, warnings)
  } else if (action.skill === 'containers.deposit') {
    action.args = normalizeDepositArgs(args, warnings, recoverableErrors)
  } else if (action.skill === 'collection.collect') {
    action.args = normalizeCollectArgs(args, warnings, recoverableErrors, options)
  } else if (action.skill === 'crafting.craft') {
    action.args = normalizeCraftArgs(args, warnings, recoverableErrors, options)
  } else if (action.skill === 'containers.search' || action.skill === 'containers.withdraw') {
    action.args = normalizeContainerItemArgs(action.skill, args, warnings, recoverableErrors, options)
  } else if (!action.args) {
    action.args = {}
  }

  const after = JSON.stringify(action.args || {})
  return {
    decision: normalized,
    warnings,
    recoverableErrors,
    fatalErrors,
    changed: before !== after
  }
}

module.exports = {
  normalizePlannerDecisionArgs,
  normalizeMovementStopArgs,
  normalizeDepositArgs,
  normalizeCollectArgs,
  normalizeCraftArgs
}
