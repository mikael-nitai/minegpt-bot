function normalizeAliasText (value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const CONTAINER_MODE_ALIASES = new Map([
  ['blocks', 'blocks'],
  ['block', 'blocks'],
  ['building_blocks', 'blocks'],
  ['building_block', 'blocks'],
  ['blocos', 'blocks'],
  ['bloco', 'blocks'],
  ['materiais_de_construcao', 'blocks'],
  ['recursos', 'resources'],
  ['recurso', 'resources'],
  ['resources', 'resources'],
  ['resource', 'resources'],
  ['minerios', 'resources'],
  ['minerio', 'resources'],
  ['drops', 'drops'],
  ['drop', 'drops'],
  ['itens_dropados', 'drops'],
  ['tudo', 'all'],
  ['todo', 'all'],
  ['todos', 'all'],
  ['all', 'all'],
  ['everything', 'all']
])

const ITEM_TARGET_ALIASES = new Map([
  ['mesa', 'crafting_table'],
  ['bancada', 'crafting_table'],
  ['mesa_de_trabalho', 'crafting_table'],
  ['crafting_table', 'crafting_table'],
  ['tocha', 'torch'],
  ['tochas', 'torch'],
  ['torch', 'torch'],
  ['torches', 'torch'],
  ['graveto', 'stick'],
  ['gravetos', 'stick'],
  ['palito', 'stick'],
  ['palitos', 'stick'],
  ['stick', 'stick'],
  ['sticks', 'stick'],
  ['carvao', 'coal'],
  ['coal', 'coal'],
  ['charcoal', 'charcoal'],
  ['pao', 'bread'],
  ['bread', 'bread']
])

const COLLECT_TARGET_ALIASES = new Map([
  ['madeira', 'oak_log'],
  ['madeiras', 'oak_log'],
  ['tronco', 'oak_log'],
  ['troncos', 'oak_log'],
  ['arvore', 'oak_log'],
  ['arvores', 'oak_log'],
  ['carvalho', 'oak_log'],
  ['madeira_de_carvalho', 'oak_log'],
  ['tronco_de_carvalho', 'oak_log'],
  ['tronco_de_arvore_de_carvalho', 'oak_log'],
  ['oak', 'oak_log'],
  ['oak_log', 'oak_log'],
  ['oak_wood', 'oak_log'],
  ['pedra', 'stone'],
  ['pedras', 'stone'],
  ['stone', 'stone'],
  ['cobblestone', 'cobblestone'],
  ['pedregulho', 'cobblestone'],
  ['carvao', 'coal_ore'],
  ['minerio_de_carvao', 'coal_ore'],
  ['coal', 'coal_ore'],
  ['coal_ore', 'coal_ore'],
  ['ferro', 'iron_ore'],
  ['minerio_de_ferro', 'iron_ore'],
  ['iron', 'iron_ore'],
  ['iron_ore', 'iron_ore']
])

const DIRECTION_ALIASES = new Map([
  ['frente', 'forward'],
  ['para_frente', 'forward'],
  ['forward', 'forward'],
  ['tras', 'back'],
  ['para_tras', 'back'],
  ['back', 'back'],
  ['esquerda', 'left'],
  ['left', 'left'],
  ['direita', 'right'],
  ['right', 'right'],
  ['norte', 'north'],
  ['north', 'north'],
  ['sul', 'south'],
  ['south', 'south'],
  ['leste', 'east'],
  ['east', 'east'],
  ['oeste', 'west'],
  ['west', 'west']
])

function resolveContainerModeAlias (value) {
  return CONTAINER_MODE_ALIASES.get(normalizeAliasText(value)) || null
}

function resolveItemAlias (value, { catalog = null, context = 'item' } = {}) {
  const normalized = normalizeAliasText(value)
  if (!normalized) return null

  const direct = ITEM_TARGET_ALIASES.get(normalized)
  if (direct) return direct

  if (catalog?.resolveCatalogQuery) {
    const resolution = catalog.resolveCatalogQuery(value, context)
    const item = resolution.candidates?.find(candidate => candidate.kind === 'item')
    if (item?.name) return item.name
  }

  return normalized
}

function firstAllowedTarget (candidates, allowedTargets = []) {
  if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) return candidates[0] || null
  return candidates.find(candidate => allowedTargets.includes(candidate)) || null
}

function collectCandidatesFromCatalog (value, catalog) {
  if (!catalog?.resolveCatalogQuery) return []
  const resolution = catalog.resolveCatalogQuery(value, 'collect')
  const candidates = []

  for (const candidate of resolution.candidates || []) {
    if (candidate.kind === 'block') candidates.push(candidate.name)
    if (candidate.kind === 'block_category' && candidate.name === 'wood') candidates.push('oak_log')
    if (candidate.kind === 'block_category' && candidate.name === 'stone') candidates.push('stone', 'cobblestone')
    if (candidate.kind === 'block_category' && candidate.name === 'ore') candidates.push('coal_ore', 'iron_ore')
  }

  return [...new Set(candidates)]
}

function resolveCollectTargetAlias (value, { catalog = null, plannerState = {} } = {}) {
  const normalized = normalizeAliasText(value)
  if (!normalized) return null

  const allowedTargets = Array.isArray(plannerState?.allowedActions?.collectTargets)
    ? plannerState.allowedActions.collectTargets
    : []
  const direct = COLLECT_TARGET_ALIASES.get(normalized)
  const candidates = [
    direct,
    normalized,
    ...collectCandidatesFromCatalog(value, catalog)
  ].filter(Boolean)

  if (normalized === 'madeira' || normalized === 'tronco' || normalized === 'carvalho' || normalized.includes('carvalho')) {
    candidates.push('oak_log')
  }
  if (normalized === 'pedra' || normalized === 'pedras') {
    candidates.push('stone', 'cobblestone')
  }
  if (normalized === 'carvao' || normalized.includes('carvao')) {
    candidates.push('coal_ore', 'deepslate_coal_ore', 'coal')
  }

  const uniqueCandidates = [...new Set(candidates)]
  const allowed = firstAllowedTarget(uniqueCandidates, allowedTargets)
  if (allowed) return allowed
  if (allowedTargets.length > 0) return null
  return uniqueCandidates[0] || null
}

function resolveDirectionAlias (value) {
  return DIRECTION_ALIASES.get(normalizeAliasText(value)) || null
}

module.exports = {
  normalizeAliasText,
  resolveContainerModeAlias,
  resolveCollectTargetAlias,
  resolveDirectionAlias,
  resolveItemAlias,
  CONTAINER_MODE_ALIASES,
  COLLECT_TARGET_ALIASES,
  ITEM_TARGET_ALIASES,
  DIRECTION_ALIASES
}
