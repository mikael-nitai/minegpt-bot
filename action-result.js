function createActionResult ({
  ok,
  skill,
  message = '',
  reason = '',
  data = {},
  startedAt = Date.now(),
  finishedAt = Date.now()
}) {
  return {
    ok: Boolean(ok),
    skill,
    message,
    reason,
    data,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt)
  }
}

function actionOk (skill, message = '', data = {}, startedAt = Date.now()) {
  return createActionResult({
    ok: true,
    skill,
    message,
    data,
    startedAt,
    finishedAt: Date.now()
  })
}

function actionFail (skill, reason, data = {}, startedAt = Date.now()) {
  return createActionResult({
    ok: false,
    skill,
    reason: reason || 'falha desconhecida',
    message: reason || 'falha desconhecida',
    data,
    startedAt,
    finishedAt: Date.now()
  })
}

async function runAction (skill, fn) {
  const startedAt = Date.now()

  try {
    const value = await fn()
    if (value && typeof value === 'object' && 'ok' in value && 'durationMs' in value) return value
    return actionOk(skill, 'acao concluida', { value }, startedAt)
  } catch (err) {
    return actionFail(skill, err.message, { error: err.stack }, startedAt)
  }
}

module.exports = {
  createActionResult,
  actionOk,
  actionFail,
  runAction
}
