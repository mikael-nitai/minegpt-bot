const MAX_COLLECT_SEQUENCE = 10
const COLLECT_SEQUENCE_TIMEOUT_MS = 90000

function createCollectionSystem ({
  context,
  Vec3,
  goals,
  perception,
  inventory,
  navigation,
  wait,
  withTimeout,
  startSkill,
  finishSkill,
  assertSkillActive
}) {
  const collectionState = {
    recent: [],
    autoDrops: false,
    autoDropsBusy: false
  }

  const {
    oreBlocks,
    stoneBlocks,
    woodBlocks,
    liquidBlocks,
    hazardBlocks,
    blockKey,
    refreshPerceptionCache,
    getWorldTokens,
    normalizeCollectTarget,
    collectTargetMatchesBlockName,
    collectTargetMatchesToken,
    blocksFromToken
  } = perception

  const {
    inventorySnapshot,
    diffInventorySnapshots,
    formatItemList,
    itemTargetMatchesName,
    possibleDropNamesForBlock,
    inventoryCanReceiveAny
  } = inventory

  function bot () {
    if (!context.bot) throw new Error('bot ainda nao inicializado')
    return context.bot
  }

  function isReconnecting () {
    return Boolean(context.reconnecting)
  }

  function recordCollection (source, gains) {
    if (gains.length === 0) return

    collectionState.recent.unshift({
      source,
      gains,
      time: Date.now()
    })

    collectionState.recent = collectionState.recent.slice(0, 8)
  }

  function describeRecentCollections () {
    if (collectionState.recent.length === 0) return 'Coletas recentes: nenhuma.'

    return `Coletas recentes: ${collectionState.recent.map((entry) => {
      const secondsAgo = Math.round((Date.now() - entry.time) / 1000)
      return `${formatItemList(entry.gains)} de ${entry.source} ha ${secondsAgo}s`
    }).join(' | ')}`
  }

  function getDroppedItemFromEntity (entity) {
    if (!entity || typeof entity.getDroppedItem !== 'function') return null

    try {
      return entity.getDroppedItem()
    } catch {
      return null
    }
  }

  function isDroppedItemEntity (entity) {
    return Boolean(getDroppedItemFromEntity(entity))
  }

  function describeDroppedItemEntity (entity) {
    const item = getDroppedItemFromEntity(entity)
    if (!item) return 'item'
    return `${item.count}x ${item.name}`
  }

  function blockIsPassable (pos) {
    const block = bot().blockAt(pos)
    if (!block) return false
    return block.boundingBox === 'empty' || block.climbable
  }

  function blockIsStandable (pos) {
    const block = bot().blockAt(pos)
    if (!block) return false
    return block.boundingBox === 'block'
  }

  function exposedFacesOfBlock (block) {
    return [
      { name: 'leste', offset: new Vec3(1, 0, 0), facePoint: block.position.offset(1.01, 0.5, 0.5) },
      { name: 'oeste', offset: new Vec3(-1, 0, 0), facePoint: block.position.offset(-0.01, 0.5, 0.5) },
      { name: 'cima', offset: new Vec3(0, 1, 0), facePoint: block.position.offset(0.5, 1.01, 0.5) },
      { name: 'baixo', offset: new Vec3(0, -1, 0), facePoint: block.position.offset(0.5, -0.01, 0.5) },
      { name: 'sul', offset: new Vec3(0, 0, 1), facePoint: block.position.offset(0.5, 0.5, 1.01) },
      { name: 'norte', offset: new Vec3(0, 0, -1), facePoint: block.position.offset(0.5, 0.5, -0.01) }
    ].filter((face) => {
      const adjacent = bot().blockAt(block.position.plus(face.offset))
      return !adjacent || adjacent.boundingBox !== 'block'
    })
  }

  function clearLineBetween (from, to, allowedBlocks = []) {
    const distance = from.distanceTo(to)
    const steps = Math.max(1, Math.ceil(distance * 5))
    const allowedKeys = new Set(allowedBlocks.filter(Boolean).map(block => blockKey(block.position)))

    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const point = new Vec3(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t
      )
      const block = bot().blockAt(point)
      if (!block || block.boundingBox !== 'block') continue
      if (allowedKeys.has(blockKey(block.position))) continue
      return false
    }

    return true
  }

  function vec3CenterOfBlock (block) {
    return block.position.offset(0.5, 0.5, 0.5)
  }

  function hasClearLineToFace (block, face) {
    return clearLineBetween(bot().entity.position.offset(0, 1.6, 0), face.facePoint, [block])
  }

  function hasClearLineToBlockCenter (fromBlock, toBlock) {
    return clearLineBetween(vec3CenterOfBlock(fromBlock), vec3CenterOfBlock(toBlock), [fromBlock, toBlock])
  }

  function interactionSpotsForBlock (block) {
    const spots = []

    for (const face of exposedFacesOfBlock(block)) {
      const base = block.position.plus(face.offset)
      const candidates = [
        base,
        base.offset(0, -1, 0),
        base.offset(0, -2, 0)
      ]

      for (const candidate of candidates) {
        const feet = candidate.floored()
        const head = feet.offset(0, 1, 0)
        const below = feet.offset(0, -1, 0)
        if (!blockIsPassable(feet) || !blockIsPassable(head) || !blockIsStandable(below)) continue

        spots.push({
          position: feet,
          face,
          distance: bot().entity.position.distanceTo(feet)
        })
      }
    }

    return spots.sort((a, b) => a.distance - b.distance)
  }

  function blockInteractionInfo (block) {
    const exposedFaces = exposedFacesOfBlock(block)
    const visibleFaces = exposedFaces.filter(face => hasClearLineToFace(block, face))
    const spots = interactionSpotsForBlock(block)

    return {
      block,
      exposedFaces,
      visibleFaces,
      spots,
      visible: visibleFaces.length > 0,
      interactableNow: visibleFaces.length > 0 && bot().canDigBlock(block),
      hasSafeSpot: spots.length > 0
    }
  }

  function adjacentPositions (position) {
    return [
      position.offset(1, 0, 0), position.offset(-1, 0, 0),
      position.offset(0, 1, 0), position.offset(0, -1, 0),
      position.offset(0, 0, 1), position.offset(0, 0, -1)
    ]
  }

  function preferredEntryBlockForHiddenTarget (targetBlock) {
    const candidates = adjacentPositions(targetBlock.position)
      .map(position => bot().blockAt(position))
      .filter(block => block && block.boundingBox === 'block' && block.diggable)
      .filter(block => !liquidBlocks.has(block.name) && !hazardBlocks.has(block.name))
      .map(block => blockInteractionInfo(block))
      .filter(info => info.visible || info.hasSafeSpot)
      .filter(info => hasClearLineToBlockCenter(info.block, targetBlock))
      .sort((a, b) => {
        const scoreA = (a.visible ? 30 : 0) + (a.hasSafeSpot ? 20 : 0) - bot().entity.position.distanceTo(a.block.position)
        const scoreB = (b.visible ? 30 : 0) + (b.hasSafeSpot ? 20 : 0) - bot().entity.position.distanceTo(b.block.position)
        return scoreB - scoreA
      })

    return candidates[0] || null
  }

  function scoreCollectionBlockChoice (token, targetBlock, miningInfo, requestedTarget) {
    const exactTarget = collectTargetMatchesBlockName(requestedTarget, miningInfo.block.name)
    let score = token.score

    if (exactTarget) score += 80
    if (miningInfo.visible) score += 70
    if (miningInfo.interactableNow) score += 50
    if (miningInfo.hasSafeSpot) score += 25
    if (oreBlocks.has(targetBlock.name) && !exactTarget) score += 35
    if (oreBlocks.has(targetBlock.name) && exactTarget) score += 80

    score -= bot().entity.position.distanceTo(miningInfo.block.position) * 3
    return score
  }

  function chooseBlockFromToken (token, target, requireInteraction = false) {
    const targetBlocks = blocksFromToken(token)
      .filter(block => collectTargetMatchesBlockName(target, block.name))
      .filter(block => block.diggable)

    const choices = []

    for (const targetBlock of targetBlocks) {
      const targetInfo = blockInteractionInfo(targetBlock)
      if (!requireInteraction || targetInfo.interactableNow || targetInfo.hasSafeSpot) {
        choices.push({
          targetBlock,
          block: targetBlock,
          info: targetInfo,
          mode: 'direct',
          score: scoreCollectionBlockChoice(token, targetBlock, targetInfo, target)
        })
      }

      if (!targetInfo.visible && oreBlocks.has(targetBlock.name)) {
        const entryInfo = preferredEntryBlockForHiddenTarget(targetBlock)
        if (entryInfo) {
          choices.push({
            targetBlock,
            block: entryInfo.block,
            info: entryInfo,
            mode: 'approach_hidden_target',
            score: scoreCollectionBlockChoice(token, targetBlock, entryInfo, target) - 45
          })
        }
      }
    }

    choices.sort((a, b) => b.score - a.score)
    return choices[0] || null
  }

  function selectCollectionCandidate (targetQuery) {
    const target = normalizeCollectTarget(targetQuery)
    const candidates = getWorldTokens()
      .filter(token => collectTargetMatchesToken(target, token))
      .map(token => ({ token, choice: chooseBlockFromToken(token, target, true) }))
      .filter(candidate => candidate.choice)
      .sort((a, b) => b.choice.score - a.choice.score || b.token.score - a.token.score)

    return candidates[0] ? { ...candidates[0], target } : null
  }

  function getToolKindForBlock (block) {
    if (woodBlocks.has(block.name)) return 'axe'
    if (oreBlocks.has(block.name) || stoneBlocks.has(block.name)) return 'pickaxe'
    return null
  }

  function toolTier (itemName) {
    if (itemName.startsWith('netherite_')) return 5
    if (itemName.startsWith('diamond_')) return 4
    if (itemName.startsWith('iron_')) return 3
    if (itemName.startsWith('stone_')) return 2
    if (itemName.startsWith('golden_')) return 1
    if (itemName.startsWith('wooden_')) return 1
    return 0
  }

  function fallbackRequiredPickaxeTier (blockName) {
    if (blockName.includes('diamond') || blockName.includes('emerald')) return 3
    if (blockName.includes('gold') || blockName.includes('redstone') || blockName.includes('lapis')) return 2
    if (blockName.includes('iron')) return 2
    if (oreBlocks.has(blockName) || stoneBlocks.has(blockName)) return 1
    return 0
  }

  function canHarvestWithItem (block, item) {
    const toolKind = getToolKindForBlock(block)
    if (!toolKind && typeof block.canHarvest === 'function') return block.canHarvest(item ? item.type : null)
    if (!toolKind) return true

    if (!item || !item.name.endsWith(`_${toolKind}`)) return false
    if (toolKind !== 'pickaxe') return true

    if (typeof block.canHarvest === 'function') return block.canHarvest(item.type)
    return toolTier(item.name) >= fallbackRequiredPickaxeTier(block.name)
  }

  function chooseToolForBlock (block) {
    const toolKind = getToolKindForBlock(block)
    const handCanHarvest = canHarvestWithItem(block, null)
    const tools = bot().inventory.items()
      .filter(item => toolKind ? item.name.endsWith(`_${toolKind}`) : item.name.endsWith('_axe') || item.name.endsWith('_pickaxe'))
      .sort((a, b) => toolTier(b.name) - toolTier(a.name))

    const harvestTool = tools.find(item => canHarvestWithItem(block, item))
    if (harvestTool) return { ok: true, item: harvestTool, usingHand: false }
    if (handCanHarvest) return { ok: true, item: null, usingHand: true }

    return {
      ok: false,
      reason: toolKind
        ? `preciso de ${toolKind === 'pickaxe' ? 'picareta' : 'machado'} adequado para ${block.name}`
        : `nao tenho ferramenta adequada para ${block.name}`
    }
  }

  async function equipToolForBlock (block) {
    const choice = chooseToolForBlock(block)
    if (!choice.ok) return choice

    if (!choice.item) return { ok: true, tool: 'mao' }
    if (bot().heldItem?.name !== choice.item.name) {
      await bot().equip(choice.item, 'hand')
    }

    return { ok: true, tool: choice.item.name }
  }

  function targetTouchesLava (block) {
    return adjacentPositions(block.position)
      .some(position => bot().blockAt(position)?.name === 'lava')
  }

  function findImmediateCollectionRisk (targetBlock = null, options = {}) {
    if (isReconnecting()) return 'o bot esta reconectando'
    if (bot().health <= 8) return `vida baixa (${bot().health}/20)`
    const expectedItemNames = options.itemNames || (targetBlock ? possibleDropNamesForBlock(targetBlock) : [])
    if (!inventoryCanReceiveAny(expectedItemNames)) return 'inventario sem espaco compativel'
    if (targetBlock && targetTouchesLava(targetBlock)) return `${targetBlock.name} encosta em lava`

    const danger = getWorldTokens().find((token) => {
      if (token.category === 'hostile_mob') {
        if (token.name === 'skeleton' || token.name === 'stray' || token.name === 'pillager') {
          return token.heads.danger >= 80 && token.distance <= 14
        }

        return token.heads.danger >= 75 && token.distance <= 8
      }

      if (token.category === 'liquid_pool' && token.name === 'lava') {
        return token.exposedFaces > 0 && token.distance <= 5
      }

      return token.category === 'fall_risk' && token.distance <= 2
    })

    if (!danger) return null
    return `${danger.name}/${danger.category} perto demais`
  }

  async function collectNearbyDrops (origin) {
    return collectDropsAround(origin, {
      radius: 7,
      durationMs: 3500,
      maxDrops: 6,
      announce: false,
      stopOnGain: true
    })
  }

  function droppedItemMatchesTarget (entity, target = null) {
    if (!target) return true
    const item = getDroppedItemFromEntity(entity)
    return Boolean(item && itemTargetMatchesName(target, item.name))
  }

  function nearestDroppedItem (origin, radius, target = null) {
    return Object.values(bot().entities)
      .filter(entity => isDroppedItemEntity(entity) && entity.position)
      .filter(entity => droppedItemMatchesTarget(entity, target))
      .filter(entity => entity.position.distanceTo(origin) <= radius)
      .sort((a, b) => a.position.distanceTo(bot().entity.position) - b.position.distanceTo(bot().entity.position))[0] || null
  }

  async function moveOntoDrop (drop) {
    const target = drop.position.floored()

    await withTimeout(
      bot().pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z)),
      5000,
      `ir ate drop ${describeDroppedItemEntity(drop)}`
    ).catch(() => {})

    if (drop.isValid === false || !drop.position) return
    if (bot().entity.position.distanceTo(drop.position) <= 2.2) {
      await bot().lookAt(drop.position.offset(0, 0.2, 0), true).catch(() => {})
      await navigation.setTemporaryControls(['forward'], 450)
      bot().clearControlStates()
    }
  }

  async function collectDropsAround (origin = bot().entity.position.clone(), options = {}) {
    const radius = options.radius || 6
    const durationMs = options.durationMs || 4000
    const maxDrops = options.maxDrops || 5
    const announce = options.announce === true
    const stopOnGain = options.stopOnGain === true
    const target = options.target || null
    const before = inventorySnapshot()
    const deadline = Date.now() + durationMs
    let visited = 0
    let gains = []

    while (!isReconnecting() && Date.now() < deadline && visited < maxDrops) {
      const currentGains = diffInventorySnapshots(before, inventorySnapshot())
      if (stopOnGain && currentGains.length > 0) {
        gains = currentGains
        break
      }

      const drop = nearestDroppedItem(origin, radius, target)
      if (!drop) {
        await wait(100)
        continue
      }

      const item = getDroppedItemFromEntity(drop)
      const risk = findImmediateCollectionRisk(null, { itemNames: item?.name ? [item.name] : [] })
      if (risk) {
        if (announce) bot().chat(`Busca de drops interrompida: ${risk}.`)
        break
      }

      visited += 1
      await moveOntoDrop(drop)
      await wait(100)
    }

    if (gains.length === 0) {
      gains = diffInventorySnapshots(before, inventorySnapshot())
    }
    if (gains.length > 0) {
      recordCollection('drops proximos', gains)
      if (announce) bot().chat(`Drops coletados: ${formatItemList(gains)}.`)
    } else if (announce) {
      bot().chat('Nao coletei nenhum drop novo.')
    }

    return gains
  }

  async function runAutoDropCollection () {
    if (!collectionState.autoDrops || collectionState.autoDropsBusy || context.activeSkill || isReconnecting() || !bot().entity) return
    if (bot().pathfinder.isMoving()) return

    const drop = nearestDroppedItem(bot().entity.position, 6)
    if (!drop) return
    const item = getDroppedItemFromEntity(drop)
    if (findImmediateCollectionRisk(null, { itemNames: item?.name ? [item.name] : [] })) return

    collectionState.autoDropsBusy = true
    try {
      await collectDropsAround(bot().entity.position.clone(), {
        radius: 6,
        durationMs: 3500,
        maxDrops: 4,
        announce: false
      })
    } catch (err) {
      console.error('Erro na busca automatica de drops:', err)
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      collectionState.autoDropsBusy = false
    }
  }

  async function collectOneBlockByTarget (targetQuery, skill, options = {}) {
    refreshPerceptionCache(true)
    const selection = selectCollectionCandidate(targetQuery)
    if (!selection) {
      throw new Error(`nao encontrei alvo coletavel para "${targetQuery}" na percepcao atual`)
    }

    const initialRisk = findImmediateCollectionRisk(selection.choice.block)
    if (initialRisk) {
      throw new Error(`nao vou coletar agora: ${initialRisk}`)
    }

    assertSkillActive(skill)
    const token = selection.token
    const firstChoice = selection.choice
    const firstBlock = firstChoice.block
    const targetBlock = firstChoice.targetBlock
    const plan = firstChoice.mode === 'direct'
      ? firstBlock.name
      : `${firstBlock.name} para abrir caminho ate ${targetBlock.name}`
    if (options.announce !== false) {
      bot().chat(`Coletando ${plan}; escolhido por ${token.category} score=${token.score}.`)
    }

    const firstSpot = firstChoice.info.spots[0]
    const goal = firstSpot
      ? new goals.GoalBlock(firstSpot.position.x, firstSpot.position.y, firstSpot.position.z)
      : new goals.GoalNear(firstBlock.position.x, firstBlock.position.y, firstBlock.position.z, 3)

    await withTimeout(
      bot().pathfinder.goto(goal),
      15000,
      'aproximacao do bloco'
    )

    assertSkillActive(skill)
    if (isReconnecting()) throw new Error('bot reconectou durante a coleta')

    const refreshedChoice = chooseBlockFromToken(token, selection.target, true)
    if (!refreshedChoice) {
      throw new Error('nenhum bloco exposto/interagivel ficou disponivel')
    }

    const reachableBlock = refreshedChoice.block
    const refreshedInfo = blockInteractionInfo(reachableBlock)
    if (!refreshedInfo.visible && !refreshedInfo.interactableNow) {
      throw new Error(`${reachableBlock.name} nao tem linha livre ate uma face exposta`)
    }

    if (!bot().canDigBlock(reachableBlock)) {
      throw new Error(`${reachableBlock.name} nao esta ao alcance fisico para minerar`)
    }

    const secondRisk = findImmediateCollectionRisk(reachableBlock)
    if (secondRisk) {
      throw new Error(`risco detectado antes de minerar: ${secondRisk}`)
    }

    const toolResult = await equipToolForBlock(reachableBlock)
    if (!toolResult.ok) throw new Error(toolResult.reason)

    assertSkillActive(skill)
    const before = inventorySnapshot()
    const source = `${reachableBlock.name} (${reachableBlock.position.x},${reachableBlock.position.y},${reachableBlock.position.z})`

    await withTimeout(bot().dig(reachableBlock), 10000, `minerar ${reachableBlock.name}`)
    assertSkillActive(skill)
    await wait(150)
    await collectNearbyDrops(reachableBlock.position)

    const gains = diffInventorySnapshots(before, inventorySnapshot())
    recordCollection(source, gains)

    return {
      blockName: reachableBlock.name,
      tool: toolResult.tool,
      source,
      gains
    }
  }

  async function collectBlockByTarget (targetQuery) {
    if (context.activeSkill) {
      bot().chat(`Ja estou executando ${context.activeSkill.name}. Use parar se precisar interromper.`)
      return
    }

    const skill = startSkill('coletar')
    context.navigationController.stop('skill coletar')

    try {
      const result = await collectOneBlockByTarget(targetQuery, skill)
      if (result.gains.length > 0) {
        bot().chat(`Coleta concluida: quebrei ${result.blockName} com ${result.tool} e peguei ${formatItemList(result.gains)}.`)
      } else {
        bot().chat(`Quebrei ${result.blockName} com ${result.tool}, mas nao detectei item novo no inventario.`)
      }
    } catch (err) {
      bot().chat(`Falha ao coletar: ${err.message}`)
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  async function collectMultipleBlocksByTarget (targetQuery, requestedCount) {
    if (context.activeSkill) {
      bot().chat(`Ja estou executando ${context.activeSkill.name}. Use parar se precisar interromper.`)
      return
    }

    const count = Math.min(requestedCount, MAX_COLLECT_SEQUENCE)
    const skill = startSkill('coletar')
    const startedAt = Date.now()
    const totalGains = new Map()
    let successes = 0
    let attempts = 0
    let stopReason = null

    context.navigationController.stop('skill coletar sequencia')
    bot().chat(`Coletando ate ${count}x ${targetQuery}.`)

    try {
      for (let index = 1; index <= count; index++) {
        assertSkillActive(skill)
        if (Date.now() - startedAt > COLLECT_SEQUENCE_TIMEOUT_MS) {
          stopReason = 'timeout total'
          break
        }

        attempts += 1
        try {
          const result = await collectOneBlockByTarget(targetQuery, skill, { announce: false })
          successes += 1

          for (const item of result.gains) {
            totalGains.set(item.name, (totalGains.get(item.name) || 0) + item.count)
          }

          const gained = result.gains.length > 0 ? formatItemList(result.gains) : 'sem item novo'
          bot().chat(`Coleta ${index}/${count}: quebrei ${result.blockName}; ${gained}.`)
        } catch (err) {
          stopReason = err.message
          break
        }
      }

      const gains = [...totalGains.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, itemCount]) => ({ name, count: itemCount }))
      const gainedText = gains.length > 0 ? formatItemList(gains) : 'nenhum item registrado'
      const reasonText = stopReason ? ` | parada: ${stopReason}` : ''
      bot().chat(`Coleta finalizada: tentativas=${attempts} sucessos=${successes}/${count} itens=${gainedText}${reasonText}`)
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  return {
    MAX_COLLECT_SEQUENCE,
    collectionState,
    toolTier,
    describeRecentCollections,
    getDroppedItemFromEntity,
    isDroppedItemEntity,
    describeDroppedItemEntity,
    collectDropsAround,
    runAutoDropCollection,
    collectBlockByTarget,
    collectMultipleBlocksByTarget
  }
}

module.exports = {
  createCollectionSystem,
  MAX_COLLECT_SEQUENCE
}
