const {
  normalizeText,
  hasAny,
  executionDecision,
  askUserDecision,
  validateOrAsk,
  requireSkillOrAsk,
  firstPositiveInteger
} = require('./provider-utils')

const COLLECT_TARGETS = [
  { terms: ['madeira', 'tronco', 'arvore'], target: 'madeira' },
  { terms: ['pedra', 'pedras', 'stone', 'cobblestone'], target: 'pedra' },
  { terms: ['carvao', 'coal'], target: 'carvao' }
]

function targetFromText (text, targets = COLLECT_TARGETS) {
  return targets.find(entry => hasAny(text, entry.terms))?.target || null
}

function modeFromDepositText (text) {
  if (hasAny(text, ['guardar tudo', 'guarda tudo'])) return 'all'
  if (hasAny(text, ['guardar recursos', 'guarda recursos'])) return 'resources'
  if (hasAny(text, ['guardar blocos', 'guarda blocos'])) return 'blocks'
  if (hasAny(text, ['guardar drops', 'guarda drops'])) return 'drops'
  return null
}

function craftTargetFromText (text) {
  if (hasAny(text, ['crafting table', 'mesa de trabalho'])) return 'crafting_table'
  if (hasAny(text, ['tocha', 'tochas', 'torch', 'torches'])) return 'torch'
  return null
}

async function decideNextAction ({
  userMessage,
  plannerState = {},
  skills = [],
  history = []
}) {
  const text = normalizeText(userMessage)
  const userGoal = String(userMessage || '').trim()
  const normalizedGoal = userGoal || 'comando vazio'
  const count = firstPositiveInteger(text)
  let decision

  if (!text) {
    decision = askUserDecision(normalizedGoal, 'O que voce quer que eu faca?', 'Comando vazio para o planner rule_based.')
  } else if (hasAny(text, ['parar', 'para', 'pare', 'cancela', 'cancelar'])) {
    decision = executionDecision({
      userGoal,
      skill: 'movement.stop',
      reasonSummary: 'Usuario pediu para parar.',
      confidence: 0.95,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['vir aqui', 'vem aqui', 'venha', 'vem'])) {
    decision = executionDecision({
      userGoal,
      skill: 'movement.come_here',
      reasonSummary: 'Usuario quer que o bot se aproxime.',
      confidence: 0.9
    })
  } else if (hasAny(text, ['me segue', 'seguir', 'siga'])) {
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
      confidence: 0.9,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['pega drops', 'pegar drops', 'coleta drops', 'coletar drops'])) {
    decision = executionDecision({
      userGoal,
      skill: 'drops.collect',
      reasonSummary: 'Usuario pediu coleta de drops proximos.',
      confidence: 0.85,
      stopAfterThis: true
    })
  } else if (hasAny(text, ['procura', 'procurar', 'busca', 'buscar']) && hasAny(text, ['bau', 'baus', 'container', 'containers'])) {
    const target = targetFromText(text, [
      ...COLLECT_TARGETS,
      { terms: ['ferro', 'iron'], target: 'ferro' },
      { terms: ['tocha', 'tochas'], target: 'torch' }
    ])
    decision = target
      ? executionDecision({
          userGoal,
          skill: 'containers.search',
          args: { target },
          reasonSummary: 'Usuario pediu busca de item em container.',
          confidence: 0.85,
          stopAfterThis: true
        })
      : askUserDecision(userGoal, 'Qual item voce quer que eu procure no container?', 'Busca em container sem alvo claro.')
  } else if (hasAny(text, ['guardar', 'guarda'])) {
    const mode = modeFromDepositText(text)
    decision = mode
      ? executionDecision({
          userGoal,
          skill: 'containers.deposit',
          args: { mode },
          reasonSummary: 'Usuario pediu deposito em container.',
          risk: 'medium',
          confidence: 0.85,
          stopAfterThis: true
        })
      : askUserDecision(userGoal, 'O que voce quer que eu guarde: blocos, recursos, drops ou tudo?', 'Deposito em container sem modo claro.')
  } else if (hasAny(text, ['faz', 'fazer', 'crafta', 'craftar', 'crafte'])) {
    const target = craftTargetFromText(text)
    decision = target
      ? executionDecision({
          userGoal,
          skill: 'crafting.craft',
          args: { target, count: count || 1 },
          reasonSummary: 'Usuario pediu crafting simples.',
          risk: 'medium',
          confidence: 0.85,
          stopAfterThis: true
        })
      : askUserDecision(userGoal, 'Qual item voce quer que eu crafte?', 'Crafting sem alvo claro.')
  } else if (hasAny(text, ['pega', 'pegar', 'coleta', 'coletar', 'minera', 'minerar'])) {
    const target = targetFromText(text)
    decision = target
      ? executionDecision({
          userGoal,
          skill: 'collection.collect',
          args: { target, count: count || 1 },
          reasonSummary: 'Usuario pediu coleta simples de recurso.',
          risk: 'medium',
          confidence: 0.82,
          stopAfterThis: true
        })
      : askUserDecision(userGoal, 'Qual recurso voce quer que eu colete?', 'Coleta sem alvo claro.')
  } else {
    decision = askUserDecision(userGoal, 'Nao entendi ainda. Voce quer que eu va, siga, colete, crafte, procure em bau, guarde itens ou mostre estado?', 'Comando nao mapeado pelo planner rule_based.')
  }

  decision = requireSkillOrAsk({ decision, skills, userGoal, mode: 'rule_based' })
  return validateOrAsk({ decision, skills, userGoal, mode: 'rule_based', plannerState, history })
}

module.exports = {
  name: 'rule_based',
  local: true,
  decideNextAction,
  normalizeText,
  targetFromText
}
