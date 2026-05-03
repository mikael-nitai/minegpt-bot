function cloneJsonSafe (value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function parseStringRule (rule) {
  const optional = /\boptional\b/.test(rule)
  const enumValues = rule.includes('|') && !/\bstring\b|\bnumber\b|\bboolean\b|\bobject\b|\barray\b/.test(rule)
    ? rule.split('|').map(value => value.trim()).filter(Boolean)
    : null
  const rangeMatch = rule.match(/\b(\d+)\s*-\s*(\d+)\b/)
  const maxMatch = rule.match(/\bmax\s+(\d+)\b/)
  const minMatch = rule.match(/\bmin\s+(\d+)\b/)
  const schema = enumValues
    ? { type: 'string', enum: enumValues }
    : {
        type: rule.includes('number')
          ? 'number'
          : rule.includes('boolean')
            ? 'boolean'
            : rule.includes('object')
              ? 'object'
              : rule.includes('array')
                ? 'array'
                : 'string'
      }

  if (schema.type === 'number') {
    if (rangeMatch) {
      schema.minimum = Number(rangeMatch[1])
      schema.maximum = Number(rangeMatch[2])
    } else {
      if (minMatch) schema.minimum = Number(minMatch[1])
      if (maxMatch) schema.maximum = Number(maxMatch[1])
    }
  }

  return { schema, optional }
}

function normalizeInputSchemaForPlanner (inputSchema = {}) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }

  if (inputSchema.type === 'object' && inputSchema.properties) {
    return cloneJsonSafe(inputSchema)
  }

  const properties = {}
  const required = []

  for (const [field, rawRule] of Object.entries(inputSchema)) {
    if (typeof rawRule === 'string') {
      const parsed = parseStringRule(rawRule)
      properties[field] = parsed.schema
      if (!parsed.optional) required.push(field)
      continue
    }

    if (rawRule && typeof rawRule === 'object') {
      properties[field] = cloneJsonSafe(rawRule)
      if (!rawRule.optional) required.push(field)
      delete properties[field].optional
      continue
    }

    properties[field] = { type: 'string' }
    required.push(field)
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false
  }
}

function skillCardDetails (skill) {
  const id = skill?.id || ''
  const details = {
    whenToUse: skill?.plannerHints || skill?.description || '',
    whenNotToUse: '',
    naturalExamples: [],
    argsExamples: [],
    safetyNotes: []
  }

  if (id === 'movement.stop') {
    details.whenToUse = 'Use apenas quando o usuario pedir explicitamente parar, cancelar, interromper ou recuperar controle.'
    details.whenNotToUse = 'Nao use para "para frente", "para mim", "para o bau" ou outras frases onde "para" e preposicao.'
    details.naturalExamples = ['pare', 'parar agora', 'cancela isso']
    details.argsExamples = [{}]
    details.safetyNotes = ['Args sempre {}.', 'Pode cancelar skill ativa.']
  } else if (id === 'movement.come_here') {
    details.whenToUse = 'Use quando o usuario pedir para o bot vir ate o dono.'
    details.whenNotToUse = 'Nao use para seguir continuamente nem para coordenadas.'
    details.naturalExamples = ['venha aqui', 'vem para mim', 'chega perto de mim']
    details.argsExamples = [{}]
  } else if (id === 'movement.follow_owner') {
    details.whenToUse = 'Use quando o usuario pedir acompanhamento continuo.'
    details.whenNotToUse = 'Nao use para uma aproximacao pontual; nesse caso use movement.come_here.'
    details.naturalExamples = ['me segue', 'siga comigo', 'acompanhe meus passos']
    details.argsExamples = [{}]
    details.safetyNotes = ['Acao continua; use movement.stop para interromper.']
  } else if (id === 'collection.collect') {
    details.whenToUse = 'Use para quebrar, coletar, minerar ou cortar blocos do mundo.'
    details.whenNotToUse = 'Nao use para pegar item em bau, craftar item ou consultar estado.'
    details.naturalExamples = ['pegue madeira', 'quebre tronco de carvalho', 'minere carvao', 'colete pedra']
    details.argsExamples = [
      { target: 'oak_log', count: 1 },
      { target: 'coal_ore', count: 1 },
      { target: 'stone', count: 1 }
    ]
    details.safetyNotes = ['Altera o mundo.', 'Use alvos concretos percebidos quando possivel.']
  } else if (id === 'crafting.craft') {
    details.whenToUse = 'Use para fabricar item conhecido com receita.'
    details.whenNotToUse = 'Nao use para coletar materiais no mundo ou retirar de bau.'
    details.naturalExamples = ['faca tochas', 'crafta mesa de trabalho', 'faz gravetos']
    details.argsExamples = [
      { target: 'torch', count: 4 },
      { target: 'crafting_table', count: 1 },
      { target: 'stick', count: 4 }
    ]
  } else if (id === 'containers.deposit') {
    details.whenToUse = 'Use para guardar item, blocos, recursos, drops ou tudo em container proximo.'
    details.whenNotToUse = 'Nao use para procurar ou retirar item de bau.'
    details.naturalExamples = ['guarda blocos', 'guarda recursos', 'guarda drops', 'guarda tudo', 'guarda carvao']
    details.argsExamples = [
      { mode: 'blocks' },
      { mode: 'resources' },
      { mode: 'drops' },
      { mode: 'all' },
      { mode: 'target', target: 'coal', count: 16 }
    ]
    details.safetyNotes = ['mode=all exige confirmacao.', 'Nao envie target/count em modos blocks/resources/drops/all.']
  } else if (id === 'containers.search') {
    details.whenToUse = 'Use para localizar item em container sem retirar.'
    details.whenNotToUse = 'Nao use quando o usuario pedir pegar/retirar/trazer item.'
    details.naturalExamples = ['procura carvao no bau', 've se tem ferro no container']
    details.argsExamples = [{ target: 'coal' }, { target: 'iron_ingot' }]
  } else if (id === 'containers.withdraw') {
    details.whenToUse = 'Use para retirar item de container conhecido/proximo.'
    details.whenNotToUse = 'Nao use para apenas procurar ou para guardar itens.'
    details.naturalExamples = ['pega 16 carvao no bau', 'traga ferro do container']
    details.argsExamples = [{ target: 'coal', count: 16 }, { target: 'iron_ingot', count: 1 }]
  } else if (id === 'drops.collect') {
    details.whenToUse = 'Use para pegar itens dropados no chao.'
    details.whenNotToUse = 'Nao use para minerar blocos ainda intactos.'
    details.naturalExamples = ['pegue os drops', 'apanhe o que caiu']
    details.argsExamples = [{}, { target: 'coal' }]
  } else if (id === 'state.snapshot' || id === 'state.planner_snapshot') {
    details.whenToUse = 'Use para consultar estado, inventario resumido, posicao ou diagnostico.'
    details.whenNotToUse = 'Nao use para executar uma acao no mundo.'
    details.naturalExamples = ['estado', 'status', 'como voce esta']
    details.argsExamples = [{}]
  } else if (id === 'survival.status') {
    details.whenToUse = 'Use para consultar risco de sobrevivencia.'
    details.whenNotToUse = 'Nao use para mudar configuracao de survival.'
    details.naturalExamples = ['survival status', 'estamos seguros?']
    details.argsExamples = [{}]
  }

  return details
}

function skillToPlannerTool (skill) {
  const card = skillCardDetails(skill)
  return {
    id: skill.id,
    description: skill.description || '',
    inputSchema: normalizeInputSchemaForPlanner(skill.inputSchema || {}),
    risk: skill.risk || 'low',
    effects: cloneJsonSafe(skill.effects || []),
    cost: cloneJsonSafe(skill.cost || { base: 1 }),
    plannerHints: skill.plannerHints || '',
    whenToUse: card.whenToUse,
    whenNotToUse: card.whenNotToUse,
    naturalExamples: card.naturalExamples,
    argsExamples: card.argsExamples,
    safetyNotes: card.safetyNotes
  }
}

function skillsToPlannerTools (skills = []) {
  return skills
    .filter(skill => skill && typeof skill.id === 'string')
    .map(skillToPlannerTool)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function skillRegistryToPlannerTools (skillRegistry) {
  if (!skillRegistry || typeof skillRegistry.list !== 'function') return []
  return skillsToPlannerTools(skillRegistry.list())
}

module.exports = {
  skillToPlannerTool,
  skillsToPlannerTools,
  skillRegistryToPlannerTools,
  normalizeInputSchemaForPlanner,
  skillCardDetails
}
