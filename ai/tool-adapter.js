function cloneJsonSafe (value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function skillToPlannerTool (skill) {
  return {
    id: skill.id,
    description: skill.description || '',
    inputSchema: cloneJsonSafe(skill.inputSchema || {}),
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
  skillRegistryToPlannerTools
}
