const DEFAULT_LIMITS = {
  inventoryItems: 16,
  inventoryFocusItems: 5,
  topAttention: 5,
  hazards: 3,
  resources: 4,
  drops: 3,
  perceptionContainers: 3,
  containerRoles: 5,
  containerKnownItems: 6,
  containerNearby: 3,
  recentCollections: 2,
  skills: 32,
  history: 5,
  missingRequirements: 3,
  suggestedNextActions: 3
}

function truncateText (value, maxLength = 180) {
  const text = String(value || '')
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function jsonSafe (value, fallback = null) {
  const seen = new WeakSet()

  try {
    return JSON.parse(JSON.stringify(value, (_key, current) => {
      if (typeof current === 'function') return undefined
      if (typeof current === 'bigint') return Number(current)
      if (current && typeof current === 'object') {
        if (seen.has(current)) return undefined
        seen.add(current)
      }
      return current
    }))
  } catch {
    return fallback
  }
}

function asArray (value) {
  return Array.isArray(value) ? value : []
}

function compactPosition (position) {
  if (!position || typeof position !== 'object') return null
  const compact = {}
  for (const key of ['x', 'y', 'z']) {
    if (Number.isFinite(position[key])) compact[key] = Math.round(position[key] * 10) / 10
  }
  return Object.keys(compact).length > 0 ? compact : null
}

function normalizeText (text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function userMentionTerms (userMessage) {
  return new Set(normalizeText(userMessage)
    .split(/[^a-z0-9_]+/)
    .filter(term => term.length >= 3))
}

function itemMatchesTerms (item, terms) {
  const name = normalizeText(item?.name)
  if (!name) return false
  for (const term of terms) {
    if (name.includes(term) || term.includes(name)) return true
  }
  return false
}

function compactItem (item) {
  if (!item || typeof item !== 'object') return null
  const name = typeof item.name === 'string' ? item.name : null
  if (!name) return null
  return {
    name,
    count: Number.isFinite(item.count) ? item.count : null
  }
}

function addUniqueItem (items, item, limit = Infinity) {
  const compact = compactItem(item)
  if (!compact) return
  if (items.some(existing => existing.name === compact.name)) return
  if (items.length >= limit) return
  items.push(compact)
}

function compactInventoryForLlm (inventory, userMessage, limits = DEFAULT_LIMITS) {
  const terms = userMentionTerms(userMessage)
  const rawItems = asArray(inventory?.items)
  const focus = inventory?.focus || {}
  const selected = []

  for (const item of rawItems.filter(item => itemMatchesTerms(item, terms))) {
    addUniqueItem(selected, item, limits.inventoryItems)
  }

  for (const groupName of ['tools', 'food', 'basicBlocks', 'resources']) {
    for (const item of asArray(focus[groupName]).slice(0, limits.inventoryFocusItems)) {
      addUniqueItem(selected, item, limits.inventoryItems)
    }
  }

  for (const item of rawItems) addUniqueItem(selected, item, limits.inventoryItems)

  return {
    items: selected,
    totalKinds: Number.isFinite(inventory?.totalKinds) ? inventory.totalKinds : rawItems.length,
    hasFreeSlot: focus.hasFreeSlot ?? null
  }
}

function compactToken (token) {
  if (!token || typeof token !== 'object') return null
  return {
    kind: token.kind || null,
    name: token.name || null,
    category: token.category || null,
    score: Number.isFinite(token.score) ? token.score : null,
    distance: Number.isFinite(token.distance) ? Math.round(token.distance * 10) / 10 : null,
    position: compactPosition(token.position),
    heads: token.heads
      ? {
          danger: token.heads.danger || 0,
          resource: token.heads.resource || 0,
          objective: token.heads.objective || 0,
          opportunity: token.heads.opportunity || 0
        }
      : undefined,
    actionHint: token.actionHint || token.recommendedAction || null
  }
}

function compactTokenList (tokens, limit) {
  return asArray(tokens)
    .slice(0, limit)
    .map(compactToken)
    .filter(Boolean)
}

function compactPlannerStateForLlm (plannerState = {}, options = {}) {
  const limits = options.limits || DEFAULT_LIMITS
  const userMessage = options.userMessage || ''
  const safeState = jsonSafe(plannerState, {}) || {}
  const vitals = safeState.vitals || {}
  const perception = safeState.perception || {}
  const allowedActions = safeState.allowedActions || {}

  return {
    status: {
      online: Boolean(safeState.online),
      canAct: Boolean(safeState.canAct),
      busy: Boolean(safeState.busy),
      reconnecting: Boolean(safeState.reconnecting),
      activeSkill: safeState.activeSkill || null
    },
    vitals: {
      health: safeState.health ?? vitals.health ?? null,
      food: safeState.food ?? vitals.food ?? null,
      oxygen: safeState.oxygen ?? vitals.oxygen ?? null,
      position: compactPosition(safeState.position || vitals.position)
    },
    heldItem: compactItem(safeState.heldItem),
    inventory: compactInventoryForLlm(safeState.inventory || {}, userMessage, limits),
    objective: safeState.objective || null,
    perception: {
      topAttention: compactTokenList(perception.topAttention, limits.topAttention),
      hazards: compactTokenList(perception.hazards, limits.hazards),
      resources: compactTokenList(perception.resources, limits.resources),
      drops: compactTokenList(perception.drops, limits.drops),
      containers: compactTokenList(perception.containers, limits.perceptionContainers)
    },
    allowedActions: {
      collectTargets: asArray(allowedActions.collectTargets).slice(0, 24),
      collectCategories: asArray(allowedActions.collectCategories).slice(0, 12)
    },
    survival: safeState.survival
      ? {
          enabled: Boolean(safeState.survival.enabled),
          severity: safeState.survival.severity ?? null,
          safeToAct: safeState.survival.safeToAct ?? null,
          top: truncateText(safeState.survival.top?.reason || safeState.survival.top || '', 140),
          summary: truncateText(safeState.survival.summary || '', 180)
        }
      : null,
    navigation: {
      summary: truncateText(safeState.navigation?.summary || safeState.navigation || '', 160)
    },
    containers: safeState.containers
      ? {
          known: safeState.containers.known ?? null,
          recentlyScanned: safeState.containers.recentlyScanned ?? null,
          topRoles: asArray(safeState.containers.topRoles).slice(0, limits.containerRoles),
          nearby: compactTokenList(safeState.containers.nearby, limits.containerNearby),
          importantKnownItems: asArray(safeState.containers.importantKnownItems).slice(0, limits.containerKnownItems)
        }
      : null,
    recentCollections: asArray(safeState.recentCollections).slice(0, limits.recentCollections)
  }
}

function compactSkillsForLlm (skills = [], options = {}) {
  const limits = options.limits || DEFAULT_LIMITS
  return asArray(skills)
    .filter(skill => skill && typeof skill.id === 'string')
    .slice(0, limits.skills)
    .map(skill => ({
      id: skill.id,
      description: truncateText(skill.description || '', 120),
      whenToUse: truncateText(skill.whenToUse || skill.plannerHints || '', 220),
      whenNotToUse: truncateText(skill.whenNotToUse || '', 180),
      inputSchema: jsonSafe(skill.inputSchema || {}, {}),
      naturalExamples: asArray(skill.naturalExamples).slice(0, 5).map(example => truncateText(example, 80)),
      argsExamples: asArray(skill.argsExamples).slice(0, 5).map(example => jsonSafe(example, {})),
      risk: skill.risk || 'low',
      plannerHints: truncateText(skill.plannerHints || '', 180),
      safetyNotes: asArray(skill.safetyNotes).slice(0, 4).map(note => truncateText(note, 120))
    }))
}

function compactDecisionForHistory (decision) {
  if (!decision) return null
  return {
    intent: decision.intent || null,
    nextAction: decision.nextAction
      ? {
          skill: decision.nextAction.skill,
          args: jsonSafe(decision.nextAction.args || {}, {})
        }
      : null,
    reasonSummary: truncateText(decision.reasonSummary || '', 160),
    risk: decision.risk || null
  }
}

function compactHistoryForLlm (history = [], options = {}) {
  const limits = options.limits || DEFAULT_LIMITS
  return asArray(history)
    .slice(-limits.history)
    .map(entry => ({
      step: entry.step ?? null,
      status: entry.status || null,
      reason: truncateText(entry.reason || '', 180),
      decision: compactDecisionForHistory(entry.decision),
      plan: entry.plan
        ? {
            ok: Boolean(entry.plan.ok),
            skill: entry.plan.skill || null,
            code: entry.plan.code || null,
            reason: truncateText(entry.plan.reason || '', 160),
            missingRequirements: asArray(entry.plan.missingRequirements).slice(0, limits.missingRequirements)
          }
        : null,
      result: entry.result
        ? {
            ok: Boolean(entry.result.ok),
            skill: entry.result.skill || null,
            code: entry.result.code || null,
            reason: truncateText(entry.result.reason || entry.result.message || '', 160),
            retryable: Boolean(entry.result.retryable),
            missingRequirements: asArray(entry.result.missingRequirements).slice(0, limits.missingRequirements),
            suggestedNextActions: asArray(entry.result.suggestedNextActions).slice(0, limits.suggestedNextActions)
          }
        : null
    }))
}

function buildPlannerPromptPayload ({
  userMessage,
  plannerState = {},
  skills = [],
  history = [],
  schema = null,
  profile = null,
  limits = DEFAULT_LIMITS
}) {
  const payload = {
    userMessage: String(userMessage || ''),
    plannerState: compactPlannerStateForLlm(plannerState, { userMessage, limits }),
    skills: compactSkillsForLlm(skills, { limits }),
    history: compactHistoryForLlm(history, { limits }),
    schema: jsonSafe(schema, null)
  }

  const serialized = JSON.stringify(payload)
  return {
    ...payload,
    metrics: {
      approxChars: serialized.length,
      skillsSent: payload.skills.length,
      profile: profile?.name || null,
      model: profile?.model || null
    }
  }
}

module.exports = {
  DEFAULT_LIMITS,
  buildPlannerPromptPayload,
  compactPlannerStateForLlm,
  compactSkillsForLlm,
  compactHistoryForLlm,
  jsonSafe
}
