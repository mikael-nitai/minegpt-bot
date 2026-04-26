const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { createMinecraftCatalog } = require('./catalog')
const { createInventoryHelpers } = require('./inventory')
const { createPerceptionHelpers } = require('./perception')
const { createSurvivalGuard } = require('./survival')
const { createSkillRegistry } = require('./skills')
const { createStateReporter } = require('./state')
const { actionOk, actionFail } = require('./action-result')
const { createCraftingHelpers } = require('./crafting')

const CONFIG_PATH = path.join(__dirname, 'config.json')

function loadConfig () {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Arquivo config.json nao encontrado.')
    console.error('Copie config.example.json para config.json e ajuste owner/username se necessario.')
    process.exit(1)
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const config = JSON.parse(raw)

  const requiredKeys = ['host', 'port', 'version', 'username', 'auth', 'owner']
  for (const key of requiredKeys) {
    if (!(key in config)) {
      console.error(`Campo obrigatorio ausente em config.json: ${key}`)
      process.exit(1)
    }
  }

  return config
}

const config = loadConfig()
const mcData = minecraftData(config.version)
const minecraftCatalog = createMinecraftCatalog(mcData)
const {
  normalizeItemName
} = minecraftCatalog
const inventoryHelpers = createInventoryHelpers({
  getBot: () => bot,
  mcData,
  catalog: minecraftCatalog,
  toolTier: itemName => toolTier(itemName)
})
const {
  formatItem,
  summarizeInventory,
  inventorySnapshot,
  diffInventorySnapshots,
  formatItemList,
  normalizeItemTarget,
  itemTargetMatchesName,
  findInventoryItems,
  findInventoryItem,
  hotbarSlotToInventorySlot,
  describeStatus,
  describeHotbar,
  possibleDropNamesForBlock,
  inventoryCanReceiveAny
} = inventoryHelpers

let bot
let defaultMovements
let navigationController
let previousHealth = null
let reconnecting = false
let activeSkill = null
let skillRegistry
let stateReporter
let craftingHelpers

const collectionState = {
  recent: [],
  autoDrops: false,
  autoDropsBusy: false
}

const perceptionHelpers = createPerceptionHelpers({
  getBot: () => bot,
  Vec3,
  catalog: minecraftCatalog,
  getDroppedItemFromEntity,
  isDroppedItemEntity,
  describeDroppedItemEntity,
  ownerMatches,
  getEscapeDirections
})
const {
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
} = perceptionHelpers

const survivalGuard = createSurvivalGuard({
  getBot: () => bot,
  Vec3,
  owner: config.owner,
  perception: perceptionHelpers,
  inventory: inventoryHelpers,
  getNavigationController: () => navigationController,
  getActiveSkill: () => activeSkill,
  cancelActiveSkill,
  getReconnecting: () => reconnecting
})

stateReporter = createStateReporter({
  getBot: () => bot,
  config,
  inventory: inventoryHelpers,
  perception: perceptionHelpers,
  survival: survivalGuard,
  collectionState,
  getActiveSkill: () => activeSkill,
  getNavigationController: () => navigationController,
  getReconnecting: () => reconnecting
})

craftingHelpers = createCraftingHelpers({
  getBot: () => bot,
  mcData,
  catalog: minecraftCatalog,
  inventory: inventoryHelpers,
  goals,
  withTimeout,
  owner: config.owner,
  getActiveSkill: () => activeSkill,
  startSkill,
  finishSkill,
  assertSkillActive,
  getNavigationController: () => navigationController,
  getReconnecting: () => reconnecting,
  survival: survivalGuard
})

function ownerMatches (username) {
  return username && username.toLowerCase() === config.owner.toLowerCase()
}

function parseCoords (parts) {
  if (parts.length < 3) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])

  if ([x, y, z].some(Number.isNaN)) return null
  return { x, y, z }
}

function sendLongMessage (text) {
  const maxLength = 220

  if (text.length <= maxLength) {
    bot.chat(text)
    return
  }

  let rest = text
  while (rest.length > 0) {
    if (rest.length <= maxLength) {
      bot.chat(rest)
      return
    }

    const splitAt = rest.lastIndexOf(', ', maxLength)
    const cut = splitAt > 0 ? splitAt + 1 : maxLength
    bot.chat(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
}

function wait (durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}

function withTimeout (promise, durationMs, label) {
  let timeout

  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(durationMs / 1000)}s`)), durationMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
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

function parsePositiveInteger (value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return null
  return number
}

function resetPathfinderMovements (options = {}) {
  if (!defaultMovements) return
  defaultMovements.canDig = Boolean(options.allowDig)
  defaultMovements.allow1by1towers = Boolean(options.allowScaffold)
  defaultMovements.allowParkour = options.allowParkour !== false
  defaultMovements.scafoldingBlocks = options.allowScaffold
    ? [bot.registry.itemsByName.dirt.id, bot.registry.itemsByName.cobblestone.id]
    : []
  bot.pathfinder.setMovements(defaultMovements)
}

function setTemporaryControls (controls, durationMs) {
  for (const control of controls) bot.setControlState(control, true)

  return new Promise((resolve) => {
    setTimeout(() => {
      for (const control of controls) bot.setControlState(control, false)
      resolve()
    }, durationMs)
  })
}

async function runUnstuckSequence () {
  bot.clearControlStates()
  await setTemporaryControls(['jump'], 400)
  await setTemporaryControls(['back'], 500)
  await setTemporaryControls(['left'], 350)
  await setTemporaryControls(['right'], 700)
  await setTemporaryControls(['jump', 'back'], 500)
  bot.clearControlStates()
}

function horizontalDistance (a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

function blockIsPassable (pos) {
  const block = bot.blockAt(pos)
  if (!block) return false
  return block.boundingBox === 'empty' || block.climbable
}

function blockIsStandable (pos) {
  const block = bot.blockAt(pos)
  if (!block) return false
  return block.boundingBox === 'block'
}

function getEscapeDirections () {
  const base = bot.entity.position.floored()
  const candidates = [
    { name: 'norte', yaw: Math.PI, dx: 0, dz: -1 },
    { name: 'sul', yaw: 0, dx: 0, dz: 1 },
    { name: 'oeste', yaw: Math.PI / 2, dx: -1, dz: 0 },
    { name: 'leste', yaw: -Math.PI / 2, dx: 1, dz: 0 }
  ]

  return candidates.filter((candidate) => {
    const foot = base.offset(candidate.dx, 0, candidate.dz)
    const head = base.offset(candidate.dx, 1, candidate.dz)
    const below = base.offset(candidate.dx, -1, candidate.dz)
    return blockIsPassable(foot) && blockIsPassable(head) && blockIsStandable(below)
  })
}

function createNavigationController () {
  const state = {
    intent: null,
    lastSample: null,
    lastProgressAt: Date.now(),
    recoveryAttempts: 0,
    recovering: false,
    locomotionBroken: false,
    recentDamageUntil: 0,
    lastDamageAt: 0,
    lastStopReason: 'inicial',
    options: {
      allowParkour: true,
      allowScaffold: false,
      allowDig: false
    }
  }

  function clearPathfinder () {
    bot.pathfinder.stop()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  }

  function resetProgress () {
    state.lastSample = bot.entity?.position?.clone() || null
    state.lastProgressAt = Date.now()
  }

  function setIntent (intent) {
    state.intent = {
      ...intent,
      startedAt: Date.now()
    }
    state.recoveryAttempts = 0
    state.lastStopReason = 'navegando'
    resetProgress()
  }

  function stop (reason = 'parado') {
    clearPathfinder()
    state.intent = null
    state.lastSample = null
    state.recovering = false
    state.lastStopReason = reason
  }

  function reapplyCurrentGoal () {
    if (!state.intent) return false

    applyMovements()

    if (state.intent.type === 'follow') {
      const target = bot.players[state.intent.username]?.entity
      if (!target) return false
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      resetProgress()
      return true
    }

    if (state.intent.type === 'come_here') {
      const target = state.intent.target
      bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1))
      resetProgress()
      return true
    }

    if (state.intent.type === 'coords') {
      const target = state.intent.target
      bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z))
      resetProgress()
      return true
    }

    return false
  }

  function applyMovements () {
    resetPathfinderMovements(state.options)
  }

  function setOption (name, value) {
    if (!(name in state.options)) return false
    state.options[name] = value
    applyMovements()
    return true
  }

  function setMode (mode) {
    if (mode === 'seguro') {
      state.options.allowParkour = true
      state.options.allowScaffold = false
      state.options.allowDig = false
      applyMovements()
      return true
    }

    if (mode === 'blocos') {
      state.options.allowParkour = true
      state.options.allowScaffold = true
      state.options.allowDig = false
      applyMovements()
      return true
    }

    if (mode === 'avancado') {
      state.options.allowParkour = true
      state.options.allowScaffold = true
      state.options.allowDig = true
      applyMovements()
      return true
    }

    return false
  }

  function followPlayer (username) {
    const target = bot.players[username]?.entity
    if (!target) {
      bot.chat(`Nao encontrei ${username} por perto.`)
      return
    }

    applyMovements()
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    setIntent({ type: 'follow', username })
    bot.chat(`Seguindo ${username}.`)
  }

  function comeHere (username) {
    const target = bot.players[username]?.entity
    if (!target) {
      bot.chat(`Nao encontrei ${username} por perto.`)
      return
    }

    applyMovements()
    bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1))
    setIntent({ type: 'come_here', username, target: target.position.clone() })
    bot.chat('Indo ate voce.')
  }

  function goToCoords (coords) {
    applyMovements()
    bot.pathfinder.setGoal(new goals.GoalBlock(coords.x, coords.y, coords.z))
    setIntent({ type: 'coords', target: coords })
    bot.chat(`Indo para ${coords.x} ${coords.y} ${coords.z}.`)
  }

  async function escapeToFreeDirection () {
    const startPos = bot.entity.position.clone()
    const directions = getEscapeDirections()

    if (directions.length === 0) {
      await runUnstuckSequence()
      return horizontalDistance(bot.entity.position, startPos) > 0.35
    }

    for (const direction of directions) {
      await bot.look(direction.yaw, 0)
      await setTemporaryControls(['forward', 'jump'], 600)
      if (horizontalDistance(bot.entity.position, startPos) > 0.45) return true
    }

    return false
  }

  async function recover (manual = false) {
    if (state.recovering) return
    state.recovering = true
    state.recoveryAttempts += 1
    clearPathfinder()

    const escaped = await escapeToFreeDirection()

    bot.clearControlStates()
    state.recovering = false
    resetProgress()

    if (manual) {
      bot.chat(escaped ? 'Tentei sair usando espaco livre ao redor.' : 'Nao achei saida local.')
      return
    }

    if (state.recoveryAttempts >= 3) {
      stop('travado')
      bot.chat('Nao consegui me destravar. Preciso de ajuda ou novo comando.')
    } else if (escaped) {
      bot.chat('Detectei travamento e tentei liberar movimento.')
    } else {
      bot.chat('Nao consegui achar saida local.')
    }
  }

  function describe () {
    const intent = state.intent ? state.intent.type : 'nenhuma'
    const moving = bot.pathfinder.isMoving() ? 'sim' : 'nao'
    const recovering = state.recovering ? 'sim' : 'nao'
    const broken = state.locomotionBroken ? 'sim' : 'nao'
    const stuckFor = Math.round((Date.now() - state.lastProgressAt) / 1000)
    const parkour = state.options.allowParkour ? 'on' : 'off'
    const blocos = state.options.allowScaffold ? 'on' : 'off'
    const quebrar = state.options.allowDig ? 'on' : 'off'
    return `nav intent=${intent} moving=${moving} recovering=${recovering} quebrada=${broken} tentativas=${state.recoveryAttempts} sem_progresso=${stuckFor}s parkour=${parkour} blocos=${blocos} quebrar=${quebrar} ultimo=${state.lastStopReason}`
  }

  function followTargetIsClose () {
    if (state.intent?.type !== 'follow') return false
    const target = bot.players[state.intent.username]?.entity
    if (!target) return false
    return bot.entity.position.distanceTo(target.position) <= 3.2
  }

  function tick () {
    if (!bot.entity || !state.intent || state.recovering) return
    if (Date.now() < state.recentDamageUntil) return

    if (followTargetIsClose()) {
      resetProgress()
      return
    }

    const pos = bot.entity.position
    if (!state.lastSample) {
      resetProgress()
      return
    }

    if (horizontalDistance(pos, state.lastSample) > 0.7) {
      resetProgress()
      return
    }

    const noProgressFor = Date.now() - state.lastProgressAt
    if (noProgressFor > 5000) {
      recover(false).catch((err) => {
        state.recovering = false
        console.error('Erro ao recuperar navegacao:', err)
      })
    }
  }

  function handleDamage () {
    const now = Date.now()
    if (now - state.lastDamageAt < 500) return

    state.lastDamageAt = now
    state.recentDamageUntil = now + 2000
    state.locomotionBroken = true
    state.lastStopReason = 'dano'
    clearPathfinder()
    resetProgress()
    state.recovering = false

    bot.chat('Tomei dano. Vou reconectar para evitar desync de posicao.')
    reconnectBot('dano recebido')
  }

  function onGoalReached () {
    state.intent = null
    state.lastSample = null
    state.lastStopReason = 'chegou'
  }

  function resetAfterDeath (reason) {
    stop(reason)
    applyMovements()
  }

  return {
    followPlayer,
    comeHere,
    goToCoords,
    stop,
    recover,
    describe,
    setMode,
    setOption,
    tick,
    handleDamage,
    onGoalReached,
    resetAfterDeath,
    applyMovements
  }
}

function jumpOnce () {
  bot.setControlState('jump', true)
  setTimeout(() => bot.setControlState('jump', false), 500)
}

async function equipItemByName (itemName) {
  const item = findInventoryItem(itemName)
  if (!item) {
    bot.chat(`Nao tenho ${itemName}.`)
    return
  }

  if (item.ambiguous) {
    bot.chat(`Nome ambiguo. Opcoes: ${item.names.join(', ')}`)
    return
  }

  await bot.equip(item, 'hand')
  bot.chat(`Segurando ${item.name}.`)
}

async function dropItemByName (itemName, amountText) {
  const item = findInventoryItem(itemName)
  if (!item) {
    bot.chat(`Nao tenho ${itemName}.`)
    return
  }

  if (item.ambiguous) {
    bot.chat(`Nome ambiguo. Opcoes: ${item.names.join(', ')}`)
    return
  }

  if (amountText == null) {
    await bot.tossStack(item)
    bot.chat(`Dropei ${formatItem(item)}.`)
    return
  }

  const amount = parsePositiveInteger(amountText)
  if (!amount) {
    bot.chat('Use: drop ITEM QUANTIDADE')
    return
  }

  const total = findInventoryItems(item.name).reduce((sum, stack) => sum + stack.count, 0)
  const amountToDrop = Math.min(amount, total)

  await bot.toss(item.type, item.metadata, amountToDrop)
  bot.chat(`Dropei ${amountToDrop}x ${item.name}.`)
}

async function moveItemToHotbar (slotText, itemName) {
  const slotNumber = parsePositiveInteger(slotText)
  if (!slotNumber || slotNumber < 1 || slotNumber > 9) {
    bot.chat('Use slot de 1 a 9.')
    return
  }

  const item = findInventoryItem(itemName)
  if (!item) {
    bot.chat(`Nao tenho ${itemName}.`)
    return
  }

  if (item.ambiguous) {
    bot.chat(`Nome ambiguo. Opcoes: ${item.names.join(', ')}`)
    return
  }

  const destSlot = hotbarSlotToInventorySlot(slotNumber)
  if (item.slot === destSlot) {
    bot.chat(`${item.name} ja esta no slot ${slotNumber}.`)
    return
  }

  await bot.moveSlotItem(item.slot, destSlot)
  bot.chat(`Coloquei ${item.name} na hotbar ${slotNumber}.`)
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
    const adjacent = bot.blockAt(block.position.plus(face.offset))
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
    const block = bot.blockAt(point)
    if (!block || block.boundingBox !== 'block') continue
    if (allowedKeys.has(blockKey(block.position))) continue
    return false
  }

  return true
}

function hasClearLineToFace (block, face) {
  return clearLineBetween(bot.entity.position.offset(0, 1.6, 0), face.facePoint, [block])
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
        distance: bot.entity.position.distanceTo(feet)
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
    interactableNow: visibleFaces.length > 0 && bot.canDigBlock(block),
    hasSafeSpot: spots.length > 0
  }
}

function preferredEntryBlockForHiddenTarget (targetBlock) {
  const candidates = adjacentPositions(targetBlock.position)
    .map(position => bot.blockAt(position))
    .filter(block => block && block.boundingBox === 'block' && block.diggable)
    .filter(block => !liquidBlocks.has(block.name) && !hazardBlocks.has(block.name))
    .map(block => blockInteractionInfo(block))
    .filter(info => info.visible || info.hasSafeSpot)
    .filter(info => hasClearLineToBlockCenter(info.block, targetBlock))
    .sort((a, b) => {
      const scoreA = (a.visible ? 30 : 0) + (a.hasSafeSpot ? 20 : 0) - bot.entity.position.distanceTo(a.block.position)
      const scoreB = (b.visible ? 30 : 0) + (b.hasSafeSpot ? 20 : 0) - bot.entity.position.distanceTo(b.block.position)
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

  score -= bot.entity.position.distanceTo(miningInfo.block.position) * 3
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
  const tools = bot.inventory.items()
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
  if (bot.heldItem?.name !== choice.item.name) {
    await bot.equip(choice.item, 'hand')
  }

  return { ok: true, tool: choice.item.name }
}

function adjacentPositions (position) {
  return [
    position.offset(1, 0, 0), position.offset(-1, 0, 0),
    position.offset(0, 1, 0), position.offset(0, -1, 0),
    position.offset(0, 0, 1), position.offset(0, 0, -1)
  ]
}

function targetTouchesLava (block) {
  return adjacentPositions(block.position)
    .some(position => bot.blockAt(position)?.name === 'lava')
}

function findImmediateCollectionRisk (targetBlock = null, options = {}) {
  if (reconnecting) return 'o bot esta reconectando'
  if (bot.health <= 8) return `vida baixa (${bot.health}/20)`
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
  return Object.values(bot.entities)
    .filter(entity => isDroppedItemEntity(entity) && entity.position)
    .filter(entity => droppedItemMatchesTarget(entity, target))
    .filter(entity => entity.position.distanceTo(origin) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
}

async function moveOntoDrop (drop) {
  const target = drop.position.floored()

  await withTimeout(
    bot.pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z)),
    5000,
    `ir ate drop ${describeDroppedItemEntity(drop)}`
  ).catch(() => {})

  if (drop.isValid === false || !drop.position) return
  if (bot.entity.position.distanceTo(drop.position) <= 2.2) {
    await bot.lookAt(drop.position.offset(0, 0.2, 0), true).catch(() => {})
    await setTemporaryControls(['forward'], 450)
    bot.clearControlStates()
  }
}

async function collectDropsAround (origin = bot.entity.position.clone(), options = {}) {
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

  while (!reconnecting && Date.now() < deadline && visited < maxDrops) {
    gains = diffInventorySnapshots(before, inventorySnapshot())
    if (stopOnGain && gains.length > 0) break

    const drop = nearestDroppedItem(origin, radius, target)
    if (!drop) {
      await wait(100)
      continue
    }

    const item = getDroppedItemFromEntity(drop)
    const risk = findImmediateCollectionRisk(null, { itemNames: item?.name ? [item.name] : [] })
    if (risk) {
      if (announce) bot.chat(`Busca de drops interrompida: ${risk}.`)
      break
    }

    visited += 1
    await moveOntoDrop(drop)
    await wait(100)
  }

  gains = diffInventorySnapshots(before, inventorySnapshot())
  if (gains.length > 0) {
    recordCollection('drops proximos', gains)
    if (announce) bot.chat(`Drops coletados: ${formatItemList(gains)}.`)
  } else if (announce) {
    bot.chat('Nao coletei nenhum drop novo.')
  }

  return gains
}

async function runAutoDropCollection () {
  if (!collectionState.autoDrops || collectionState.autoDropsBusy || activeSkill || reconnecting || !bot.entity) return
  if (bot.pathfinder.isMoving()) return

  const drop = nearestDroppedItem(bot.entity.position, 6)
  if (!drop) return
  const item = getDroppedItemFromEntity(drop)
  if (findImmediateCollectionRisk(null, { itemNames: item?.name ? [item.name] : [] })) return

  collectionState.autoDropsBusy = true
  try {
    await collectDropsAround(bot.entity.position.clone(), {
      radius: 6,
      durationMs: 3500,
      maxDrops: 4,
      announce: false
    })
  } catch (err) {
    console.error('Erro na busca automatica de drops:', err)
  } finally {
    bot.pathfinder.stop()
    bot.clearControlStates()
    collectionState.autoDropsBusy = false
  }
}

function startSkill (name) {
  if (activeSkill) return null
  activeSkill = { name, cancelled: false }
  return activeSkill
}

function cancelActiveSkill () {
  if (!activeSkill) return false
  activeSkill.cancelled = true
  return true
}

function assertSkillActive (skill) {
  if (!skill || activeSkill !== skill) throw new Error('skill interrompida')
  if (skill.cancelled) throw new Error('skill cancelada')
}

function finishSkill (skill) {
  if (activeSkill === skill) activeSkill = null
}

function setupSkillRegistry () {
  const registry = createSkillRegistry()

  registry.register({
    id: 'movement.follow_owner',
    description: 'Segue o jogador dono.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      navigationController.followPlayer(config.owner)
      return actionOk('movement.follow_owner', 'seguindo dono')
    }
  })

  registry.register({
    id: 'movement.come_here',
    description: 'Vai ate o jogador dono.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      navigationController.comeHere(config.owner)
      return actionOk('movement.come_here', 'indo ate o dono')
    }
  })

  registry.register({
    id: 'movement.go_to',
    description: 'Vai ate coordenadas X Y Z.',
    risk: 'medium',
    timeoutMs: 30000,
    inputSchema: { x: 'number', y: 'number', z: 'number' },
    run: ({ x, y, z }) => {
      if ([x, y, z].some(value => typeof value !== 'number')) return actionFail('movement.go_to', 'coordenadas invalidas')
      navigationController.goToCoords({ x, y, z })
      return actionOk('movement.go_to', `indo para ${x} ${y} ${z}`, { x, y, z })
    }
  })

  registry.register({
    id: 'movement.stop',
    description: 'Para movimento e cancela skill atual.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      const cancelled = cancelActiveSkill()
      navigationController.stop('skill registry stop')
      bot.pathfinder.stop()
      bot.clearControlStates()
      return actionOk('movement.stop', cancelled ? 'skill cancelada e movimento parado' : 'movimento parado', { cancelled })
    }
  })

  registry.register({
    id: 'inventory.equip',
    description: 'Segura um item do inventario na mao.',
    risk: 'low',
    timeoutMs: 5000,
    inputSchema: { item: 'string' },
    run: async ({ item }) => {
      if (!item) return actionFail('inventory.equip', 'item ausente')
      await equipItemByName(item)
      return actionOk('inventory.equip', `equipado ${item}`, { item })
    }
  })

  registry.register({
    id: 'inventory.drop',
    description: 'Dropa item do inventario.',
    risk: 'medium',
    timeoutMs: 5000,
    inputSchema: { item: 'string', amount: 'number optional' },
    run: async ({ item, amount = null }) => {
      if (!item) return actionFail('inventory.drop', 'item ausente')
      await dropItemByName(item, amount == null ? null : String(amount))
      return actionOk('inventory.drop', `drop executado para ${item}`, { item, amount })
    }
  })

  registry.register({
    id: 'inventory.hotbar',
    description: 'Move item para slot da hotbar.',
    risk: 'low',
    timeoutMs: 5000,
    inputSchema: { slot: 'number 1-9', item: 'string' },
    run: async ({ slot, item }) => {
      if (!slot || !item) return actionFail('inventory.hotbar', 'slot ou item ausente')
      await moveItemToHotbar(String(slot), item)
      return actionOk('inventory.hotbar', `hotbar ${slot} ${item}`, { slot, item })
    }
  })

  registry.register({
    id: 'collection.collect',
    description: 'Coleta/minera um bloco alvo percebido.',
    risk: 'medium',
    timeoutMs: 60000,
    inputSchema: { target: 'string', count: 'number optional max 10' },
    run: async ({ target, count = 1 }) => {
      if (!target) return actionFail('collection.collect', 'alvo ausente')
      if (count > 1) {
        await collectMultipleBlocksByTarget(target, count)
      } else {
        await collectBlockByTarget(target)
      }
      return actionOk('collection.collect', `coleta solicitada: ${count}x ${target}`, { target, count })
    }
  })

  registry.register({
    id: 'drops.collect',
    description: 'Coleta drops proximos, opcionalmente por alvo.',
    risk: 'low',
    timeoutMs: 8000,
    inputSchema: { target: 'string optional' },
    run: async ({ target = null }) => {
      const itemTarget = target ? normalizeItemTarget(target, 'dropped') : null
      const gains = await collectDropsAround(bot.entity.position.clone(), {
        radius: 8,
        durationMs: 6000,
        maxDrops: 8,
        announce: false,
        target: itemTarget
      })
      return actionOk('drops.collect', 'drops coletados', { gains })
    }
  })

  registry.register({
    id: 'crafting.craft',
    description: 'Crafta item se houver receita, materiais e crafting table quando necessaria.',
    risk: 'medium',
    timeoutMs: 20000,
    inputSchema: { target: 'string', count: 'number optional' },
    run: async ({ target, count = 1 }) => {
      if (!target) return actionFail('crafting.craft', 'alvo ausente')
      return craftingHelpers.craftByQuery(target, count)
    }
  })

  registry.register({
    id: 'crafting.recipe',
    description: 'Descreve receita e faltas para um item.',
    risk: 'low',
    timeoutMs: 1000,
    inputSchema: { target: 'string' },
    run: ({ target }) => {
      if (!target) return actionFail('crafting.recipe', 'alvo ausente')
      return actionOk('crafting.recipe', craftingHelpers.describeRecipeByQuery(target))
    }
  })

  registry.register({
    id: 'survival.status',
    description: 'Consulta estado de sobrevivencia.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => actionOk('survival.status', survivalGuard.describeStatus(), survivalGuard.assess())
  })

  registry.register({
    id: 'survival.set_enabled',
    description: 'Liga/desliga survival guard.',
    risk: 'low',
    timeoutMs: 1000,
    inputSchema: { enabled: 'boolean' },
    run: ({ enabled }) => {
      survivalGuard.setEnabled(Boolean(enabled))
      return actionOk('survival.set_enabled', `survival ${enabled ? 'on' : 'off'}`, { enabled: Boolean(enabled) })
    }
  })

  registry.register({
    id: 'state.snapshot',
    description: 'Retorna resumo estruturado do estado atual.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => actionOk('state.snapshot', 'estado atual', stateReporter.getStateSnapshot())
  })

  return registry
}

skillRegistry = setupSkillRegistry()

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
    bot.chat(`Coletando ${plan}; escolhido por ${token.category} score=${token.score}.`)
  }

  const firstSpot = firstChoice.info.spots[0]
  const goal = firstSpot
    ? new goals.GoalBlock(firstSpot.position.x, firstSpot.position.y, firstSpot.position.z)
    : new goals.GoalNear(firstBlock.position.x, firstBlock.position.y, firstBlock.position.z, 3)

  await withTimeout(
    bot.pathfinder.goto(goal),
    15000,
    'aproximacao do bloco'
  )

  assertSkillActive(skill)
  if (reconnecting) throw new Error('bot reconectou durante a coleta')

  const refreshedChoice = chooseBlockFromToken(token, selection.target, true)
  if (!refreshedChoice) {
    throw new Error('nenhum bloco exposto/interagivel ficou disponivel')
  }

  const reachableBlock = refreshedChoice.block
  const refreshedInfo = blockInteractionInfo(reachableBlock)
  if (!refreshedInfo.visible && !refreshedInfo.interactableNow) {
    throw new Error(`${reachableBlock.name} nao tem linha livre ate uma face exposta`)
  }

  if (!bot.canDigBlock(reachableBlock)) {
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

  await withTimeout(bot.dig(reachableBlock), 10000, `minerar ${reachableBlock.name}`)
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
  if (activeSkill) {
    bot.chat(`Ja estou executando ${activeSkill.name}. Use parar se precisar interromper.`)
    return
  }

  const skill = startSkill('coletar')
  navigationController.stop('skill coletar')

  try {
    const result = await collectOneBlockByTarget(targetQuery, skill)
    if (result.gains.length > 0) {
      bot.chat(`Coleta concluida: quebrei ${result.blockName} com ${result.tool} e peguei ${formatItemList(result.gains)}.`)
    } else {
      bot.chat(`Quebrei ${result.blockName} com ${result.tool}, mas nao detectei item novo no inventario.`)
    }
  } catch (err) {
    bot.chat(`Falha ao coletar: ${err.message}`)
  } finally {
    bot.pathfinder.stop()
    bot.clearControlStates()
    finishSkill(skill)
  }
}

async function collectMultipleBlocksByTarget (targetQuery, requestedCount) {
  if (activeSkill) {
    bot.chat(`Ja estou executando ${activeSkill.name}. Use parar se precisar interromper.`)
    return
  }

  const count = Math.min(requestedCount, MAX_COLLECT_SEQUENCE)
  const skill = startSkill('coletar')
  const startedAt = Date.now()
  const totalGains = new Map()
  let successes = 0
  let attempts = 0
  let stopReason = null

  navigationController.stop('skill coletar sequencia')
  bot.chat(`Coletando ate ${count}x ${targetQuery}.`)

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
        bot.chat(`Coleta ${index}/${count}: quebrei ${result.blockName}; ${gained}.`)
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
    bot.chat(`Coleta finalizada: tentativas=${attempts} sucessos=${successes}/${count} itens=${gainedText}${reasonText}`)
  } finally {
    bot.pathfinder.stop()
    bot.clearControlStates()
    finishSkill(skill)
  }
}

async function handleCommand (username, message) {
  const text = message.trim().toLowerCase()

  if (text === 'seguir') {
    navigationController.followPlayer(username)
    return
  }

  if (text === 'vir aqui') {
    navigationController.comeHere(username)
    return
  }

  if (text === 'parar') {
    const cancelledSkill = cancelActiveSkill()
    navigationController.stop('comando parar')
    bot.pathfinder.stop()
    bot.clearControlStates()
    bot.chat(cancelledSkill ? 'Parando e cancelando skill atual.' : 'Parando.')
    return
  }

  if (text === 'destravar') {
    await navigationController.recover(true)
    return
  }

  if (text === 'navstatus') {
    bot.chat(navigationController.describe())
    return
  }

  if (text === 'reconectar') {
    bot.chat('Reconectando.')
    reconnectBot('comando reconectar')
    return
  }

  if (text.startsWith('nav modo ')) {
    const mode = text.slice(9).trim()
    if (!navigationController.setMode(mode)) {
      bot.chat('Use: nav modo seguro, nav modo blocos ou nav modo avancado')
      return
    }

    bot.chat(`Modo de navegacao: ${mode}.`)
    return
  }

  if (text === 'nav blocos on' || text === 'nav blocos off') {
    const enabled = text.endsWith('on')
    navigationController.setOption('allowScaffold', enabled)
    bot.chat(`Navegacao com blocos: ${enabled ? 'ligada' : 'desligada'}.`)
    return
  }

  if (text === 'nav quebrar on' || text === 'nav quebrar off') {
    const enabled = text.endsWith('on')
    navigationController.setOption('allowDig', enabled)
    bot.chat(`Quebrar blocos na navegacao: ${enabled ? 'ligado' : 'desligado'}.`)
    return
  }

  if (text === 'nav parkour on' || text === 'nav parkour off') {
    const enabled = text.endsWith('on')
    navigationController.setOption('allowParkour', enabled)
    bot.chat(`Parkour na navegacao: ${enabled ? 'ligado' : 'desligado'}.`)
    return
  }

  if (text === 'pular') {
    jumpOnce()
    bot.chat('Pulando.')
    return
  }

  if (text === 'onde voce esta') {
    const pos = bot.entity.position
    bot.chat(`Estou em ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}.`)
    return
  }

  if (text === 'status') {
    sendLongMessage(describeStatus())
    return
  }

  if (text === 'estado') {
    sendLongMessage(stateReporter.describeForChat())
    return
  }

  if (text === 'planner estado') {
    sendLongMessage(stateReporter.describeForPlanner())
    return
  }

  if (text === 'skills') {
    sendLongMessage(skillRegistry.describe())
    return
  }

  if (text === 'scan') {
    sendLongMessage(describeScan())
    return
  }

  if (text === 'percepcao') {
    refreshPerceptionCache(true)
    bot.chat(describePerceptionCache())
    return
  }

  if (text === 'atencao') {
    sendLongMessage(describeAttention())
    return
  }

  if (text === 'perigos') {
    sendLongMessage(describeHazards())
    return
  }

  if (text === 'recursos') {
    sendLongMessage(describeResources())
    return
  }

  if (text === 'entidades') {
    sendLongMessage(describeEntities())
    return
  }

  if (text === 'arredores') {
    bot.chat(describeSurroundings())
    return
  }

  if (text.startsWith('resolver ')) {
    sendLongMessage(describeCatalogResolution(text.slice(9)))
    return
  }

  if (text === 'objetivo') {
    bot.chat(`Objetivo perceptivo atual: ${perceptionState.objective}.`)
    return
  }

  if (text.startsWith('objetivo ')) {
    const objective = normalizeItemName(text.slice(9))
    if (!objectiveWeights[objective]) {
      bot.chat(`Objetivo invalido. Use: ${Object.keys(objectiveWeights).join(', ')}`)
      return
    }

    perceptionState.objective = objective
    bot.chat(`Objetivo perceptivo definido: ${objective}.`)
    return
  }

  if (text === 'survival' || text === 'survival status') {
    sendLongMessage(survivalGuard.describeStatus())
    return
  }

  if (text === 'survival debug') {
    sendLongMessage(survivalGuard.describeDebug())
    return
  }

  if (text === 'survival pedir') {
    const asked = survivalGuard.askForHelp()
    bot.chat(asked ? 'Pedido de ajuda enviado.' : 'Pedido recente; aguardando cooldown.')
    return
  }

  if (text === 'survival on' || text === 'survival off') {
    const enabled = text.endsWith('on')
    survivalGuard.setEnabled(enabled)
    bot.chat(`Survival guard: ${enabled ? 'ligado' : 'desligado'}.`)
    return
  }

  if (text === 'inventario') {
    const inventory = summarizeInventory()
    sendLongMessage(inventory.length === 0 ? 'Inventario vazio.' : `Inventario: ${inventory.join(', ')}`)
    return
  }

  if (text === 'coletas') {
    sendLongMessage(describeRecentCollections())
    return
  }

  if (text === 'crafting status') {
    sendLongMessage(craftingHelpers.describeStatus())
    return
  }

  if (text.startsWith('receita ')) {
    sendLongMessage(craftingHelpers.describeRecipeByQuery(text.slice(8).trim()))
    return
  }

  if (text.startsWith('craft ')) {
    const craftText = text.slice(6).trim()
    const parts = craftText.split(/\s+/)
    const requestedCount = parsePositiveInteger(parts[0])
    const target = requestedCount ? parts.slice(1).join(' ') : craftText
    if (!target) {
      bot.chat('Use: craft ITEM ou craft QUANTIDADE ITEM')
      return
    }

    const result = await craftingHelpers.craftByQuery(target, requestedCount || 1)
    bot.chat(result.ok ? result.message : `Falha ao craftar: ${result.reason}`)
    return
  }

  if (text === 'drops') {
    bot.chat(`Busca automatica de drops: ${collectionState.autoDrops ? 'ligada' : 'desligada'}.`)
    return
  }

  if (text === 'drops on' || text === 'drops off') {
    collectionState.autoDrops = text.endsWith('on')
    bot.chat(`Busca automatica de drops: ${collectionState.autoDrops ? 'ligada' : 'desligada'}.`)
    return
  }

  if (text === 'pegar drops') {
    const skill = startSkill('pegar_drops')
    if (!skill) {
      bot.chat(`Ja estou executando ${activeSkill.name}. Use parar para cancelar.`)
      return
    }

    navigationController.stop('skill pegar drops')
    try {
      await collectDropsAround(bot.entity.position.clone(), {
        radius: 8,
        durationMs: 6000,
        maxDrops: 8,
        announce: true
      })
    } finally {
      bot.pathfinder.stop()
      bot.clearControlStates()
      finishSkill(skill)
    }
    return
  }

  if (text.startsWith('pegar ')) {
    const targetText = text.slice(6).trim()
    if (!targetText) {
      bot.chat('Use: pegar ALVO ou pegar drops')
      return
    }

    const target = normalizeItemTarget(targetText, 'dropped')
    const skill = startSkill('pegar_drops')
    if (!skill) {
      bot.chat(`Ja estou executando ${activeSkill.name}. Use parar para cancelar.`)
      return
    }

    navigationController.stop('skill pegar drops')
    try {
      await collectDropsAround(bot.entity.position.clone(), {
        radius: 8,
        durationMs: 6000,
        maxDrops: 8,
        announce: true,
        target
      })
    } finally {
      bot.pathfinder.stop()
      bot.clearControlStates()
      finishSkill(skill)
    }
    return
  }

  if (text === 'hotbar') {
    sendLongMessage(`Hotbar: ${describeHotbar()}`)
    return
  }

  if (text === 'mao') {
    bot.chat(bot.heldItem ? `Mao: ${formatItem(bot.heldItem)}` : 'Mao vazia.')
    return
  }

  if (text.startsWith('ir ')) {
    const coords = parseCoords(text.slice(3).split(/\s+/))
    if (!coords) {
      bot.chat('Use: ir X Y Z')
      return
    }

    navigationController.goToCoords(coords)
    return
  }

  if (text.startsWith('segure ')) {
    await equipItemByName(text.slice(7))
    return
  }

  if (text.startsWith('drop ')) {
    const parts = text.slice(5).split(/\s+/)
    const maybeAmount = parts.length > 1 ? parts[parts.length - 1] : null
    const amount = maybeAmount ? parsePositiveInteger(maybeAmount) : null
    const itemName = amount ? parts.slice(0, -1).join(' ') : parts.join(' ')

    await dropItemByName(itemName, amount ? String(amount) : null)
    return
  }

  if (text.startsWith('coletar ')) {
    const collectText = text.slice(8).trim()
    const parts = collectText.split(/\s+/)
    const requestedCount = parsePositiveInteger(parts[0])
    const target = requestedCount ? parts.slice(1).join(' ') : collectText
    if (!target) {
      bot.chat('Use: coletar ALVO ou coletar QUANTIDADE ALVO')
      return
    }

    if (requestedCount) {
      if (requestedCount > MAX_COLLECT_SEQUENCE) {
        bot.chat(`Limite atual: ${MAX_COLLECT_SEQUENCE} blocos por comando.`)
      }
      await collectMultipleBlocksByTarget(target, requestedCount)
    } else {
      await collectBlockByTarget(target)
    }
    return
  }

  if (text.startsWith('hotbar ')) {
    const parts = text.slice(7).split(/\s+/)
    if (parts.length < 2) {
      bot.chat('Use: hotbar SLOT ITEM')
      return
    }

    await moveItemToHotbar(parts[0], parts.slice(1).join(' '))
    return
  }

  if (text === 'ajuda') {
    bot.chat('Movimento: seguir, vir aqui, parar, destravar, reconectar, navstatus, nav modo seguro|blocos|avancado, ir X Y Z')
    bot.chat('Percepcao: scan, atencao, perigos, recursos, entidades, arredores, percepcao, resolver ALVO, objetivo [NOME]')
    bot.chat('Planejamento: estado, planner estado, skills')
    bot.chat('Sobrevivencia: survival, survival status, survival on|off, survival pedir, survival debug (come automaticamente)')
    bot.chat('Inventario: status, inventario, hotbar, mao, segure ITEM, drop ITEM [QTD], hotbar SLOT ITEM, coletas')
    bot.chat('Crafting: receita ITEM, crafting status, craft ITEM, craft N ITEM')
    bot.chat('Coleta: coletar ALVO, coletar N ALVO, pegar ALVO, pegar drops, drops on|off. Exemplos: coletar 5 stone, pegar pao')
  }
}

function reconnectBot (reason) {
  if (reconnecting) return
  reconnecting = true
  console.log(`Reconectando bot: ${reason}`)

  const oldBot = bot
  navigationController?.stop(`reconectando: ${reason}`)

  setTimeout(() => {
    createBotInstance()
    reconnecting = false
  }, 1500)

  if (oldBot) {
    oldBot.end()
  }
}

function registerBotEvents () {
  bot.once('spawn', () => {
    defaultMovements = new Movements(bot)
    navigationController = createNavigationController()
    navigationController.applyMovements()
    previousHealth = bot.health ?? previousHealth
    refreshPerceptionCache(true)
    bot.chat('Online. Digite ajuda no chat.')
    console.log('Bot entrou no mundo com sucesso.')
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (!ownerMatches(username)) return

    console.log(`[chat] ${username}: ${message}`)
    handleCommand(username, message).catch((err) => {
      console.error('Erro ao executar comando:', err)
      bot.chat(`Erro no comando: ${err.message}`)
    })
  })

  bot.on('goal_reached', () => {
    if (activeSkill || collectionState.autoDropsBusy) return
    navigationController?.onGoalReached()
    bot.chat('Cheguei.')
  })

  bot.on('health', () => {
    if (previousHealth != null && bot.health < previousHealth) {
      navigationController?.handleDamage()
    }

    previousHealth = bot.health
  })

  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      navigationController?.handleDamage()
    }
  })

  bot.on('death', () => {
    navigationController?.resetAfterDeath('morreu')
    console.log('Bot morreu. Movimento resetado.')
  })

  bot.on('respawn', () => {
    navigationController?.resetAfterDeath('renasceu')
    previousHealth = null
    console.log('Bot renasceu. Movimento resetado.')
  })

  bot.on('forcedMove', () => {
    console.log('Servidor corrigiu a posicao do bot.')
  })

  bot.on('path_reset', (reason) => {
    console.log('Pathfinder resetou caminho:', reason)
  })

  bot.on('kicked', (reason) => {
    console.error('Bot foi expulso do servidor:', reason)
  })

  bot.on('error', (err) => {
    console.error('Erro no bot:', err)
  })

  bot.on('end', () => {
    console.log('Conexao encerrada.')
  })
}

function createBotInstance () {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    version: config.version,
    username: config.username,
    auth: config.auth
  })

  bot.loadPlugin(pathfinder)
  defaultMovements = null
  navigationController = null
  previousHealth = null
  registerBotEvents()
}

setInterval(() => {
  if (!navigationController) return
  refreshPerceptionCache(false)
  navigationController.tick()
  survivalGuard.tick()
  runAutoDropCollection()
}, 1000)

createBotInstance()
