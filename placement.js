const { actionOk, actionFail, itemRequirement } = require('./action-result')

const PLACE_SKILL_ID = 'blocks.place'
const MAX_PLACE_DISTANCE = 16
const DIRECT_PLACE_DISTANCE = 4.5
const PLACE_TIMEOUT_MS = 5000

const SUPPORT_FACES = [
  { offset: [0, -1, 0], face: [0, 1, 0], name: 'baixo' },
  { offset: [0, 1, 0], face: [0, -1, 0], name: 'cima' },
  { offset: [-1, 0, 0], face: [1, 0, 0], name: 'oeste' },
  { offset: [1, 0, 0], face: [-1, 0, 0], name: 'leste' },
  { offset: [0, 0, -1], face: [0, 0, 1], name: 'norte' },
  { offset: [0, 0, 1], face: [0, 0, -1], name: 'sul' }
]

const HAZARD_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'powder_snow'
])

function parsePlaceCommand (text) {
  const raw = String(text || '').trim()
  if (!raw) return { target: 'bloco', mode: 'front', raw }

  const coordsMatch = raw.match(/^(.+?)\s+em\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/)
  if (coordsMatch) {
    return {
      target: coordsMatch[1].trim() || 'bloco',
      mode: 'coords',
      coords: {
        x: Number(coordsMatch[2]),
        y: Number(coordsMatch[3]),
        z: Number(coordsMatch[4])
      },
      raw
    }
  }

  const suffixes = [
    { suffix: ' perto de mim', mode: 'near_owner' },
    { suffix: ' abaixo', mode: 'below' },
    { suffix: ' na frente', mode: 'front' }
  ]

  for (const { suffix, mode } of suffixes) {
    if (raw.endsWith(suffix)) {
      return {
        target: raw.slice(0, -suffix.length).trim() || 'bloco',
        mode,
        raw
      }
    }
  }

  return { target: raw, mode: 'front', raw }
}

function blockPosKey (position) {
  return `${position.x},${position.y},${position.z}`
}

function createPlacementHelpers ({
  getBot,
  Vec3,
  catalog,
  inventory,
  goals,
  withTimeout,
  owner,
  getActiveSkill,
  startSkill,
  finishSkill,
  assertSkillActive,
  getNavigationController,
  getReconnecting,
  survival
}) {
  const {
    normalizeItemName,
    resolveCatalogQuery,
    catalogItemHasCategory
  } = catalog

  function bot () {
    const current = getBot()
    if (!current) throw new Error('bot ainda nao inicializado')
    return current
  }

  function vec (coords) {
    return new Vec3(coords.x, coords.y, coords.z)
  }

  function normalizeTarget (target) {
    const normalized = normalizeItemName(target || 'bloco')
    return normalized === 'block' ? 'bloco' : normalized
  }

  function itemIsPlaceableBlock (itemName) {
    const current = bot()
    return Boolean(current.registry?.blocksByName?.[itemName] || catalog.data.blocksByName?.[itemName])
  }

  function inventoryBlockItems () {
    return bot().inventory.items()
      .filter(item => itemIsPlaceableBlock(item.name))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  function scoreInventoryBlockForTarget (item, requestTarget) {
    const target = normalizeTarget(requestTarget)
    let score = 0
    if (target === 'bloco') score += 100
    if (item.name === target) score += 400

    const resolution = resolveCatalogQuery(requestTarget, 'item')
    for (const candidate of resolution.candidates) {
      if (candidate.kind === 'item' && candidate.name === item.name) score = Math.max(score, candidate.score + 100)
      if (candidate.kind === 'block' && candidate.name === item.name) score = Math.max(score, candidate.score + 80)
      if (candidate.kind === 'item_category' && catalogItemHasCategory(item.name, candidate.name)) {
        score = Math.max(score, candidate.score + 40)
      }
    }

    if (item.name.endsWith('_planks') || item.name === 'dirt' || item.name === 'cobblestone') score += 20
    return score
  }

  function resolvePlaceBlockItem (requestTarget) {
    const target = normalizeTarget(requestTarget)
    const placeable = inventoryBlockItems()
    if (placeable.length === 0) {
      return { ok: false, reason: 'nao tenho nenhum bloco colocavel no inventario' }
    }

    if (target === 'bloco') {
      return { ok: true, item: placeable[0], resolution: { raw: target, candidates: [] } }
    }

    const candidates = placeable
      .map(item => ({ item, score: scoreInventoryBlockForTarget(item, requestTarget) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.item.count - a.item.count || a.item.name.localeCompare(b.item.name))

    if (candidates.length === 0) {
      const resolution = resolveCatalogQuery(requestTarget, 'item')
      const known = resolution.candidates.length > 0
      return {
        ok: false,
        reason: known
          ? `nao tenho bloco colocavel compatível com "${requestTarget}"`
          : `nao reconheci bloco "${requestTarget}"`
      }
    }

    return {
      ok: true,
      item: candidates[0].item,
      resolution: resolveCatalogQuery(requestTarget, 'item')
    }
  }

  function blockIsEmptyForPlacement (block) {
    if (!block) return false
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return true
    return block.boundingBox === 'empty' && !block.name.includes('water') && !block.name.includes('lava')
  }

  function blockIsSolidSupport (block) {
    if (!block) return false
    if (HAZARD_BLOCKS.has(block.name)) return false
    return block.boundingBox === 'block'
  }

  function targetIntersectsEntity (targetPos) {
    const current = bot()
    const blocked = [
      current.entity.position.floored(),
      current.entity.position.floored().offset(0, 1, 0)
    ]

    const ownerEntity = current.players?.[owner]?.entity
    if (ownerEntity) {
      blocked.push(ownerEntity.position.floored())
      blocked.push(ownerEntity.position.floored().offset(0, 1, 0))
    }

    const key = blockPosKey(targetPos)
    return blocked.some(position => blockPosKey(position) === key)
  }

  function targetTouchesHazard (targetPos) {
    const current = bot()
    return SUPPORT_FACES.some(({ offset }) => {
      const position = targetPos.offset(offset[0], offset[1], offset[2])
      const block = current.blockAt(position)
      return block && HAZARD_BLOCKS.has(block.name)
    })
  }

  function findSupportFace (targetPos) {
    const current = bot()
    for (const { offset, face, name } of SUPPORT_FACES) {
      const referencePos = targetPos.offset(offset[0], offset[1], offset[2])
      const referenceBlock = current.blockAt(referencePos)
      if (!blockIsSolidSupport(referenceBlock)) continue
      return {
        referenceBlock,
        faceVector: new Vec3(face[0], face[1], face[2]),
        supportName: name
      }
    }

    return null
  }

  function frontDirection () {
    const yaw = bot().entity.yaw || 0
    let dx = Math.round(-Math.sin(yaw))
    let dz = Math.round(Math.cos(yaw))
    if (dx === 0 && dz === 0) dz = 1
    return { dx, dz }
  }

  function candidatePositionsForRequest (request) {
    const current = bot()
    const base = current.entity.position.floored()

    if (request.mode === 'coords') return [vec(request.coords).floored()]
    if (request.mode === 'below') return [base.offset(0, -1, 0)]

    if (request.mode === 'near_owner') {
      const ownerEntity = current.players?.[owner]?.entity
      const origin = ownerEntity ? ownerEntity.position.floored() : base
      return [
        origin.offset(1, 0, 0),
        origin.offset(-1, 0, 0),
        origin.offset(0, 0, 1),
        origin.offset(0, 0, -1),
        origin.offset(1, -1, 0),
        origin.offset(-1, -1, 0),
        origin.offset(0, -1, 1),
        origin.offset(0, -1, -1)
      ]
    }

    const { dx, dz } = frontDirection()
    return [
      base.offset(dx, 0, dz),
      base.offset(dx, -1, dz),
      base.offset(dx * 2, 0, dz * 2),
      base.offset(dx * 2, -1, dz * 2)
    ]
  }

  function validatePlacementTarget (targetPos) {
    const current = bot()
    const block = current.blockAt(targetPos)
    if (!blockIsEmptyForPlacement(block)) {
      return { ok: false, reason: `posicao ocupada por ${block ? block.name : 'bloco desconhecido'}` }
    }

    if (targetIntersectsEntity(targetPos)) {
      return { ok: false, reason: 'posicao colide com o bot ou com o jogador' }
    }

    if (targetTouchesHazard(targetPos)) {
      return { ok: false, reason: 'posicao encosta em bloco perigoso' }
    }

    const support = findSupportFace(targetPos)
    if (!support) return { ok: false, reason: 'nao existe face de apoio valida' }

    return { ok: true, support }
  }

  function selectPlacementPosition (request) {
    const candidates = candidatePositionsForRequest(request)
    const checked = []

    for (const position of candidates) {
      const validation = validatePlacementTarget(position)
      checked.push({ position, validation })
      if (validation.ok) return { ok: true, position, support: validation.support, checked }
    }

    return {
      ok: false,
      reason: checked[0]?.validation.reason || 'nenhuma posicao candidata valida',
      checked
    }
  }

  function immediateRisk () {
    const current = bot()
    if (getReconnecting()) return 'o bot esta reconectando'
    if (!current.entity) return 'bot sem entidade no mundo'
    if (current.health <= 8) return `vida baixa (${current.health}/20)`

    const assessment = survival?.assess?.()
    const topRisk = assessment?.topRisk || assessment?.risk || assessment?.currentRisk || null
    const severity = Number(topRisk?.severity ?? assessment?.severity ?? 0)
    if (severity >= 85) return `risco de sobrevivencia alto: ${topRisk?.reason || topRisk?.source || severity}`

    return null
  }

  async function moveNearTargetIfNeeded (targetPos) {
    const current = bot()
    const distance = current.entity.position.distanceTo(targetPos)
    if (distance <= DIRECT_PLACE_DISTANCE) return
    if (distance > MAX_PLACE_DISTANCE) {
      throw new Error(`alvo longe demais (${distance.toFixed(1)} blocos, max ${MAX_PLACE_DISTANCE})`)
    }

    getNavigationController()?.applyMovements?.()
    await withTimeout(
      current.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3)),
      12000,
      'aproximacao para colocar bloco'
    )
  }

  async function placeByRequest (request) {
    const current = bot()
    const startedAt = Date.now()
    if (getActiveSkill()) {
      return actionFail(PLACE_SKILL_ID, `ja estou executando ${getActiveSkill().name}`, {}, startedAt, {
        code: 'active_skill_busy',
        retryable: true
      })
    }

    const risk = immediateRisk()
    if (risk) {
      return actionFail(PLACE_SKILL_ID, `nao vou colocar bloco agora: ${risk}`, { risk }, startedAt, {
        code: 'unsafe_area',
        retryable: true
      })
    }

    const resolved = resolvePlaceBlockItem(request.target)
    if (!resolved.ok) {
      return actionFail(PLACE_SKILL_ID, resolved.reason, { target: request.target }, startedAt, {
        code: /nao tenho/.test(resolved.reason) ? 'missing_block' : 'unknown_block',
        retryable: /nao tenho/.test(resolved.reason),
        missingRequirements: /nao tenho/.test(resolved.reason) ? [itemRequirement(request.target || 'bloco', 1)] : []
      })
    }

    const initialSelection = selectPlacementPosition(request)
    if (!initialSelection.ok) {
      return actionFail(PLACE_SKILL_ID, initialSelection.reason, { checked: initialSelection.checked }, startedAt, {
        code: 'invalid_position',
        retryable: true
      })
    }

    const skill = startSkill('colocar_bloco')
    if (!skill) {
      return actionFail(PLACE_SKILL_ID, `ja estou executando ${getActiveSkill()?.name || 'outra skill'}`, {}, startedAt, {
        code: 'active_skill_busy',
        retryable: true
      })
    }

    getNavigationController()?.stop?.('skill colocar bloco')

    try {
      assertSkillActive(skill)
      await moveNearTargetIfNeeded(initialSelection.position)
      assertSkillActive(skill)

      const finalRisk = immediateRisk()
      if (finalRisk) throw new Error(`risco detectado antes de colocar: ${finalRisk}`)

      const selection = selectPlacementPosition(request)
      if (!selection.ok) throw new Error(selection.reason)

      const before = inventory.inventorySnapshot?.()
      const item = current.inventory.items().find(stack => stack.name === resolved.item.name)
      if (!item) throw new Error(`nao tenho mais ${resolved.item.name}`)

      await current.equip(item, 'hand')
      assertSkillActive(skill)

      const lookAt = selection.position.offset(0.5, 0.5, 0.5)
      await current.lookAt(lookAt, true)
      await withTimeout(
        current.placeBlock(selection.support.referenceBlock, selection.support.faceVector),
        PLACE_TIMEOUT_MS,
        `colocar ${item.name}`
      )

      await new Promise(resolve => setTimeout(resolve, 150))
      const placed = current.blockAt(selection.position)
      if (!placed || placed.name !== item.name) {
        throw new Error(`nao confirmei o bloco colocado; encontrei ${placed ? placed.name : 'nada'}`)
      }

      const pos = selection.position
      const after = inventory.inventorySnapshot?.()
      const inventoryDelta = before && after && inventory.inventoryDeltaBetweenSnapshots
        ? inventory.inventoryDeltaBetweenSnapshots(before, after)
        : [{ name: placed.name, delta: -1 }]
      return actionOk(
        PLACE_SKILL_ID,
        `Coloquei ${placed.name} em ${pos.x} ${pos.y} ${pos.z}.`,
        {
          block: placed.name,
          position: { x: pos.x, y: pos.y, z: pos.z },
          support: selection.support.supportName
        },
        startedAt,
        {
          code: 'placed',
          worldChanged: true,
          inventoryDelta
        }
      )
    } catch (err) {
      return actionFail(PLACE_SKILL_ID, err.message, { target: request }, startedAt, {
        code: /nao tenho mais/.test(err.message)
          ? 'missing_block'
          : /risco|vida|lava|perto/.test(err.message)
              ? 'unsafe_area'
              : /longe/.test(err.message)
                  ? 'target_too_far'
                  : /confirmei/.test(err.message)
                      ? 'placement_not_confirmed'
                      : 'placement_failed',
        retryable: true,
        missingRequirements: /nao tenho mais/.test(err.message) ? [itemRequirement(request.target || 'bloco', 1)] : []
      })
    } finally {
      current.pathfinder.stop()
      current.clearControlStates()
      finishSkill(skill)
    }
  }

  function describePlaceableBlocks () {
    const items = inventoryBlockItems()
    if (items.length === 0) return 'Blocos colocaveis: nenhum.'
    return `Blocos colocaveis: ${items.map(item => `${item.count}x ${item.name}`).join(', ')}`
  }

  return {
    parsePlaceCommand,
    resolvePlaceBlockItem,
    selectPlacementPosition,
    placeByRequest,
    describePlaceableBlocks
  }
}

module.exports = {
  PLACE_SKILL_ID,
  parsePlaceCommand,
  createPlacementHelpers
}
