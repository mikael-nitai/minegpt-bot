const {
  normalizeText,
  hasAny,
  executionDecision,
  askUserDecision,
  validateOrAsk,
  requireSkillOrAsk
} = require('./provider-utils')

async function decideNextAction ({
  userMessage,
  plannerState = {},
  skills = [],
  history = []
}) {
  const text = normalizeText(userMessage)
  const userGoal = String(userMessage || '').trim()
  const normalizedGoal = userGoal || 'comando vazio'
  let decision

  if (!text) {
    decision = askUserDecision(normalizedGoal, 'O que voce quer que eu faca?', 'Comando vazio para o planner mockado.')
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
    decision = askUserDecision(userGoal, 'Nao entendi ainda. Voce quer que eu va, siga, colete madeira, crafte uma mesa ou mostre estado?', 'Comando ambiguo para o planner mockado.')
  }

  decision = requireSkillOrAsk({ decision, skills, userGoal, mode: 'mock' })
  return validateOrAsk({ decision, skills, userGoal, mode: 'mock', plannerState, history })
}

module.exports = {
  name: 'mock',
  local: false,
  decideNextAction,
  normalizeText
}
