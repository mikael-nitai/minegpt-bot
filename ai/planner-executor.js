const { decideNextAction } = require('./planner')
const { skillRegistryToPlannerTools } = require('./tool-adapter')

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

function survivalBlocksPlan (survivalStatus, plannedSkill) {
  if (!survivalStatus || !plannedSkill) return null
  const severity = survivalStatus.severity
  if (severity !== 'critical' && severity !== 'high') return null
  if (plannedSkill.id === 'movement.stop' || plannedSkill.risk === 'low') return null
  return `survival ${severity}: ${survivalStatus.top || survivalStatus.summary || 'risco alto'}`
}

async function runPlannerCommand ({
  userMessage,
  context,
  survivalGuard,
  history = []
}) {
  const skillRegistry = context.skillRegistry
  const plannerState = context.stateReporter.getPlannerSnapshot()
  const skills = skillRegistryToPlannerTools(skillRegistry)
  const decision = await decideNextAction({
    userMessage,
    plannerState,
    skills,
    history
  })

  if (decision.intent === 'ask_user') {
    return { ok: false, chat: `Bot: ${decision.askUser || 'Preciso de mais informacao.'}`, decision }
  }

  if (decision.intent === 'refuse') {
    return { ok: false, chat: `Bot: não vou fazer isso agora — ${decision.reasonSummary || 'pedido recusado'}.`, decision }
  }

  if (decision.intent === 'stop') {
    return { ok: false, chat: `Bot: ${decision.reasonSummary || 'parando.'}`, decision }
  }

  if (decision.intent !== 'execute_skill' || !decision.nextAction) {
    return { ok: false, chat: 'Bot: não consegui montar uma ação válida.', decision }
  }

  const { skill, args } = decision.nextAction
  const plannedSkill = skillRegistry.get(skill)
  if (!plannedSkill) {
    return { ok: false, chat: `Bot: não vou fazer isso agora — skill inexistente: ${skill}.`, decision }
  }

  if (context.activeSkill && skill !== 'movement.stop') {
    return { ok: false, chat: `Bot: não vou fazer isso agora — já estou executando ${context.activeSkill.name}.`, decision }
  }

  const survivalStatus = survivalGuard.assess()
  const survivalBlockReason = survivalBlocksPlan(survivalStatus, plannedSkill)
  if (survivalBlockReason) {
    return { ok: false, chat: `Bot: não vou fazer isso agora — ${survivalBlockReason}.`, decision }
  }

  const executionContext = {
    plannerMode: true,
    explicitUserIntent: true
  }
  const plan = await skillRegistry.plan(skill, args, executionContext)
  if (!plan.ok) {
    return { ok: false, chat: `Bot: não vou fazer isso agora — ${plan.reason || plan.code}.`, decision, plan }
  }

  const result = await skillRegistry.execute(skill, args, executionContext)
  return {
    ok: result.ok,
    chat: `Bot: ${summarizeActionResult(result)}`,
    decision,
    plan,
    result
  }
}

module.exports = {
  parseBotCommand,
  runPlannerCommand,
  summarizeActionResult,
  survivalBlocksPlan
}
