function createActionResult ({
  ok,
  skill,
  message = '',
  reason = '',
  data = {},
  code = '',
  severity = null,
  retryable = false,
  missingRequirements = [],
  worldChanged = false,
  inventoryDelta = [],
  positionDelta = null,
  suggestedNextActions = [],
  startedAt = Date.now(),
  finishedAt = Date.now()
}) {
  const success = Boolean(ok)

  return {
    ok: success,
    skill,
    code: code || (success ? 'ok' : 'error'),
    severity: severity || (success ? 'info' : 'error'),
    retryable: Boolean(retryable),
    reason,
    message,
    missingRequirements: Array.isArray(missingRequirements) ? missingRequirements : [],
    worldChanged: Boolean(worldChanged),
    inventoryDelta: Array.isArray(inventoryDelta) ? inventoryDelta : [],
    positionDelta,
    suggestedNextActions: Array.isArray(suggestedNextActions) ? suggestedNextActions : [],
    data,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt)
  }
}

function actionOk (skill, message = '', data = {}, startedAt = Date.now(), meta = {}) {
  return createActionResult({
    ok: true,
    skill,
    message,
    data,
    ...meta,
    startedAt,
    finishedAt: Date.now()
  })
}

function actionFail (skill, reason, data = {}, startedAt = Date.now(), meta = {}) {
  return createActionResult({
    ok: false,
    skill,
    reason: reason || 'falha desconhecida',
    message: reason || 'falha desconhecida',
    data,
    ...meta,
    startedAt,
    finishedAt: Date.now()
  })
}

function itemRequirement (name, count = 1, details = {}) {
  return {
    type: 'item',
    name,
    count,
    ...details
  }
}

function requirement (type, details = {}) {
  return {
    type,
    ...details
  }
}

function suggestSkillAction (skill, args = {}, reason = '') {
  return {
    type: 'skill',
    skill,
    args,
    reason
  }
}

async function runAction (skill, fn) {
  const startedAt = Date.now()

  try {
    const value = await fn()
    if (value && typeof value === 'object' && 'ok' in value && 'durationMs' in value) return value
    return actionOk(skill, 'acao concluida', { value }, startedAt)
  } catch (err) {
    return actionFail(skill, err.message, { error: err.stack }, startedAt, {
      code: err.actionCode || 'exception',
      retryable: Boolean(err.retryable),
      severity: err.severity || 'error'
    })
  }
}

module.exports = {
  createActionResult,
  actionOk,
  actionFail,
  itemRequirement,
  requirement,
  suggestSkillAction,
  runAction
}
