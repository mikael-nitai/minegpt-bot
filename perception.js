function createPerceptionHelpers ({
  getBot,
  Vec3,
  catalog,
  getDroppedItemFromEntity,
  isDroppedItemEntity,
  describeDroppedItemEntity,
  ownerMatches,
  getEscapeDirections,
  getContainerMemory = null
}) {
  const {
    resolveCatalogQuery,
    catalogBlockHasCategory,
    categoryNamesForItem
  } = catalog

  const PERCEPTION_RADIUS = 16
  const PERCEPTION_VERTICAL = 4
  const PERCEPTION_CACHE_INTERVAL_MS = 2000
  const PERCEPTION_CACHE_MAX_AGE_MS = 5000

  const perceptionState = {
    objective: 'neutro',
    cache: {
      tokens: [],
      updatedAt: 0,
      lastScanMs: 0,
      radius: PERCEPTION_RADIUS,
      vertical: PERCEPTION_VERTICAL,
      refreshing: false
    }
  }

  const objectiveWeights = {
    neutro: { danger: 1.2, resource: 0.8, navigation: 0.8, goal: 1.0, opportunity: 0.8 },
    sobreviver: { danger: 1.8, resource: 0.4, navigation: 1.1, goal: 1.2, opportunity: 0.4 },
    seguir: { danger: 1.4, resource: 0.2, navigation: 1.4, goal: 1.0, opportunity: 0.2 },
    coletar_madeira: { danger: 1.2, resource: 1.0, navigation: 0.8, goal: 1.8, opportunity: 0.6 },
    explorar: { danger: 1.3, resource: 1.0, navigation: 1.0, goal: 1.0, opportunity: 1.4 },
    craftar: { danger: 1.1, resource: 0.9, navigation: 0.5, goal: 1.6, opportunity: 0.8 },
    organizar: { danger: 1.1, resource: 0.5, navigation: 0.8, goal: 1.7, opportunity: 1.5 },
    buscar_item: { danger: 1.2, resource: 0.8, navigation: 0.8, goal: 1.8, opportunity: 1.4 }
  }

  const hostileMobs = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned',
    'husk', 'stray', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator',
    'evoker', 'ravager', 'blaze', 'ghast', 'enderman', 'warden'
  ])
  const passiveMobs = new Set([
    'cow', 'sheep', 'pig', 'chicken', 'horse', 'donkey', 'mule', 'rabbit',
    'villager', 'wandering_trader', 'goat', 'llama'
  ])
  const foodMobs = new Set(['cow', 'sheep', 'pig', 'chicken', 'rabbit'])
  const oreBlocks = catalog.blockCategories.ore
  const stoneBlocks = catalog.blockCategories.stone
  const woodBlocks = catalog.blockCategories.wood
  const utilityBlocks = new Set([
    'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest',
    'barrel', 'bed', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
    'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
    'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
    ...(catalog.blockCategories.container || [])
  ])
  const liquidBlocks = new Set(['water', 'lava'])
  const hazardBlocks = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush'])
  const neighborOffsets = []

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0) neighborOffsets.push({ dx, dy, dz })
      }
    }
  }

  function bot () {
    const current = getBot()
    if (!current) throw new Error('bot ainda nao inicializado')
    return current
  }

  function clampScore (value) {
    return Math.max(0, Math.min(100, Math.round(value)))
  }

  function distancePenalty (distance) {
    return Math.min(35, distance * 2.2)
  }

  function positionOf (entityOrBlock) {
    const pos = entityOrBlock.position
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
  }

  function blockKey (position) {
    return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
  }

  function getDirectionLabel (from, to) {
    const dx = to.x - from.x
    const dz = to.z - from.z
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'leste' : 'oeste'
    if (Math.abs(dz) > 0) return dz > 0 ? 'sul' : 'norte'
    return 'aqui'
  }

  function blockIsPassable (pos) {
    const block = bot().blockAt(pos)
    if (!block) return false
    return block.boundingBox === 'empty' || block.climbable
  }

  function hasLineOfSightToEntity (entity) {
    const current = bot()
    const origin = current.entity.position.offset(0, 1.6, 0)
    const target = entity.position.offset(0, entity.height ? entity.height * 0.7 : 1, 0)
    const distance = origin.distanceTo(target)
    const steps = Math.max(1, Math.ceil(distance * 4))

    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const point = new Vec3(
        origin.x + (target.x - origin.x) * t,
        origin.y + (target.y - origin.y) * t,
        origin.z + (target.z - origin.z) * t
      )
      const block = current.blockAt(point)
      if (block && block.boundingBox === 'block') return false
    }

    return true
  }

  function oreFamily (name) {
    return name.replace(/^deepslate_/, '')
  }

  function treeNameFromLog (name) {
    return `arvore_${name.replace(/_log$/, '')}`
  }

  function semanticBlockFamily (block) {
    if (!block || !block.name) return null
    if (oreBlocks.has(block.name)) return `ore:${oreFamily(block.name)}`
    if (woodBlocks.has(block.name)) return 'wood:tree'
    if (stoneBlocks.has(block.name)) return `stone:${block.name}`
    if (liquidBlocks.has(block.name)) return `liquid:${block.name}`
    if (hazardBlocks.has(block.name)) return `hazard:${block.name}`
    if (
      catalog.blockNames.has(block.name) &&
      block.boundingBox === 'block' &&
      block.diggable &&
      !utilityBlocks.has(block.name)
    ) {
      return `common:${block.name}`
    }
    return null
  }

  function isGroupableBlock (block) {
    return semanticBlockFamily(block) !== null
  }

  function saturatedSizeBonus (size, maxBonus = 22) {
    return Math.min(maxBonus, Math.log2(size + 1) * 7)
  }

  function nearestBlockToBot (blocks) {
    const current = bot()
    return blocks.reduce((nearest, block) => {
      if (!nearest) return block
      return current.entity.position.distanceTo(block.position) < current.entity.position.distanceTo(nearest.position)
        ? block
        : nearest
    }, null)
  }

  function centerOfBlocks (blocks) {
    const total = blocks.reduce((acc, block) => ({
      x: acc.x + block.position.x,
      y: acc.y + block.position.y,
      z: acc.z + block.position.z
    }), { x: 0, y: 0, z: 0 })

    return {
      x: Math.round(total.x / blocks.length),
      y: Math.round(total.y / blocks.length),
      z: Math.round(total.z / blocks.length)
    }
  }

  function analyzeLiquidExposure (blocks, liquidName) {
    const current = bot()
    let exposedFaces = 0
    let nearestExposedDistance = Infinity
    let topExposureNearBot = false
    const sameLiquidKeys = new Set(blocks.map(block => blockKey(block.position)))

    for (const block of blocks) {
      const faces = [
        { dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: -1, dz: 0 },
        { dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 }
      ]

      for (const face of faces) {
        const adjacentPos = block.position.offset(face.dx, face.dy, face.dz)
        if (sameLiquidKeys.has(blockKey(adjacentPos))) continue

        const adjacent = current.blockAt(adjacentPos)
        if (!adjacent || adjacent.boundingBox !== 'block') {
          exposedFaces += 1
          const distance = current.entity.position.distanceTo(adjacentPos)
          nearestExposedDistance = Math.min(nearestExposedDistance, distance)

          const horizontalDistance = Math.hypot(adjacentPos.x - current.entity.position.x, adjacentPos.z - current.entity.position.z)
          if (face.dy === 1 && horizontalDistance <= 2.5 && adjacentPos.y <= current.entity.position.y + 0.5) {
            topExposureNearBot = true
          }
        }
      }
    }

    if (exposedFaces === 0) nearestExposedDistance = null
    return { liquidName, exposedFaces, nearestExposedDistance, topExposureNearBot }
  }

  function createToken (kind, name, category, position, distance, heads, reasons, extra = {}) {
    const current = bot()
    const weights = objectiveWeights[perceptionState.objective] || objectiveWeights.neutro
    const rawScore =
      heads.danger * weights.danger +
      heads.resource * weights.resource +
      heads.navigation * weights.navigation +
      heads.goal * weights.goal +
      heads.opportunity * weights.opportunity -
      distancePenalty(distance) -
      (extra.cost || 0)

    return {
      kind,
      name,
      category,
      position,
      distance,
      direction: getDirectionLabel(current.entity.position, position),
      heads,
      score: clampScore(rawScore),
      reasons,
      ...extra
    }
  }

  function scoreEntity (entity) {
    const current = bot()
    if (!entity.position || entity === current.entity) return null

    const droppedItem = getDroppedItemFromEntity(entity)
    let name = entity.name || entity.username || entity.displayName || entity.type || droppedItem?.name
    if (!name) return null

    const distance = current.entity.position.distanceTo(entity.position)
    if (distance > 16) return null

    const heads = { danger: 0, resource: 0, navigation: 0, goal: 0, opportunity: 0 }
    const reasons = []
    let category = 'entity'

    if (hostileMobs.has(name)) {
      category = 'hostile_mob'
      heads.danger = distance <= 4 ? 95 : distance <= 8 ? 75 : 45
      reasons.push('mob hostil')
    }

    if (name === 'skeleton' || name === 'stray' || name === 'pillager') {
      const los = hasLineOfSightToEntity(entity)
      heads.danger = los && distance <= 16 ? Math.max(heads.danger, 85) : heads.danger
      if (los) reasons.push('ameaca a distancia com linha de visao')
    }

    if (name === 'creeper') {
      heads.danger = distance <= 6 ? 100 : 70
      reasons.push('explosivo')
    }

    if (name === 'enderman') {
      heads.danger = distance <= 5 ? 35 : 10
      heads.opportunity = 25
      reasons.push('perigoso se provocado/encarado')
    }

    if (passiveMobs.has(name)) {
      category = foodMobs.has(name) ? 'food_source' : 'passive_mob'
      heads.resource = foodMobs.has(name) ? 35 : 10
      heads.opportunity = name === 'villager' ? 70 : 20
      reasons.push(foodMobs.has(name) ? 'fonte de comida' : 'entidade passiva')
    }

    if (isDroppedItemEntity(entity)) {
      category = 'dropped_item'
      name = droppedItem?.name || name
      const itemCategories = droppedItem ? categoryNamesForItem(droppedItem.name) : []
      heads.resource = itemCategories.includes('food') ? 55 : 35
      heads.opportunity = itemCategories.includes('tool') ? 60 : 35
      reasons.push(`item dropado: ${describeDroppedItemEntity(entity)}`)
      if (itemCategories.length > 0) reasons.push(`categoria: ${itemCategories.join('/')}`)
    }

    if (entity.username && entity.username !== current.username) {
      category = 'player'
      heads.opportunity = ownerMatches(entity.username) ? 45 : 20
      reasons.push('jogador')
    }

    if (category === 'entity' && heads.danger === 0 && heads.resource === 0 && heads.opportunity === 0) {
      return null
    }

    return createToken('entity', name, category, positionOf(entity), distance, heads, reasons)
  }

  function scoreBlockGroup (blocks) {
    const current = bot()
    if (blocks.length === 0) return null

    const nearest = nearestBlockToBot(blocks)
    const family = semanticBlockFamily(nearest)
    const distance = current.entity.position.distanceTo(nearest.position)
    const center = centerOfBlocks(blocks)
    const heads = { danger: 0, resource: 0, navigation: 0, goal: 0, opportunity: 0 }
    const reasons = []
    const sizeBonus = saturatedSizeBonus(blocks.length)
    let name = nearest.name
    let category
    const extra = {
      size: blocks.length,
      nearest: positionOf(nearest),
      blocks: blocks.map(positionOf),
      blockNames: [...new Set(blocks.map(block => block.name))].sort(),
      family
    }

    if (family.startsWith('ore:')) {
      name = family.slice('ore:'.length)
      category = 'ore_vein'
      const rare = name.includes('diamond') || name.includes('emerald')
      heads.resource = rare ? 95 : 70 + sizeBonus
      heads.opportunity = rare ? 85 + Math.min(sizeBonus, 10) : 55 + sizeBonus
      reasons.push(`veia de minerio com ${blocks.length} bloco(s)`)
    } else if (family === 'wood:tree') {
      name = treeNameFromLog(nearest.name)
      category = 'tree'
      heads.resource = 48 + Math.min(sizeBonus, 18)
      heads.goal = perceptionState.objective === 'coletar_madeira' ? 90 : 20
      heads.opportunity = 25
      reasons.push(`madeira agrupada com ${blocks.length} log(s)`)
    } else if (family.startsWith('stone:')) {
      name = family.slice('stone:'.length)
      category = 'stone_group'
      heads.resource = 25 + Math.min(sizeBonus, 12)
      heads.opportunity = 15
      reasons.push(`pedra agrupada com ${blocks.length} bloco(s)`)
    } else if (family.startsWith('common:')) {
      name = family.slice('common:'.length)
      category = 'common_block_group'
      heads.resource = 8 + Math.min(sizeBonus, 8)
      heads.opportunity = 4
      reasons.push(`bloco comum agrupado com ${blocks.length} bloco(s)`)
    } else if (family === 'liquid:lava') {
      category = 'liquid_pool'
      const exposure = analyzeLiquidExposure(blocks, 'lava')
      Object.assign(extra, exposure)

      if (exposure.exposedFaces === 0) {
        heads.danger = 10
        heads.navigation = 15
        heads.opportunity = 20
        reasons.push('lava bloqueada por blocos')
      } else if (exposure.topExposureNearBot) {
        heads.danger = 100
        heads.navigation = 90
        reasons.push('lava exposta com risco de queda perto')
      } else if (exposure.nearestExposedDistance <= 3) {
        heads.danger = 90
        heads.navigation = 80
        reasons.push('lava exposta perto')
      } else {
        heads.danger = 60
        heads.navigation = 60
        reasons.push('lava exposta distante')
      }
    } else if (family === 'liquid:water') {
      category = 'liquid_pool'
      const exposure = analyzeLiquidExposure(blocks, 'water')
      Object.assign(extra, exposure)
      heads.danger = exposure.exposedFaces > 0 ? 8 : 2
      heads.navigation = exposure.exposedFaces > 0 ? 35 : 10
      heads.opportunity = 20
      reasons.push(exposure.exposedFaces > 0 ? 'agua exposta' : 'agua bloqueada')
    } else if (family.startsWith('hazard:')) {
      category = 'hazard_group'
      heads.danger = nearest.name === 'magma_block' ? 65 : 75
      heads.navigation = 55
      reasons.push(`perigo agrupado com ${blocks.length} bloco(s)`)
    } else {
      return null
    }

    return createToken('block_group', name, category, center, distance, heads, reasons, extra)
  }

  function scoreBlock (block) {
    const current = bot()
    if (!block || !block.name) return null
    if (isGroupableBlock(block)) return null

    const distance = current.entity.position.distanceTo(block.position)
    const heads = { danger: 0, resource: 0, navigation: 0, goal: 0, opportunity: 0 }
    const reasons = []
    let category
    const extra = {}

    if (catalogBlockHasCategory(block.name, 'container')) {
      category = 'container'
      heads.resource = 35
      heads.opportunity = 85
      heads.goal = perceptionState.objective === 'organizar' || perceptionState.objective === 'buscar_item' ? 85 : 35
      reasons.push('container abrivel')

      const containerMemory = getContainerMemory?.()?.getMemoryEntryAt?.(block.position)
      if (containerMemory) {
        extra.containerKnown = true
        extra.containerItems = containerMemory.itemNames || []
        if (containerMemory.items?.length > 0) {
          heads.resource += 10
          heads.opportunity += 8
          reasons.push(`memoria com ${containerMemory.items.length} tipo(s) de item`)
        }
        if (containerMemory.lastFailure) {
          extra.cost = (extra.cost || 0) + 35
          reasons.push('falha recente na memoria')
        } else if (containerMemory.empty) {
          extra.cost = (extra.cost || 0) + 12
          reasons.push('memoria indica vazio')
        }
      }
    } else if (utilityBlocks.has(block.name)) {
      category = 'utility_block'
      heads.resource = 40
      heads.opportunity = block.name.includes('chest') || block.name === 'barrel' ? 80 : 55
      heads.goal = perceptionState.objective === 'craftar' ? 80 : 25
      reasons.push('bloco utilitario')
    } else {
      return null
    }

    return createToken('block', block.name, category, positionOf(block), distance, heads, reasons, extra)
  }

  function detectFallHazards () {
    const current = bot()
    const tokens = []
    const base = current.entity.position.floored()
    const candidates = [
      { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }
    ]

    for (const candidate of candidates) {
      const foot = base.offset(candidate.dx, 0, candidate.dz)
      let depth = 0
      for (let y = -1; y >= -5; y--) {
        const block = current.blockAt(base.offset(candidate.dx, y, candidate.dz))
        if (!block) break
        if (block.boundingBox === 'block') break
        depth += 1
      }

      if (depth >= 3 && blockIsPassable(foot)) {
        const pos = positionOf({ position: foot })
        tokens.push(createToken(
          'hazard',
          'queda',
          'fall_risk',
          pos,
          current.entity.position.distanceTo(foot),
          { danger: depth >= 5 ? 90 : 70, resource: 0, navigation: 70, goal: 0, opportunity: 0 },
          [`queda de ${depth} blocos`]
        ))
      }
    }

    return tokens
  }

  function createGroupedBlockTokens (blocks) {
    const tokens = []
    const blockByKey = new Map(blocks.map(block => [blockKey(block.position), block]))
    const visited = new Set()

    for (const block of blocks) {
      const startKey = blockKey(block.position)
      if (visited.has(startKey)) continue

      const family = semanticBlockFamily(block)
      const group = []
      const queue = [block]
      let queueIndex = 0
      visited.add(startKey)

      while (queueIndex < queue.length) {
        const current = queue[queueIndex++]
        group.push(current)

        for (const offset of neighborOffsets) {
          const nextPos = current.position.offset(offset.dx, offset.dy, offset.dz)
          const nextKey = blockKey(nextPos)
          if (visited.has(nextKey)) continue

          const next = blockByKey.get(nextKey)
          if (!next || semanticBlockFamily(next) !== family) continue

          visited.add(nextKey)
          queue.push(next)
        }
      }

      const token = scoreBlockGroup(group)
      if (token) tokens.push(token)
    }

    return tokens
  }

  function buildWorldTokens (options = {}) {
    const current = bot()
    const tokens = []
    const radius = options.radius ?? PERCEPTION_RADIUS
    const vertical = options.vertical ?? PERCEPTION_VERTICAL

    for (const entity of Object.values(current.entities)) {
      const token = scoreEntity(entity)
      if (token) tokens.push(token)
    }

    const center = current.entity.position.floored()
    const groupableBlocks = []
    for (let x = -radius; x <= radius; x++) {
      for (let y = -vertical; y <= vertical; y++) {
        for (let z = -radius; z <= radius; z++) {
          const block = current.blockAt(center.offset(x, y, z))
          if (isGroupableBlock(block)) {
            groupableBlocks.push(block)
            continue
          }

          const token = scoreBlock(block)
          if (token) tokens.push(token)
        }
      }
    }

    tokens.push(...createGroupedBlockTokens(groupableBlocks))
    tokens.push(...detectFallHazards())

    return tokens.sort((a, b) => b.score - a.score || a.distance - b.distance)
  }

  function refreshPerceptionCache (force = false) {
    const current = getBot()
    if (!current?.entity || perceptionState.cache.refreshing) return perceptionState.cache.tokens

    const now = Date.now()
    const age = now - perceptionState.cache.updatedAt
    if (!force && perceptionState.cache.updatedAt > 0 && age < PERCEPTION_CACHE_INTERVAL_MS) {
      return perceptionState.cache.tokens
    }

    perceptionState.cache.refreshing = true
    const startedAt = Date.now()

    try {
      const tokens = buildWorldTokens({
        radius: PERCEPTION_RADIUS,
        vertical: PERCEPTION_VERTICAL
      })

      perceptionState.cache.tokens = tokens
      perceptionState.cache.updatedAt = Date.now()
      perceptionState.cache.lastScanMs = perceptionState.cache.updatedAt - startedAt
      perceptionState.cache.radius = PERCEPTION_RADIUS
      perceptionState.cache.vertical = PERCEPTION_VERTICAL
      return tokens
    } finally {
      perceptionState.cache.refreshing = false
    }
  }

  function getWorldTokens (options = {}) {
    const maxAgeMs = options.maxAgeMs ?? PERCEPTION_CACHE_MAX_AGE_MS
    const age = Date.now() - perceptionState.cache.updatedAt

    if (options.fresh || perceptionState.cache.updatedAt === 0 || age > maxAgeMs) {
      return refreshPerceptionCache(true)
    }

    return perceptionState.cache.tokens
  }

  function describePerceptionCache () {
    const cache = perceptionState.cache
    const age = cache.updatedAt ? ((Date.now() - cache.updatedAt) / 1000).toFixed(1) : 'sem cache'
    return `Percepcao: raio=${cache.radius} vertical=${cache.vertical} tokens=${cache.tokens.length} idade=${age}s scan=${cache.lastScanMs}ms objetivo=${perceptionState.objective}`
  }

  function describeCatalogResolution (query) {
    const resolution = resolveCatalogQuery(query, 'any')
    const top = resolution.candidates.slice(0, 10).map(candidate =>
      `${candidate.kind}:${candidate.name} score=${candidate.score} via=${candidate.source}`
    )

    return top.length === 0
      ? `Catalogo: nao encontrei candidatos para "${query}".`
      : `Catalogo "${query}": ${top.join(' | ')}`
  }

  function formatToken (token) {
    const pos = token.position
    const size = token.size ? ` n=${token.size}` : ''
    const exposure = token.exposedFaces !== undefined ? ` exp=${token.exposedFaces}` : ''
    return `${token.name}/${token.category} score=${token.score}${size}${exposure} d=${token.distance.toFixed(1)} ${token.direction} (${pos.x},${pos.y},${pos.z})`
  }

  function getTopTokens (filterFn, limit = 8) {
    return getWorldTokens().filter(filterFn).slice(0, limit)
  }

  function describeAttention () {
    const tokens = getTopTokens(() => true, 8)
    return tokens.length === 0 ? 'Atencao: nada relevante perto.' : `Atencao: ${tokens.map(formatToken).join(' | ')}`
  }

  function describeScan () {
    const tokens = getWorldTokens()
    const danger = tokens.filter(token => token.heads.danger >= 60).length
    const resources = tokens.filter(token => token.heads.resource >= 40).length
    const opportunities = tokens.filter(token => token.heads.opportunity >= 55).length
    const top = tokens.slice(0, 3).map(token => `${token.name}(${token.score})`).join(', ') || 'nada'
    const age = perceptionState.cache.updatedAt ? ((Date.now() - perceptionState.cache.updatedAt) / 1000).toFixed(1) : 'sem'
    return `Objetivo=${perceptionState.objective} | cache=${age}s | perigo=${danger} recurso=${resources} oportunidade=${opportunities} | top: ${top}`
  }

  function describeHazards () {
    const tokens = getTopTokens(token => token.heads.danger >= 35, 8)
    return tokens.length === 0 ? 'Perigos: nenhum perigo relevante perto.' : `Perigos: ${tokens.map(formatToken).join(' | ')}`
  }

  function describeResources () {
    const tokens = getTopTokens(token => token.heads.resource >= 35 || token.heads.opportunity >= 55, 8)
    return tokens.length === 0 ? 'Recursos: nada relevante perto.' : `Recursos: ${tokens.map(formatToken).join(' | ')}`
  }

  function describeEntities () {
    const tokens = getTopTokens(token => token.kind === 'entity', 8)
    return tokens.length === 0 ? 'Entidades: nada relevante perto.' : `Entidades: ${tokens.map(formatToken).join(' | ')}`
  }

  function describeSurroundings () {
    const current = bot()
    const base = current.entity.position.floored()
    const below = current.blockAt(base.offset(0, -1, 0))?.name || 'desconhecido'
    const feet = current.blockAt(base)?.name || 'desconhecido'
    const head = current.blockAt(base.offset(0, 1, 0))?.name || 'desconhecido'
    const front = current.blockAtCursor(2)?.name || 'nada'
    const escapes = getEscapeDirections().map(direction => direction.name).join(', ') || 'nenhuma'
    return `Arredores: abaixo=${below} pes=${feet} cabeca=${head} frente=${front} saidas=${escapes}`
  }

  function normalizeCollectTarget (query) {
    const resolution = resolveCatalogQuery(query, 'collect')
    const normalized = resolution.raw
    const blockNames = new Set()
    const blockCategories = new Set()
    const blockScores = new Map()

    for (const candidate of resolution.candidates) {
      if (candidate.kind === 'block') {
        blockNames.add(candidate.name)
        blockScores.set(candidate.name, Math.max(blockScores.get(candidate.name) || 0, candidate.score))
      } else if (candidate.kind === 'block_category') {
        blockCategories.add(candidate.name)
      }
    }

    if (catalog.blockCategories[normalized]) {
      blockCategories.add(normalized)
    }

    return {
      raw: resolution.raw,
      resolution,
      blockNames,
      blockCategories,
      blockScores
    }
  }

  function collectTargetMatchesBlockName (target, blockName) {
    if (target.blockNames.has(blockName)) return true
    for (const category of target.blockCategories) {
      if (catalogBlockHasCategory(blockName, category)) return true
    }
    return false
  }

  function collectTargetMatchesToken (target, token) {
    if (token.kind !== 'block' && token.kind !== 'block_group') return false
    if (token.category === 'liquid_pool' || token.category === 'hazard_group') return false

    if (target.blockNames.has(token.name)) return true
    if (token.blockNames?.some(blockName => target.blockNames.has(blockName))) return true

    for (const category of target.blockCategories) {
      if (category === 'ore' && token.category === 'ore_vein') return true
      if (category === 'wood' && token.category === 'tree') return true
      if (category === 'stone' && token.category === 'stone_group') return true
      if (catalogBlockHasCategory(token.name, category)) return true
    }

    return false
  }

  function blockFromPositionInfo (position) {
    if (!position) return null
    return bot().blockAt(new Vec3(position.x, position.y, position.z))
  }

  function blocksFromToken (token) {
    const positions = token.blocks || [token.nearest || token.position]
    return positions
      .map(blockFromPositionInfo)
      .filter(block => block && block.name && block.boundingBox === 'block')
  }

  return {
    PERCEPTION_RADIUS,
    PERCEPTION_VERTICAL,
    perceptionState,
    objectiveWeights,
    oreBlocks,
    stoneBlocks,
    woodBlocks,
    liquidBlocks,
    hazardBlocks,
    blockKey,
    positionOf,
    refreshPerceptionCache,
    getWorldTokens,
    describePerceptionCache,
    describeCatalogResolution,
    describeAttention,
    describeScan,
    describeHazards,
    describeResources,
    describeEntities,
    describeSurroundings,
    normalizeCollectTarget,
    collectTargetMatchesBlockName,
    collectTargetMatchesToken,
    blocksFromToken
  }
}

module.exports = {
  createPerceptionHelpers
}
