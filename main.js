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
const { createPlacementHelpers } = require('./placement')
const { createContainerHelpers } = require('./containers')
const { createNavigationSystem } = require('./navigation')
const { createCollectionSystem } = require('./collection')
const { createCommandSystem } = require('./commands')
const { createBotRuntime } = require('./bot-runtime')
const {
  parseCoords,
  createChatHelpers,
  wait,
  withTimeout,
  parsePositiveInteger,
  ownerMatchesFactory
} = require('./utils')

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

function createSkillState (context) {
  function startSkill (name) {
    if (context.activeSkill) return null
    context.activeSkill = { name, cancelled: false }
    return context.activeSkill
  }

  function cancelActiveSkill () {
    if (!context.activeSkill) return false
    context.activeSkill.cancelled = true
    return true
  }

  function assertSkillActive (skill) {
    if (!skill || context.activeSkill !== skill) throw new Error('skill interrompida')
    if (skill.cancelled) throw new Error('skill cancelada')
  }

  function finishSkill (skill) {
    if (context.activeSkill === skill) context.activeSkill = null
  }

  return {
    startSkill,
    cancelActiveSkill,
    assertSkillActive,
    finishSkill
  }
}

function setupSkillRegistry ({
  context,
  config,
  commandSystem,
  collection,
  inventory,
  craftingHelpers,
  placementHelpers,
  containerHelpers,
  survivalGuard,
  stateReporter
}) {
  const registry = createSkillRegistry()

  registry.register({
    id: 'movement.follow_owner',
    description: 'Segue o jogador dono.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      context.navigationController.followPlayer(config.owner)
      return actionOk('movement.follow_owner', 'seguindo dono')
    }
  })

  registry.register({
    id: 'movement.come_here',
    description: 'Vai ate o jogador dono.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      context.navigationController.comeHere(config.owner)
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
      context.navigationController.goToCoords({ x, y, z })
      return actionOk('movement.go_to', `indo para ${x} ${y} ${z}`, { x, y, z })
    }
  })

  registry.register({
    id: 'movement.stop',
    description: 'Para movimento e cancela skill atual.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      const cancelled = context.cancelActiveSkill()
      context.navigationController.stop('skill registry stop')
      context.bot.pathfinder.stop()
      context.bot.clearControlStates()
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
      await commandSystem.equipItemByName(item)
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
      await commandSystem.dropItemByName(item, amount == null ? null : String(amount))
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
      await commandSystem.moveItemToHotbar(String(slot), item)
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
        await collection.collectMultipleBlocksByTarget(target, count)
      } else {
        await collection.collectBlockByTarget(target)
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
      const itemTarget = target ? inventory.normalizeItemTarget(target, 'dropped') : null
      const gains = await collection.collectDropsAround(context.bot.entity.position.clone(), {
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
    id: 'blocks.place',
    description: 'Coloca um bloco do inventario em uma posicao simples e segura.',
    risk: 'medium',
    timeoutMs: 18000,
    inputSchema: { target: 'string', mode: 'front|below|near_owner|coords', coords: 'object optional' },
    run: async ({ target = 'bloco', mode = 'front', coords = null }) => {
      return placementHelpers.placeByRequest({ target, mode, coords, raw: target })
    }
  })

  registry.register({
    id: 'containers.scan',
    description: 'Procura, abre e memoriza containers proximos.',
    risk: 'medium',
    timeoutMs: 60000,
    run: () => containerHelpers.scanAndInspectContainers()
  })

  registry.register({
    id: 'containers.search',
    description: 'Procura item na memoria e em containers proximos.',
    risk: 'low',
    timeoutMs: 60000,
    inputSchema: { target: 'string' },
    run: ({ target }) => {
      if (!target) return actionFail('containers.search', 'alvo ausente')
      return containerHelpers.searchItemByQuery(target)
    }
  })

  registry.register({
    id: 'containers.withdraw',
    description: 'Retira item de containers proximos.',
    risk: 'medium',
    timeoutMs: 60000,
    inputSchema: { target: 'string', count: 'number optional' },
    run: ({ target, count = 1 }) => {
      if (!target) return actionFail('containers.withdraw', 'alvo ausente')
      return containerHelpers.withdrawItemByQuery(target, count)
    }
  })

  registry.register({
    id: 'containers.deposit',
    description: 'Guarda item, blocos, recursos, drops ou tudo em containers proximos.',
    risk: 'medium',
    timeoutMs: 60000,
    inputSchema: { mode: 'target|all|resources|blocks|drops', target: 'string optional', count: 'number optional' },
    run: ({ mode = 'target', target = null, count = null }) => containerHelpers.depositByRequest({ mode, target, count })
  })

  registry.register({
    id: 'containers.clear_memory',
    description: 'Esquece memoria de containers.',
    risk: 'low',
    timeoutMs: 1000,
    run: () => {
      const count = containerHelpers.clearMemory()
      return actionOk('containers.clear_memory', `esqueci ${count} container(s)`)
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

function start () {
  const config = loadConfig()
  const mcData = minecraftData(config.version)
  const minecraftCatalog = createMinecraftCatalog(mcData)
  const ownerMatches = ownerMatchesFactory(config.owner)
  const context = {
    bot: null,
    defaultMovements: null,
    navigationController: null,
    previousHealth: null,
    reconnecting: false,
    activeSkill: null,
    skillRegistry: null,
    stateReporter: null,
    craftingHelpers: null,
    placementHelpers: null,
    containerHelpers: null,
    collection: null,
    reconnectBot: null,
    startSkill: null,
    cancelActiveSkill: null,
    assertSkillActive: null,
    finishSkill: null
  }

  Object.assign(context, createSkillState(context))

  let collection = null

  const inventoryHelpers = createInventoryHelpers({
    getBot: () => context.bot,
    mcData,
    catalog: minecraftCatalog,
    toolTier: itemName => collection?.toolTier(itemName) || 0
  })

  let runtime = null
  const navigation = createNavigationSystem({
    context,
    goals,
    reconnectBot: reason => runtime.reconnectBot(reason)
  })

  const perceptionHelpers = createPerceptionHelpers({
    getBot: () => context.bot,
    Vec3,
    catalog: minecraftCatalog,
    getDroppedItemFromEntity: entity => collection?.getDroppedItemFromEntity(entity),
    isDroppedItemEntity: entity => Boolean(collection?.isDroppedItemEntity(entity)),
    describeDroppedItemEntity: entity => collection?.describeDroppedItemEntity(entity) || 'item',
    ownerMatches,
    getEscapeDirections: () => navigation.getEscapeDirections(),
    getContainerMemory: () => context.containerHelpers
  })

  const survivalGuard = createSurvivalGuard({
    getBot: () => context.bot,
    Vec3,
    owner: config.owner,
    perception: perceptionHelpers,
    inventory: inventoryHelpers,
    getNavigationController: () => context.navigationController,
    getActiveSkill: () => context.activeSkill,
    cancelActiveSkill: context.cancelActiveSkill,
    getReconnecting: () => context.reconnecting
  })

  collection = createCollectionSystem({
    context,
    Vec3,
    goals,
    perception: perceptionHelpers,
    inventory: inventoryHelpers,
    navigation,
    wait,
    withTimeout,
    startSkill: context.startSkill,
    finishSkill: context.finishSkill,
    assertSkillActive: context.assertSkillActive
  })
  context.collection = collection

  const craftingHelpers = createCraftingHelpers({
    getBot: () => context.bot,
    mcData,
    catalog: minecraftCatalog,
    inventory: inventoryHelpers,
    goals,
    withTimeout,
    owner: config.owner,
    getActiveSkill: () => context.activeSkill,
    startSkill: context.startSkill,
    finishSkill: context.finishSkill,
    assertSkillActive: context.assertSkillActive,
    getNavigationController: () => context.navigationController,
    getReconnecting: () => context.reconnecting,
    survival: survivalGuard
  })
  context.craftingHelpers = craftingHelpers

  const placementHelpers = createPlacementHelpers({
    getBot: () => context.bot,
    Vec3,
    catalog: minecraftCatalog,
    inventory: inventoryHelpers,
    goals,
    withTimeout,
    owner: config.owner,
    getActiveSkill: () => context.activeSkill,
    startSkill: context.startSkill,
    finishSkill: context.finishSkill,
    assertSkillActive: context.assertSkillActive,
    getNavigationController: () => context.navigationController,
    getReconnecting: () => context.reconnecting,
    survival: survivalGuard
  })
  context.placementHelpers = placementHelpers

  const containerHelpers = createContainerHelpers({
    getBot: () => context.bot,
    Vec3,
    catalog: minecraftCatalog,
    inventory: inventoryHelpers,
    perception: perceptionHelpers,
    goals,
    withTimeout,
    owner: config.owner,
    getActiveSkill: () => context.activeSkill,
    startSkill: context.startSkill,
    finishSkill: context.finishSkill,
    assertSkillActive: context.assertSkillActive,
    getNavigationController: () => context.navigationController,
    getReconnecting: () => context.reconnecting,
    survival: survivalGuard
  })
  context.containerHelpers = containerHelpers

  const stateReporter = createStateReporter({
    getBot: () => context.bot,
    config,
    inventory: inventoryHelpers,
    perception: perceptionHelpers,
    survival: survivalGuard,
    collectionState: collection.collectionState,
    getActiveSkill: () => context.activeSkill,
    getNavigationController: () => context.navigationController,
    getReconnecting: () => context.reconnecting,
    getContainers: () => context.containerHelpers
  })
  context.stateReporter = stateReporter

  const { sendLongMessage } = createChatHelpers({ getBot: () => context.bot })
  const commandSystem = createCommandSystem({
    context,
    config,
    inventory: inventoryHelpers,
    perception: perceptionHelpers,
    survivalGuard,
    collection,
    parseCoords,
    parsePositiveInteger,
    normalizeItemName: minecraftCatalog.normalizeItemName,
    sendLongMessage
  })

  const skillRegistry = setupSkillRegistry({
    context,
    config,
    commandSystem,
    collection,
    inventory: inventoryHelpers,
    craftingHelpers,
    placementHelpers,
    containerHelpers,
    survivalGuard,
    stateReporter
  })
  context.skillRegistry = skillRegistry

  runtime = createBotRuntime({
    context,
    mineflayer,
    pathfinder,
    Movements,
    config,
    ownerMatches,
    createNavigationController: navigation.createNavigationController,
    handleCommand: commandSystem.handleCommand,
    refreshPerceptionCache: perceptionHelpers.refreshPerceptionCache,
    survivalGuard,
    runAutoDropCollection: collection.runAutoDropCollection
  })
  context.reconnectBot = runtime.reconnectBot

  runtime.start()
  return { context, runtime }
}

module.exports = {
  start,
  loadConfig,
  setupSkillRegistry
}
