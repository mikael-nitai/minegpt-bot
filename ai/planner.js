const { makePlannerDecision, validatePlannerDecision } = require('./planner-schema')

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

function askUserDecision (userGoal, askUser, reasonSummary = 'Comando ambiguo para o planner mockado.') {
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

async function decideNextAction ({
  userMessage,
  plannerState = {},
  skills = [],
  history = []
}) {
  const text = normalizeText(userMessage)
  const userGoal = String(userMessage || '').trim()
  let decision

  if (!text) {
    decision = askUserDecision(userGoal, 'O que voce quer que eu faca?')
  } else if (hasAny(text, ['parar', 'pare', 'cancela', 'cancelar'])) {
    decision = executionDecision({
      userGoal,
      skill: 'movement.stop',
      reasonSummary: 'Usuario pediu para parar.',
      confidence: 0.95,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['vir aqui', 'vem', 'venha'])) {
    decision = executionDecision({
      userGoal,
      skill: 'movement.come_here',
      reasonSummary: 'Usuario quer que o bot se aproxime.',
      confidence: 0.9
    })
  } else if (hasAny(text, ['seguir', 'siga'])) {
    decision = executionDecision({
      userGoal,
      skill: 'movement.follow_owner',
      reasonSummary: 'Usuario quer acompanhamento continuo.',
      confidence: 0.9
    })
  } else if (hasAny(text, ['estado', 'status'])) {
    decision = executionDecision({
      userGoal,
      skill: 'state.snapshot',
      reasonSummary: 'Usuario pediu leitura do estado.',
      confidence: 0.85,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['crafting table', 'mesa de trabalho'])) {
    decision = executionDecision({
      userGoal,
      skill: 'crafting.craft',
      args: { target: 'crafting_table', count: 1 },
      reasonSummary: 'Usuario pediu uma crafting table.',
      risk: 'medium',
      confidence: 0.85,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['madeira', 'tronco', 'arvore', 'arvore'])) {
    decision = executionDecision({
      userGoal,
      skill: 'collection.collect',
      args: { target: 'madeira', count: 1 },
      reasonSummary: 'Usuario pediu coleta simples de madeira.',
      risk: 'medium',
      confidence: 0.8,
      stopAfterThis: true
    })
  } else {
    decision = askUserDecision(userGoal, 'Nao entendi ainda. Voce quer que eu va, siga, colete madeira, crafte uma mesa ou mostre estado?')
  }

  if (decision.intent === 'execute_skill' && !skillExists(skills, decision.nextAction.skill)) {
    decision = askUserDecision(userGoal, `A skill ${decision.nextAction.skill} nao esta disponivel agora.`, 'Planner mockado escolheu skill ausente.')
  }

  const validation = validatePlannerDecision(decision, { skills })
  if (!validation.ok) {
    return {
      ...askUserDecision(userGoal, 'Nao consegui montar uma decisao valida para esse pedido.', validation.errors.join('; ')),
      validation
    }
  }

  return {
    ...decision,
    planner: {
      mode: 'mock',
      stateSeen: Boolean(plannerState),
      historySize: Array.isArray(history) ? history.length : 0
    },
    validation
  }
}

module.exports = {
  decideNextAction,
  normalizeText
}
