const { runPlannerCycles, survivalBlocksPlan } = require('./planner-runner')

function parseBotCommand (text) {
  const raw = String(text || '').trim()
  const match = raw.match(/^bot(?:\s+(.+))?$/i)
  if (!match) return null
  return (match[1] || '').trim()
}

function summarizeActionResult (result) {
  if (!result) return 'resultado vazio'
  return result.ok
    ? `feito — ${result.message || result.code || result.skill}.`
    : `não consegui — ${result.reason || result.message || result.code || 'falha desconhecida'}.`
}

async function runPlannerCommand ({
  userMessage,
  context,
  survivalGuard,
  history = [],
  maxSteps = 1,
  dryRun = false,
  allowedRisks = ['low', 'medium']
}) {
  const run = await runPlannerCycles({
    userMessage,
    context,
    survivalGuard,
    history,
    maxSteps,
    dryRun,
    allowedRisks
  })

  if (run.status === 'ask_user') {
    return { ...run, chat: `Bot: ${run.reason || 'Preciso de mais informacao.'}` }
  }

  if (run.status === 'completed' || run.status === 'max_steps_reached') {
    return { ...run, chat: `Bot: ${summarizeActionResult(run.result)}` }
  }

  if (run.status === 'dry_run') {
    return { ...run, chat: `Bot: feito — ${run.reason}.` }
  }

  if (run.status === 'execute_failed' || run.status === 'execute_failed_retryable') {
    return { ...run, chat: `Bot: ${summarizeActionResult(run.result)}` }
  }

  if (run.status === 'stopped') {
    return { ...run, chat: `Bot: ${run.reason || 'parando.'}` }
  }

  if (run.status === 'invalid_decision' || run.status === 'unknown_skill') {
    return { ...run, chat: `Bot: não consegui montar uma ação válida — ${run.reason}.` }
  }

  if (run.status === 'plan_failed') {
    return { ...run, chat: `Bot: não vou fazer isso agora — ${run.reason}.` }
  }

  if (run.status === 'active_skill_blocked' || run.status === 'survival_blocked' || run.status === 'risk_blocked' || run.status === 'repetition_blocked') {
    return { ...run, chat: `Bot: não vou fazer isso agora — ${run.reason}.` }
  }

  return {
    ...run,
    chat: run.ok ? `Bot: feito — ${run.reason}.` : `Bot: não consegui — ${run.reason || run.status}.`
  }
}

module.exports = {
  parseBotCommand,
  runPlannerCommand,
  summarizeActionResult,
  survivalBlocksPlan
}
