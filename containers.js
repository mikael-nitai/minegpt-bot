const { actionOk, actionFail, itemRequirement, suggestSkillAction } = require('./action-result')

const CONTAINER_SCAN_RADIUS = 16
const CONTAINER_SCAN_VERTICAL = 4
const MAX_CONTAINERS_PER_ACTION = 12
const MAX_CONTAINER_MEMORY = 80
const MEMORY_TTL_MS = 5 * 60 * 1000
const RECENT_FAILURE_COOLDOWN_MS = 20000
const OPEN_DISTANCE = 4.5
const OPEN_TIMEOUT_MS = 7000
const MOVE_TIMEOUT_MS = 12000
const ACTION_TIMEOUT_MS = 6000

const BASE_CONTAINER_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'dispenser',
  'dropper',
  'hopper'
])

const MOB_DROP_NAMES = new Set([
  'bone',
  'arrow',
  'string',
  'spider_eye',
  'rotten_flesh',
  'gunpowder',
  'slime_ball',
  'magma_cream',
  'leather',
  'feather',
  'egg',
  'wool',
  'ender_pearl'
])

const RESOURCE_NAMES = new Set([
  'coal',
  'charcoal',
  'iron_ingot',
  'raw_iron',
  'gold_ingot',
  'raw_gold',
  'copper_ingot',
  'raw_copper',
  'diamond',
  'emerald',
  'redstone',
  'lapis_lazuli',
  'quartz',
  'flint',
  'stick',
  'clay_ball'
])

const VALUABLE_NAMES = new Set([
  'diamond',
  'emerald',
  'netherite_scrap',
  'netherite_ingot',
  'ancient_debris',
  'gold_ingot',
  'raw_gold',
  'gold_block',
  'diamond_block',
  'emerald_block'
])

const TRASH_NAMES = new Set([
  'poisonous_potato',
  'dead_bush',
  'rotten_flesh'
])

const WOOD_SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped']

function isContainerBlockName (name) {
  if (!name) return false
  return BASE_CONTAINER_BLOCKS.has(name) ||
    name === 'shulker_box' ||
    name.endsWith('_shulker_box') ||
    name.endsWith('_chest')
}

function parsePositiveInteger (value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return null
  return number
}

function stripContainerSuffix (text) {
  return String(text || '')
    .trim()
    .replace(/\s+(?:em|no|na|nos|nas|do|da|dos|das|de)\s+(?:ba[uú]s?|containers?)(?:\s+pr[oó]ximos?)?$/i, '')
    .replace(/\s+(?:ba[uú]s?|containers?)(?:\s+pr[oó]ximos?)?$/i, '')
    .trim()
}

function parseAmountTarget (text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { count: null, target: '' }
  const count = parsePositiveInteger(parts[0])
  return count
    ? { count, target: parts.slice(1).join(' ') }
    : { count: null, target: parts.join(' ') }
}

function parseContainerSearchCommand (text) {
  const target = stripContainerSuffix(String(text || '').replace(/^procurar\s+/i, ''))
  return { target }
}

function parseContainerWithdrawCommand (text) {
  const withoutVerb = String(text || '').replace(/^(pegar|buscar)\s+/i, '')
  const stripped = stripContainerSuffix(withoutVerb)
  const { count, target } = parseAmountTarget(stripped)
  return { target, count: count || 1 }
}

function parseContainerDepositCommand (text) {
  const query = String(text || '').replace(/^guardar\s+/i, '').trim()
  if (query === 'tudo') return { mode: 'all', target: null, count: null }
  if (query === 'recursos') return { mode: 'resources', target: null, count: null }
  if (query === 'blocos') return { mode: 'blocks', target: null, count: null }
  if (query === 'drops') return { mode: 'drops', target: null, count: null }

  const { count, target } = parseAmountTarget(query)
  return { mode: 'target', target, count }
}

function isContainerCommandText (text) {
  return /\b(?:ba[uú]s?|containers?)\b/i.test(text)
}

function specificWoodRole (name) {
  for (const species of WOOD_SPECIES) {
    if (species === 'bamboo' && (name.startsWith('bamboo_') || name === 'bamboo')) return species
    if (name.startsWith(`${species}_`)) return species
  }
  return null
}

function specificStoneRole (name) {
  if (name === 'stone' || name.startsWith('stone_')) return 'stone'
  if (name === 'cobblestone' || name.startsWith('cobblestone_')) return 'cobblestone'
  if (name === 'andesite' || name.startsWith('andesite_')) return 'andesite'
  if (name === 'diorite' || name.startsWith('diorite_')) return 'diorite'
  if (name === 'granite' || name.startsWith('granite_')) return 'granite'
  if (name === 'deepslate' || name === 'cobbled_deepslate' || name.includes('deepslate')) return 'deepslate'
  return null
}

function classifyItemStorageRole (name, catalog) {
  const blockItem = Boolean(catalog?.data?.blocksByName?.[name])
  const wood = specificWoodRole(name)
  if (wood || catalog?.catalogItemHasCategory?.(name, 'wood') || name.endsWith('_log') || name.endsWith('_planks')) {
    return { primaryRole: blockItem ? 'blocks' : 'resources', secondaryRole: 'wood', specificRole: wood || 'unknown' }
  }

  const stone = specificStoneRole(name)
  if (stone || catalog?.catalogItemHasCategory?.(name, 'stone')) {
    return { primaryRole: 'blocks', secondaryRole: 'stone', specificRole: stone || 'unknown' }
  }

  if (VALUABLE_NAMES.has(name)) return { primaryRole: 'valuables', secondaryRole: 'valuable', specificRole: name }
  if (catalog?.foodNames?.has(name)) return { primaryRole: 'food', secondaryRole: 'food', specificRole: 'unknown' }
  if (name.endsWith('_pickaxe') || name.endsWith('_axe') || name.endsWith('_shovel') || name.endsWith('_hoe')) {
    return { primaryRole: 'tools', secondaryRole: 'tool', specificRole: name.replace(/^(wooden|stone|iron|golden|diamond|netherite)_/, '') }
  }
  if (name.endsWith('_sword') || name === 'shield' || name === 'bow' || name === 'crossbow' || name === 'trident' || name === 'mace') {
    return { primaryRole: 'combat', secondaryRole: 'weapon', specificRole: 'unknown' }
  }
  if (MOB_DROP_NAMES.has(name)) return { primaryRole: 'mob_drops', secondaryRole: 'drop', specificRole: name }
  if (RESOURCE_NAMES.has(name) || name.endsWith('_ore')) return { primaryRole: 'resources', secondaryRole: name.endsWith('_ore') ? 'ore' : 'resource', specificRole: 'unknown' }
  if (TRASH_NAMES.has(name)) return { primaryRole: 'trash', secondaryRole: 'trash', specificRole: name }
  if (blockItem) return { primaryRole: 'blocks', secondaryRole: 'building', specificRole: 'unknown' }
  return { primaryRole: 'unknown', secondaryRole: 'unknown', specificRole: 'unknown' }
}

function topRole (scores) {
  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries[0] || ['unknown', 0]
}

function classifyContainerItems (items = [], catalog) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.count || 0), 0)
  if (total <= 0) {
    return {
      primaryRole: 'unknown',
      secondaryRole: 'unknown',
      specificRole: 'unknown',
      confidence: 0,
      mixed: false,
      evidence: []
    }
  }

  const primaryScores = new Map()
  const secondaryScores = new Map()
  const specificScores = new Map()
  const evidenceByPrimary = new Map()

  for (const item of items) {
    if (!item?.name) continue
    const count = Math.max(0, item.count || 0)
    const role = classifyItemStorageRole(item.name, catalog)
    primaryScores.set(role.primaryRole, (primaryScores.get(role.primaryRole) || 0) + count)
    secondaryScores.set(`${role.primaryRole}:${role.secondaryRole}`, (secondaryScores.get(`${role.primaryRole}:${role.secondaryRole}`) || 0) + count)
    specificScores.set(`${role.primaryRole}:${role.secondaryRole}:${role.specificRole}`, (specificScores.get(`${role.primaryRole}:${role.secondaryRole}:${role.specificRole}`) || 0) + count)

    const evidence = evidenceByPrimary.get(role.primaryRole) || []
    evidence.push({ name: item.name, count, role })
    evidenceByPrimary.set(role.primaryRole, evidence)
  }

  const [primaryRole, primaryCount] = topRole(primaryScores)
  const primaryConfidence = primaryCount / total
  if (primaryConfidence < 0.7) {
    return {
      primaryRole: 'mixed',
      secondaryRole: 'mixed',
      specificRole: 'mixed',
      confidence: Number(primaryConfidence.toFixed(2)),
      mixed: true,
      evidence: [...items].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5).map(item => `${item.count}x ${item.name}`)
    }
  }

  const secondaryCandidates = [...secondaryScores.entries()]
    .filter(([key]) => key.startsWith(`${primaryRole}:`))
  const [secondaryKey, secondaryCount] = topRole(new Map(secondaryCandidates))
  const secondaryRole = secondaryKey.split(':')[1] || 'unknown'
  const secondaryConfidence = secondaryCount / primaryCount

  const safeSecondaryRole = secondaryConfidence >= 0.6 ? secondaryRole : 'mixed'
  let safeSpecificRole = 'unknown'
  let specificConfidence = 0

  if (safeSecondaryRole !== 'mixed') {
    const specificCandidates = [...specificScores.entries()]
      .filter(([key]) => key.startsWith(`${primaryRole}:${safeSecondaryRole}:`))
    const [specificKey, specificCount] = topRole(new Map(specificCandidates))
    const specificRole = specificKey.split(':')[2] || 'unknown'
    specificConfidence = specificCount / secondaryCount
    safeSpecificRole = specificConfidence >= 0.7 ? specificRole : 'mixed'
  }

  return {
    primaryRole,
    secondaryRole: safeSecondaryRole,
    specificRole: safeSpecificRole,
    confidence: Number(Math.min(primaryConfidence, secondaryConfidence || primaryConfidence, specificConfidence || 1).toFixed(2)),
    mixed: safeSecondaryRole === 'mixed' || safeSpecificRole === 'mixed',
    evidence: (evidenceByPrimary.get(primaryRole) || [])
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(item => `${item.count}x ${item.name}`)
  }
}

function createContainerHelpers ({
  getBot,
  Vec3,
  catalog,
  inventory,
  perception,
  goals,
  withTimeout,
  getActiveSkill,
  startSkill,
  finishSkill,
  assertSkillActive,
  getNavigationController,
  getReconnecting,
  survival
}) {
  const memory = new Map()

  function bot () {
    const current = getBot()
    if (!current) throw new Error('bot ainda nao inicializado')
    return current
  }

  function currentDimension () {
    return bot().game?.dimension || 'unknown'
  }

  function positionInfo (position) {
    return {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z)
    }
  }

  function positionKey (position, dimension = currentDimension()) {
    const pos = positionInfo(position)
    return `${dimension}:${pos.x},${pos.y},${pos.z}`
  }

  function vecFromPosition (position) {
    return new Vec3(position.x, position.y, position.z)
  }

  function itemStacksToCounts (items = []) {
    const counts = new Map()
    for (const item of items) {
      if (!item?.name) continue
      counts.set(item.name, (counts.get(item.name) || 0) + item.count)
    }

    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }))
  }

  function formatCounts (items = []) {
    return items.map(item => `${item.count}x ${item.name}`).join(', ')
  }

  function requestedItemRequirement (query, target, count = 1) {
    const names = targetCandidateNames(target)
    return itemRequirement(names[0] || String(query || 'item'), count, {
      query,
      candidates: names.slice(0, 6)
    })
  }

  function remainingDepositRequirements (remaining = []) {
    return remaining.map(item => itemRequirement(item.name, item.remaining, {
      reason: 'container sem espaco ou nao acessivel'
    }))
  }

  function getMemoryEntryAt (position, dimension = currentDimension()) {
    return memory.get(positionKey(position, dimension)) || null
  }

  function rememberBlock (block) {
    const key = positionKey(block.position)
    const existing = memory.get(key)
    const now = Date.now()
    const entry = existing || {
      key,
      dimension: currentDimension(),
      position: positionInfo(block.position),
      type: block.name,
      items: [],
      itemNames: [],
      capacity: null,
      freeSlots: null,
      empty: null,
      accessible: null,
      blocked: false,
      lastSeenAt: now,
      lastCheckedAt: 0,
      lastFailure: null,
      failures: 0,
      role: classifyContainerItems([], catalog)
    }

    entry.type = block.name
    entry.position = positionInfo(block.position)
    entry.lastSeenAt = now
    memory.set(key, entry)
    trimMemory()
    return entry
  }

  function trimMemory () {
    if (memory.size <= MAX_CONTAINER_MEMORY) return
    const entries = [...memory.values()].sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0))
    for (const entry of entries.slice(0, memory.size - MAX_CONTAINER_MEMORY)) {
      memory.delete(entry.key)
    }
  }

  function containerItems (window) {
    if (typeof window.containerItems === 'function') return window.containerItems()
    return typeof window.items === 'function' ? window.items() : []
  }

  function containerCapacity (window, blockName) {
    if (Number.isInteger(window.inventoryStart) && window.inventoryStart > 0) return window.inventoryStart
    if (blockName === 'chest' || blockName === 'trapped_chest') return 27
    return 27
  }

  function updateEntryFromWindow (entry, window, block) {
    const items = containerItems(window)
    const counts = itemStacksToCounts(items)
    const capacity = containerCapacity(window, block.name)
    entry.type = block.name
    entry.items = counts
    entry.itemNames = counts.map(item => item.name)
    entry.capacity = capacity
    entry.freeSlots = Math.max(0, capacity - items.length)
    entry.empty = counts.length === 0
    entry.role = classifyContainerItems(counts, catalog)
    entry.accessible = true
    entry.blocked = false
    entry.lastFailure = null
    entry.lastCheckedAt = Date.now()
    entry.lastSeenAt = Date.now()
    memory.set(entry.key, entry)
    return entry
  }

  function markFailure (entry, reason) {
    entry.accessible = false
    entry.blocked = true
    entry.lastFailure = reason
    entry.failures = (entry.failures || 0) + 1
    entry.lastCheckedAt = Date.now()
    memory.set(entry.key, entry)
  }

  function scanContainerBlocks (options = {}) {
    const current = bot()
    const radius = options.radius || CONTAINER_SCAN_RADIUS
    const vertical = options.vertical || CONTAINER_SCAN_VERTICAL
    const max = options.max || MAX_CONTAINERS_PER_ACTION
    const center = current.entity.position.floored()
    const blocks = []
    const seen = new Set()

    for (let x = -radius; x <= radius; x++) {
      for (let y = -vertical; y <= vertical; y++) {
        for (let z = -radius; z <= radius; z++) {
          if (Math.hypot(x, z) > radius) continue
          const block = current.blockAt(center.offset(x, y, z))
          if (!block || !isContainerBlockName(block.name)) continue
          const key = positionKey(block.position)
          if (seen.has(key)) continue
          seen.add(key)
          blocks.push(block)
        }
      }
    }

    return blocks
      .sort((a, b) => current.entity.position.distanceTo(a.position) - current.entity.position.distanceTo(b.position))
      .slice(0, max)
  }

  function scanContainers (options = {}) {
    const blocks = scanContainerBlocks(options)
    const entries = blocks.map(rememberBlock)
    return entries
  }

  function entryDistance (entry) {
    return bot().entity.position.distanceTo(vecFromPosition(entry.position))
  }

  function entryIsFresh (entry) {
    return entry.lastCheckedAt > 0 && Date.now() - entry.lastCheckedAt <= MEMORY_TTL_MS
  }

  function entryRecentlyFailed (entry) {
    return entry.lastFailure && Date.now() - entry.lastCheckedAt <= RECENT_FAILURE_COOLDOWN_MS
  }

  function entryHasTarget (entry, target) {
    if (!entry?.items?.length) return false
    return entry.items.some(item => inventory.itemTargetMatchesName(target, item.name))
  }

  function entryRoleMatchesItem (entry, itemName) {
    if (!entry?.role || !itemName) return 0
    const itemRole = classifyItemStorageRole(itemName, catalog)
    const role = entry.role
    let score = 0
    if (role.primaryRole === itemRole.primaryRole) score += 45
    if (role.secondaryRole !== 'unknown' && role.secondaryRole !== 'mixed' && role.secondaryRole === itemRole.secondaryRole) score += 55
    if (role.specificRole !== 'unknown' && role.specificRole !== 'mixed' && role.specificRole === itemRole.specificRole) score += 80
    if (role.primaryRole === 'mixed') score += 8
    return score * Math.max(0.35, role.confidence || 0.35)
  }

  function targetCandidateNames (target) {
    if (!target) return []
    return [
      ...target.itemNames || [],
      ...target.resolution?.candidates?.filter(candidate => candidate.kind === 'item').map(candidate => candidate.name) || []
    ]
  }

  function entryRoleMatchesTarget (entry, target) {
    return targetCandidateNames(target)
      .reduce((best, name) => Math.max(best, entryRoleMatchesItem(entry, name)), 0)
  }

  function countTargetInEntry (entry, target) {
    if (!entry?.items?.length) return 0
    return entry.items
      .filter(item => inventory.itemTargetMatchesName(target, item.name))
      .reduce((sum, item) => sum + item.count, 0)
  }

  function knownEntriesNearby (radius = CONTAINER_SCAN_RADIUS) {
    const dimension = currentDimension()
    return [...memory.values()]
      .filter(entry => entry.dimension === dimension)
      .filter(entry => entryDistance(entry) <= radius)
      .sort((a, b) => entryDistance(a) - entryDistance(b))
  }

  function buildCandidateEntries ({ target = null, purpose = 'inspect', force = false } = {}) {
    const scanned = scanContainers()
    const entries = new Map()
    for (const entry of knownEntriesNearby()) entries.set(entry.key, entry)
    for (const entry of scanned) entries.set(entry.key, entry)

    return [...entries.values()]
      .filter(entry => !entryRecentlyFailed(entry) || force)
      .map((entry) => {
        let score = 80 - entryDistance(entry) * 3
        if (purpose === 'search' && target) {
          if (entryHasTarget(entry, target)) score += 140
          else {
            score += entryRoleMatchesTarget(entry, target)
            if (entryIsFresh(entry)) score -= 45
          }
        }
        if (purpose === 'deposit') {
          if (entry.freeSlots > 0) score += 45
          if (entry.empty) score += 20
          if (entry.items?.length) score += 10
        }
        if (entry.accessible === false) score -= 60
        if (!entry.lastCheckedAt) score += 15
        return { entry, score }
      })
      .sort((a, b) => b.score - a.score || entryDistance(a.entry) - entryDistance(b.entry))
      .slice(0, MAX_CONTAINERS_PER_ACTION)
      .map(candidate => candidate.entry)
  }

  function immediateRisk () {
    const current = bot()
    if (getReconnecting()) return 'o bot esta reconectando'
    if (!current.entity) return 'bot sem entidade no mundo'
    if (current.health <= 8) return `vida baixa (${current.health}/20)`

    const assessment = survival?.assess?.()
    if (Number(assessment?.severity || 0) >= 85) {
      return `risco de sobrevivencia alto: ${assessment?.top?.reason || assessment?.summary || assessment.severity}`
    }

    const danger = perception?.getWorldTokens?.({ maxAgeMs: 2500 }).find((token) => {
      if (token.category === 'hostile_mob') return token.heads?.danger >= 75 && token.distance <= 10
      if (token.category === 'liquid_pool' && token.name === 'lava') return token.exposedFaces > 0 && token.distance <= 5
      return token.category === 'fall_risk' && token.distance <= 2
    })

    return danger ? `${danger.name}/${danger.category} perto demais` : null
  }

  async function moveNearEntry (entry) {
    const current = bot()
    const position = vecFromPosition(entry.position)
    const distance = current.entity.position.distanceTo(position)
    if (distance <= OPEN_DISTANCE) return

    getNavigationController()?.applyMovements?.()
    await withTimeout(
      current.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 3)),
      MOVE_TIMEOUT_MS,
      `aproximacao do container ${entry.type}`
    )
  }

  async function withOpenContainer (entry, skill, actionLabel, callback) {
    const current = bot()
    const risk = immediateRisk()
    if (risk) throw new Error(`nao vou interagir com container agora: ${risk}`)

    assertSkillActive(skill)
    await moveNearEntry(entry)
    assertSkillActive(skill)

    const block = current.blockAt(vecFromPosition(entry.position))
    if (!block || !isContainerBlockName(block.name)) {
      markFailure(entry, 'container nao encontrado na posicao memorizada')
      throw new Error('container nao encontrado na posicao memorizada')
    }

    let window
    try {
      await current.lookAt(block.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
      window = await withTimeout(current.openContainer(block), OPEN_TIMEOUT_MS, `abrir ${block.name}`)
      updateEntryFromWindow(entry, window, block)
    } catch (err) {
      const message = err?.message || String(err)
      markFailure(entry, message)
      throw new Error(`${actionLabel}: ${message}`, { cause: err })
    }

    try {
      const result = await callback(window, block, entry)
      updateEntryFromWindow(entry, window, block)
      return result
    } catch (err) {
      const message = err?.message || String(err)
      throw new Error(`${actionLabel}: ${message}`, { cause: err })
    } finally {
      try {
        if (window?.close) window.close()
      } catch {}
    }
  }

  function formatEntryRole (entry) {
    const role = entry.role || classifyContainerItems(entry.items || [], catalog)
    return `${role.primaryRole}/${role.secondaryRole}/${role.specificRole} ${Math.round((role.confidence || 0) * 100)}%`
  }

  function inspectSummary (entry) {
    if (!entry.lastCheckedAt) return `${entry.type} (${entry.position.x},${entry.position.y},${entry.position.z}) nao verificado`
    if (entry.lastFailure) return `${entry.type} (${entry.position.x},${entry.position.y},${entry.position.z}) falhou: ${entry.lastFailure}`
    const items = entry.items.length > 0 ? formatCounts(entry.items.slice(0, 8)) : 'vazio'
    const age = Math.round((Date.now() - entry.lastCheckedAt) / 1000)
    return `${entry.type} (${entry.position.x},${entry.position.y},${entry.position.z}) [${formatEntryRole(entry)}] ${items} ha ${age}s`
  }

  async function inspectEntry (entry, skill) {
    return withOpenContainer(entry, skill, 'inspecionar container', async () => entry)
  }

  async function scanAndInspectContainers () {
    const startedAt = Date.now()
    if (getActiveSkill()) return actionFail('containers.scan', `ja estou executando ${getActiveSkill().name}`, {}, startedAt)
    const skill = startSkill('containers_scan')
    if (!skill) return actionFail('containers.scan', 'nao consegui iniciar skill', {}, startedAt)

    getNavigationController()?.stop?.('skill containers scan')
    const found = scanContainers()
    const inspected = []
    const failures = []

    try {
      for (const entry of found.slice(0, MAX_CONTAINERS_PER_ACTION)) {
        assertSkillActive(skill)
        try {
          await inspectEntry(entry, skill)
          inspected.push(entry)
        } catch (err) {
          failures.push(`${entry.type}: ${err.message}`)
        }
      }

      const message = inspected.length === 0
        ? `Containers: encontrei ${found.length}, mas nao inspecionei nenhum.`
        : `Containers: inspecionei ${inspected.length}/${found.length}. ${inspected.map(entry => `${entry.type}@${entry.position.x},${entry.position.y},${entry.position.z}`).join(' | ')}`
      return actionOk('containers.scan', message, { found: found.length, inspected: inspected.length, failures }, startedAt)
    } catch (err) {
      return actionFail('containers.scan', err.message, { found: found.length, inspected: inspected.length, failures }, startedAt)
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  async function searchItemByQuery (query, options = {}) {
    const startedAt = Date.now()
    const target = inventory.normalizeItemTarget(query, 'inventory')
    const visited = new Set()
    if (getActiveSkill()) return actionFail('containers.search', `ja estou executando ${getActiveSkill().name}`, {}, startedAt)
    const skill = startSkill('containers_procurar')
    if (!skill) return actionFail('containers.search', 'nao consegui iniciar skill', {}, startedAt)

    getNavigationController()?.stop?.('skill containers search')
    try {
      const cachedHit = buildCandidateEntries({ target, purpose: 'search', force: options.force })
        .find(entry => entryIsFresh(entry) && entryHasTarget(entry, target))

      if (cachedHit && !options.force) {
        const count = countTargetInEntry(cachedHit, target)
        return actionOk(
          'containers.search',
          `Memoria: encontrei ${count} item(ns) compativeis com ${query} em ${cachedHit.type} (${cachedHit.position.x} ${cachedHit.position.y} ${cachedHit.position.z}).`,
          { entry: cachedHit, count },
          startedAt
        )
      }

      const candidates = buildCandidateEntries({ target, purpose: 'search', force: options.force })
      const failures = []
      for (const entry of candidates) {
        if (visited.has(entry.key)) continue
        visited.add(entry.key)
        if (!options.force && entryIsFresh(entry) && !entryHasTarget(entry, target)) continue

        try {
          await inspectEntry(entry, skill)
        } catch (err) {
          failures.push(`${entry.type}: ${err.message}`)
          continue
        }

        if (entryHasTarget(entry, target)) {
          const count = countTargetInEntry(entry, target)
          return actionOk(
            'containers.search',
            `Encontrei ${count} item(ns) compativeis com ${query} em ${entry.type} (${entry.position.x} ${entry.position.y} ${entry.position.z}).`,
            { entry, count, visited: visited.size, failures },
            startedAt
          )
        }
      }

      return actionFail('containers.search', `nao encontrei ${query} em ${visited.size} container(s) verificado(s)`, {
        query,
        visited: visited.size,
        failures
      }, startedAt, {
        code: visited.size === 0 ? 'no_containers_checked' : 'item_not_found',
        retryable: true,
        missingRequirements: [requestedItemRequirement(query, target, 1)],
        suggestedNextActions: [
          suggestSkillAction('containers.scan', {}, 'atualizar memoria de containers proximos'),
          suggestSkillAction('collection.collect', { target: query, count: 1 }, 'coletar o recurso no mundo, se for coletavel')
        ]
      })
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  function firstMatchingContainerItems (window, target) {
    return containerItems(window)
      .filter(item => inventory.itemTargetMatchesName(target, item.name))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  async function withdrawItemByQuery (query, count = 1, options = {}) {
    const startedAt = Date.now()
    const target = inventory.normalizeItemTarget(query, 'inventory')
    const requested = Math.max(1, count || 1)
    const visited = new Set()
    let remaining = requested
    const gains = []
    if (getActiveSkill()) return actionFail('containers.withdraw', `ja estou executando ${getActiveSkill().name}`, {}, startedAt)
    const skill = startSkill('containers_pegar')
    if (!skill) return actionFail('containers.withdraw', 'nao consegui iniciar skill', {}, startedAt)

    getNavigationController()?.stop?.('skill containers withdraw')
    try {
      const candidates = buildCandidateEntries({ target, purpose: 'search', force: options.force })
      const failures = []
      for (const entry of candidates) {
        if (remaining <= 0) break
        if (visited.has(entry.key)) continue
        visited.add(entry.key)
        if (!options.force && entryIsFresh(entry) && !entryHasTarget(entry, target)) continue

        try {
          await withOpenContainer(entry, skill, 'retirar item do container', async (window) => {
            for (const item of firstMatchingContainerItems(window, target)) {
              if (remaining <= 0) break
              if (!inventory.inventoryCanReceiveAny([item.name])) throw new Error(`inventario sem espaco para ${item.name}`)
              const amount = Math.min(remaining, item.count)
              await withTimeout(window.withdraw(item.type, null, amount), ACTION_TIMEOUT_MS, `retirar ${amount}x ${item.name}`)
              gains.push({ name: item.name, count: amount, from: entry.position })
              remaining -= amount
            }
          })
        } catch (err) {
          failures.push(`${entry.type}: ${err.message}`)
        }
      }

      const taken = requested - remaining
      if (taken <= 0) {
        return actionFail('containers.withdraw', `nao encontrei ${query} para retirar em ${visited.size} container(s)`, {
          query,
          requested,
          visited: visited.size,
          failures
        }, startedAt, {
          code: visited.size === 0 ? 'no_containers_checked' : 'item_not_found',
          retryable: true,
          missingRequirements: [requestedItemRequirement(query, target, requested)],
          suggestedNextActions: [
            suggestSkillAction('containers.scan', {}, 'atualizar memoria de containers proximos'),
            suggestSkillAction('collection.collect', { target: query, count: requested }, 'coletar o recurso no mundo, se for coletavel')
          ]
        })
      }

      const gainedText = formatCounts(itemStacksToCounts(gains))
      const suffix = remaining > 0 ? `; faltou ${remaining}` : ''
      return actionOk('containers.withdraw', `Peguei ${gainedText} de container(s)${suffix}.`, {
        query,
        requested,
        gains,
        remaining,
        visited: visited.size,
        failures
      }, startedAt, {
        code: remaining > 0 ? 'partial_success' : 'withdrawn',
        severity: remaining > 0 ? 'warning' : 'info',
        retryable: remaining > 0,
        inventoryDelta: gains.map(item => ({ name: item.name, delta: item.count, source: 'container' })),
        missingRequirements: remaining > 0 ? [requestedItemRequirement(query, target, remaining)] : [],
        suggestedNextActions: remaining > 0
          ? [
              suggestSkillAction('containers.scan', {}, 'buscar mais containers antes de tentar retirar o restante'),
              suggestSkillAction('collection.collect', { target: query, count: remaining }, 'coletar o restante no mundo, se for coletavel')
            ]
          : []
      })
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  function isArmor (name) {
    return name.endsWith('_helmet') || name.endsWith('_chestplate') || name.endsWith('_leggings') || name.endsWith('_boots') || name === 'elytra'
  }

  function isWeaponOrTool (name) {
    return name.endsWith('_sword') || name.endsWith('_axe') || name.endsWith('_pickaxe') ||
      name.endsWith('_shovel') || name.endsWith('_hoe') || name === 'shield' ||
      name === 'bow' || name === 'crossbow' || name === 'trident' || name === 'mace'
  }

  function isFood (name) {
    return catalog.foodNames.has(name)
  }

  function isBlockItem (name) {
    return Boolean(catalog.data.blocksByName[name])
  }

  function isResourceItem (name) {
    return RESOURCE_NAMES.has(name) ||
      MOB_DROP_NAMES.has(name) ||
      catalog.catalogItemHasCategory(name, 'wood') ||
      name.endsWith('_log') ||
      name.endsWith('_planks') ||
      name.endsWith('_ore')
  }

  function protectedKeepCount (name) {
    if (isWeaponOrTool(name) || isArmor(name) || name.endsWith('_bed')) return Infinity
    if (isFood(name)) return 8
    if (name === 'torch') return 16
    if (name === 'arrow' || name === 'spectral_arrow' || name === 'tipped_arrow') return 16
    return 0
  }

  function depositModeAllowsItem (mode, itemName, target) {
    if (mode === 'all') return true
    if (mode === 'blocks') return isBlockItem(itemName)
    if (mode === 'resources') return isResourceItem(itemName)
    if (mode === 'drops') return MOB_DROP_NAMES.has(itemName) || isResourceItem(itemName)
    if (mode === 'target') return target && inventory.itemTargetMatchesName(target, itemName)
    return false
  }

  function createDepositPlan ({ mode, target: query, count = null }) {
    const target = query ? inventory.normalizeItemTarget(query, 'inventory') : null
    const groups = new Map()
    for (const item of bot().inventory.items()) {
      const existing = groups.get(item.name) || { name: item.name, type: item.type, metadata: item.metadata ?? null, count: 0 }
      existing.count += item.count
      groups.set(item.name, existing)
    }

    const plan = []
    let remainingRequested = count || Infinity
    for (const item of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!depositModeAllowsItem(mode, item.name, target)) continue
      const keep = protectedKeepCount(item.name)
      const available = Math.max(0, item.count - keep)
      const amount = Math.min(available, remainingRequested)
      if (amount <= 0) continue
      plan.push({ ...item, remaining: amount })
      remainingRequested -= amount
      if (remainingRequested <= 0) break
    }

    return { plan, target, protected: [...groups.values()].filter(item => depositModeAllowsItem(mode, item.name, target) && item.count - protectedKeepCount(item.name) <= 0) }
  }

  function containerCanProbablyAccept (window, itemName) {
    const items = containerItems(window)
    const maxStack = inventory.itemMaxStackSize(itemName)
    if (items.some(item => item.name === itemName && item.count < (item.stackSize || maxStack))) return true
    return items.length < containerCapacity(window, 'container')
  }

  async function tryDeposit (window, item, maxAmount) {
    let amount = maxAmount
    while (amount > 0) {
      try {
        await withTimeout(window.deposit(item.type, item.metadata ?? null, amount), ACTION_TIMEOUT_MS, `guardar ${amount}x ${item.name}`)
        return amount
      } catch {
        amount = Math.floor(amount / 2)
      }
    }
    return 0
  }

  function depositCandidates (plan) {
    const planNames = new Set(plan.map(item => item.name))
    return buildCandidateEntries({ purpose: 'deposit' })
      .map((entry) => {
        let score = 80 - entryDistance(entry) * 3
        if (entry.items?.some(item => planNames.has(item.name))) score += 120
        for (const item of plan) score += entryRoleMatchesItem(entry, item.name)
        if (entry.freeSlots > 0) score += 40
        if (!entry.lastCheckedAt) score += 20
        return { entry, score }
      })
      .sort((a, b) => b.score - a.score || entryDistance(a.entry) - entryDistance(b.entry))
      .map(candidate => candidate.entry)
  }

  async function depositByRequest (request) {
    const startedAt = Date.now()
    const { plan, protected: protectedItems } = createDepositPlan(request)
    const deposited = []
    const visited = new Set()

    if (getActiveSkill()) return actionFail('containers.deposit', `ja estou executando ${getActiveSkill().name}`, {}, startedAt)
    if (plan.length === 0) {
      const protectedText = protectedItems.length > 0 ? ` Itens protegidos: ${protectedItems.map(item => item.name).join(', ')}.` : ''
      return actionFail('containers.deposit', `nao ha itens permitidos para guardar.${protectedText}`, {
        request,
        protectedItems
      }, startedAt, {
        code: protectedItems.length > 0 ? 'only_protected_items' : 'nothing_to_deposit',
        retryable: false
      })
    }

    const skill = startSkill('containers_guardar')
    if (!skill) return actionFail('containers.deposit', 'nao consegui iniciar skill', {}, startedAt)

    getNavigationController()?.stop?.('skill containers deposit')
    try {
      const candidates = depositCandidates(plan)
      const failures = []
      for (const entry of candidates) {
        if (plan.every(item => item.remaining <= 0)) break
        if (visited.has(entry.key)) continue
        visited.add(entry.key)

        try {
          await withOpenContainer(entry, skill, 'guardar itens no container', async (window) => {
            for (const item of plan) {
              if (item.remaining <= 0) continue
              if (!containerCanProbablyAccept(window, item.name)) continue
              const amount = await tryDeposit(window, item, item.remaining)
              if (amount <= 0) continue
              item.remaining -= amount
              deposited.push({ name: item.name, count: amount, to: entry.position })
            }
          })
        } catch (err) {
          failures.push(`${entry.type}: ${err.message}`)
        }
      }

      if (deposited.length === 0) {
        return actionFail('containers.deposit', `nao consegui guardar em ${visited.size} container(s)`, {
          request,
          planned: plan.map(item => ({ name: item.name, count: item.remaining })),
          visited: visited.size,
          failures
        }, startedAt, {
          code: visited.size === 0 ? 'no_containers_checked' : 'deposit_failed',
          retryable: true,
          missingRequirements: remainingDepositRequirements(plan),
          suggestedNextActions: [
            suggestSkillAction('containers.scan', {}, 'atualizar memoria de containers proximos')
          ]
        })
      }

      const remaining = plan.filter(item => item.remaining > 0)
      const suffix = remaining.length > 0 ? `; sobrou ${remaining.map(item => `${item.remaining}x ${item.name}`).join(', ')}` : ''
      return actionOk('containers.deposit', `Guardei ${formatCounts(itemStacksToCounts(deposited))}${suffix}.`, {
        request,
        deposited,
        remaining,
        visited: visited.size,
        failures
      }, startedAt, {
        code: remaining.length > 0 ? 'partial_success' : 'deposited',
        severity: remaining.length > 0 ? 'warning' : 'info',
        retryable: remaining.length > 0,
        inventoryDelta: deposited.map(item => ({ name: item.name, delta: -item.count, target: 'container' })),
        missingRequirements: remainingDepositRequirements(remaining),
        suggestedNextActions: remaining.length > 0
          ? [suggestSkillAction('containers.scan', {}, 'buscar container com espaco para guardar o restante')]
          : []
      })
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  function describeKnownContainers () {
    const entries = knownEntriesNearby(128)
    if (entries.length === 0) return 'Containers conhecidos: nenhum.'
    return `Containers conhecidos: ${entries.slice(0, 10).map(inspectSummary).join(' | ')}`
  }

  function clearMemory () {
    const count = memory.size
    memory.clear()
    return count
  }

  function describeScanOnly () {
    const entries = scanContainers()
    if (entries.length === 0) return 'Containers scan: nenhum container perto.'
    return `Containers scan: ${entries.map(entry => `${entry.type} (${entry.position.x},${entry.position.y},${entry.position.z})`).join(' | ')}`
  }

  function getStateSnapshot () {
    const entries = knownEntriesNearby(128).slice(0, 12)
    return {
      known: memory.size,
      nearby: entries.length,
      ttlMs: MEMORY_TTL_MS,
      entries: entries.map(entry => ({
        type: entry.type,
        position: entry.position,
        items: entry.items.slice(0, 12),
        role: entry.role,
        fresh: entryIsFresh(entry),
        accessible: entry.accessible,
        lastFailure: entry.lastFailure
      }))
    }
  }

  return {
    memory,
    isContainerBlockName,
    getMemoryEntryAt,
    scanContainers,
    scanAndInspectContainers,
    searchItemByQuery,
    withdrawItemByQuery,
    depositByRequest,
    describeKnownContainers,
    describeScanOnly,
    clearMemory,
    getStateSnapshot
  }
}

module.exports = {
  isContainerBlockName,
  isContainerCommandText,
  parseContainerSearchCommand,
  parseContainerWithdrawCommand,
  parseContainerDepositCommand,
  classifyItemStorageRole,
  classifyContainerItems,
  createContainerHelpers
}
