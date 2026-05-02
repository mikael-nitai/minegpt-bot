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

function skillToPlannerTool (skill) {
  return {
    id: skill.id,
    description: skill.description || '',
    inputSchema: normalizeInputSchemaForPlanner(skill.inputSchema || {}),
    risk: skill.risk || 'low',
    effects: cloneJsonSafe(skill.effects || []),
    cost: cloneJsonSafe(skill.cost || { base: 1 }),
    plannerHints: skill.plannerHints || ''
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
  normalizeInputSchemaForPlanner
}
