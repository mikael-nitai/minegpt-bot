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

function positionSnapshot (position) {
  if (!position) return null
  return {
    x: Math.round(position.x * 10) / 10,
    y: Math.round(position.y * 10) / 10,
    z: Math.round(position.z * 10) / 10
  }
}

function distanceBetween (a, b) {
  if (!a || !b) return Infinity
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

async function runCompletedMovement ({ context, goal, targetPosition, tolerance, label, timeoutMs, startedAt }) {
  const startPosition = context.bot.entity.position.clone()
  context.navigationController.stop(`skill ${label}`)
  context.navigationController.applyMovements()

  try {
    await withTimeout(context.bot.pathfinder.goto(goal), timeoutMs, label)
    const finalPosition = context.bot.entity.position.clone()
    const distance = distanceBetween(finalPosition, targetPosition)

    if (distance > tolerance) {
      return actionFail(label, `Movimento terminou longe demais do alvo (${Math.round(distance * 10) / 10} blocos).`, {
        target: positionSnapshot(targetPosition),
        finalPosition: positionSnapshot(finalPosition),
        distance
      }, startedAt, {
        code: 'goal_not_reached',
        retryable: true,
        positionDelta: {
          from: positionSnapshot(startPosition),
          to: positionSnapshot(finalPosition)
        }
      })
    }

    return actionOk(label, `Cheguei ao alvo (${Math.round(distance * 10) / 10} blocos).`, {
      target: positionSnapshot(targetPosition),
      finalPosition: positionSnapshot(finalPosition),
      distance
    }, startedAt, {
      code: 'goal_reached',
      positionDelta: {
        from: positionSnapshot(startPosition),
        to: positionSnapshot(finalPosition)
      }
    })
  } catch (error) {
    const finalPosition = context.bot.entity?.position?.clone?.() || context.bot.entity?.position
    return actionFail(label, `Falha de movimento: ${error.message}`, {
      target: positionSnapshot(targetPosition),
      finalPosition: positionSnapshot(finalPosition)
    }, startedAt, {
      code: error.actionCode === 'timeout' ? 'timeout' : 'movement_failed',
      retryable: true,
      positionDelta: {
        from: positionSnapshot(startPosition),
        to: positionSnapshot(finalPosition)
      }
    })
  } finally {
    context.bot.pathfinder.stop()
    context.bot.clearControlStates()
  }
}

function setupSkillRegistry ({
  context,
  config,
  collection,
  inventory,
  craftingHelpers,
  placementHelpers,
  containerHelpers,
  survivalGuard,
  stateReporter
}) {
  const registry = createSkillRegistry({ defaultContext: context })

  registry.register({
    id: 'movement.follow_owner',
    description: 'Segue o jogador dono.',
    risk: 'low',
    timeoutMs: 1000,
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['position', 'movement'],
    cost: { base: 2, movement: true },
    plannerHints: 'Use quando o objetivo for acompanhar o dono continuamente.',
    run: () => {
      context.navigationController.followPlayer(config.owner)
      return actionOk('movement.follow_owner', 'seguindo dono')
    }
  })

  registry.register({
    id: 'movement.come_here',
    description: 'Vai ate o jogador dono e so retorna sucesso quando chegar.',
    risk: 'low',
    timeoutMs: 30000,
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['position', 'movement'],
    cost: { base: 2, movement: true },
    plannerHints: 'Use para aproximar o bot do dono antes de interagir ou receber itens.',
    run: async () => {
      const startedAt = Date.now()
      const target = context.bot.players[config.owner]?.entity
      if (!target) {
        return actionFail('movement.come_here', `Nao encontrei ${config.owner} por perto.`, { owner: config.owner }, startedAt, {
          code: 'target_not_found',
          retryable: true
        })
      }

      const targetPosition = target.position.clone()
      return runCompletedMovement({
        context,
        goal: new goals.GoalNear(targetPosition.x, targetPosition.y, targetPosition.z, 1),
        targetPosition,
        tolerance: 3,
        label: 'movement.come_here',
        timeoutMs: 28000,
        startedAt
      })
    }
  })

  registry.register({
    id: 'movement.go_to',
    description: 'Vai ate coordenadas X Y Z e so retorna sucesso quando chegar.',
    risk: 'medium',
    timeoutMs: 30000,
    inputSchema: { x: 'number', y: 'number', z: 'number' },
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['position', 'movement'],
    cost: { base: 4, movement: true },
    plannerHints: 'Use apenas quando houver coordenadas confiaveis e rota razoavelmente segura.',
    run: async ({ x, y, z }) => {
      const startedAt = Date.now()
      if ([x, y, z].some(value => typeof value !== 'number')) return actionFail('movement.go_to', 'coordenadas invalidas')
      const targetPosition = new Vec3(x, y, z)
      return runCompletedMovement({
        context,
        goal: new goals.GoalBlock(x, y, z),
        targetPosition,
        tolerance: 1.8,
        label: 'movement.go_to',
        timeoutMs: 28000,
        startedAt
      })
    }
  })

  registry.register({
    id: 'movement.stop',
    description: 'Para movimento e cancela skill atual.',
    risk: 'low',
    timeoutMs: 1000,
    requires: ['botOnline', 'navigationReady'],
    effects: ['movement', 'activeSkill'],
    cost: { base: 1 },
    plannerHints: 'Use como acao segura para interromper movimento ou recuperar controle.',
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
    requires: ['botOnline', 'notReconnecting'],
    effects: ['heldItem'],
    cost: { base: 1 },
    plannerHints: 'Use antes de minerar, combater, comer ou colocar blocos quando a mao importa.',
    run: async ({ item }) => {
      if (!item) return actionFail('inventory.equip', 'item ausente')
      return inventory.equipItemAction(item)
    }
  })

  registry.register({
    id: 'inventory.drop',
    description: 'Dropa item do inventario.',
    risk: 'medium',
    timeoutMs: 5000,
    inputSchema: { item: 'string', amount: 'number optional' },
    requires: ['botOnline', 'notReconnecting'],
    effects: ['inventory', 'worldDrops'],
    cost: { base: 2 },
    plannerHints: 'Use com cuidado porque remove itens do inventario e cria drop no mundo.',
    run: async ({ item, amount = null }) => {
      if (!item) return actionFail('inventory.drop', 'item ausente')
      return inventory.dropItemAction(item, amount)
    }
  })

  registry.register({
    id: 'inventory.hotbar',
    description: 'Move item para slot da hotbar.',
    risk: 'low',
    timeoutMs: 5000,
    inputSchema: { slot: 'number 1-9', item: 'string' },
    requires: ['botOnline', 'notReconnecting'],
    effects: ['inventory', 'hotbar'],
    cost: { base: 1 },
    plannerHints: 'Use para preparar ferramentas, comida, tochas ou blocos antes de uma sequencia.',
    run: async ({ slot, item }) => {
      if (!slot || !item) return actionFail('inventory.hotbar', 'slot ou item ausente')
      return inventory.moveItemToHotbarAction(slot, item)
    }
  })

  registry.register({
    id: 'collection.collect',
    description: 'Coleta/minera um bloco alvo percebido.',
    risk: 'medium',
    timeoutMs: 60000,
    inputSchema: { target: 'string', count: 'number optional max 10' },
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['world', 'inventory', 'position', 'drops'],
    cost: { base: 5, movement: true, worldChange: true },
    plannerHints: 'Use para transformar percepcao em recurso; prefere alvos visiveis e seguros.',
    run: async ({ target, count = 1 }) => {
      if (!target) return actionFail('collection.collect', 'alvo ausente')
      return collection.collectByTargetAction(target, count)
    }
  })

  registry.register({
    id: 'drops.collect',
    description: 'Coleta drops proximos, opcionalmente por alvo.',
    risk: 'low',
    timeoutMs: 8000,
    inputSchema: { target: 'string optional' },
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['inventory', 'position', 'drops'],
    cost: { base: 3, movement: true },
    plannerHints: 'Use depois de minerar ou quando houver itens dropados relevantes por perto.',
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
    requires: ['botOnline', 'notReconnecting'],
    effects: ['inventory'],
    cost: { base: 4, mayNeedCraftingTable: true },
    plannerHints: 'Use quando o item final e conhecido e os materiais provavelmente existem.',
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
    requires: ['botOnline'],
    effects: ['chat'],
    cost: { base: 1 },
    plannerHints: 'Use antes de craftar quando for necessario explicar faltas ou dependencias.',
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
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['world', 'inventory', 'position'],
    cost: { base: 4, movement: true, worldChange: true },
    plannerHints: 'Use para colocacao simples; nao use para estruturas grandes ainda.',
    run: async ({ target = 'bloco', mode = 'front', coords = null }) => {
      return placementHelpers.placeByRequest({ target, mode, coords, raw: target })
    }
  })

  registry.register({
    id: 'containers.scan',
    description: 'Procura, abre e memoriza containers proximos.',
    risk: 'medium',
    timeoutMs: 60000,
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['position', 'containerMemory'],
    cost: { base: 5, movement: true },
    plannerHints: 'Use para atualizar memoria antes de buscar ou guardar itens em baus.',
    run: () => containerHelpers.scanAndInspectContainers()
  })

  registry.register({
    id: 'containers.search',
    description: 'Procura item na memoria e em containers proximos.',
    risk: 'low',
    timeoutMs: 60000,
    inputSchema: { target: 'string' },
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['position', 'containerMemory'],
    cost: { base: 3, movement: true },
    plannerHints: 'Use para localizar item sem necessariamente retirar do container.',
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
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['inventory', 'position', 'containerMemory'],
    cost: { base: 5, movement: true },
    plannerHints: 'Use quando o bot precisa de item que pode estar em container conhecido/proximo.',
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
    requires: ['botOnline', 'navigationReady', 'notReconnecting'],
    effects: ['inventory', 'position', 'containerMemory'],
    cost: { base: 5, movement: true },
    plannerHints: 'Use para organizar inventario preservando itens protegidos pela skill de containers.',
    run: ({ mode = 'target', target = null, count = null }) => containerHelpers.depositByRequest({ mode, target, count })
  })

  registry.register({
    id: 'containers.clear_memory',
    description: 'Esquece memoria de containers.',
    risk: 'low',
    timeoutMs: 1000,
    effects: ['containerMemory'],
    cost: { base: 1 },
    plannerHints: 'Use quando a memoria de containers estiver velha ou inconsistente.',
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
    requires: ['botOnline'],
    effects: ['chat'],
    cost: { base: 1 },
    plannerHints: 'Use para decidir se o bot esta seguro antes de iniciar acoes maiores.',
    run: () => actionOk('survival.status', survivalGuard.describeStatus(), survivalGuard.assess())
  })

  registry.register({
    id: 'survival.set_enabled',
    description: 'Liga/desliga survival guard.',
    risk: 'low',
    timeoutMs: 1000,
    inputSchema: { enabled: 'boolean' },
    effects: ['survivalGuard'],
    cost: { base: 1 },
    plannerHints: 'Use raramente; o normal e manter survival guard ligado em survival.',
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
    requires: ['botOnline', 'stateReporter'],
    effects: [],
    cost: { base: 1 },
    plannerHints: 'Use como principal leitura estruturada antes de planejar.',
    run: () => actionOk('state.snapshot', 'estado atual', stateReporter.getStateSnapshot())
  })

  registry.register({
    id: 'state.planner_snapshot',
    description: 'Retorna estado compacto para uma futura IA planejadora.',
    risk: 'low',
    timeoutMs: 1000,
    requires: ['botOnline', 'stateReporter'],
    effects: [],
    cost: { base: 1 },
    plannerHints: 'Use como leitura preferencial para LLM; mais compacto que state.snapshot.',
    run: () => actionOk('state.planner_snapshot', 'estado compacto para planner', stateReporter.getPlannerSnapshot())
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
    finishSkill: null,
    config
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
