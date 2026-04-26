const { actionOk, actionFail } = require('./action-result')

function plannedCraftRuns (desiredCount, recipeResultCount) {
  return Math.max(1, Math.ceil(Math.max(1, Math.floor(desiredCount || 1)) / Math.max(1, recipeResultCount || 1)))
}

function plannedCraftOutput (desiredCount, recipeResultCount) {
  return plannedCraftRuns(desiredCount, recipeResultCount) * Math.max(1, recipeResultCount || 1)
}

function createCraftingHelpers ({
  getBot,
  mcData,
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
  const BASIC_CHAIN_TARGETS = new Set([
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'torch', 'chest'
  ])

  function bot () {
    const current = getBot()
    if (!current) throw new Error('bot ainda nao inicializado')
    return current
  }

  function itemCount (itemName) {
    return bot().inventory.items()
      .filter(item => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0)
  }

  function resolveCraftTarget (query) {
    const resolution = catalog.resolveCatalogQuery(query, 'item')
    const itemCandidates = resolution.candidates
      .filter(candidate => candidate.kind === 'item')
      .filter(candidate => mcData.itemsByName[candidate.name])

    return {
      raw: resolution.raw,
      resolution,
      candidates: itemCandidates
    }
  }

  function resultCountFromRecipe (recipe) {
    return recipe.result?.count || recipe.result?.value?.count || 1
  }

  function describeRecipe (recipe) {
    const delta = recipe.delta || []
    const ingredients = delta
      .filter(entry => entry.count < 0)
      .map(entry => {
        const item = mcData.items[entry.id] || mcData.blocks[entry.id]
        return `${Math.abs(entry.count)}x ${item?.name || entry.id}`
      })
      .join(', ')
    const resultCount = resultCountFromRecipe(recipe)
    return `${ingredients || 'ingredientes desconhecidos'} -> ${resultCount} resultado(s)`
  }

  function findNearbyCraftingTable () {
    const tableId = bot().registry.blocksByName.crafting_table?.id
    if (!tableId) return null

    return bot().findBlock({
      matching: tableId,
      maxDistance: 16
    })
  }

  async function moveToCraftingTable (table) {
    if (!table) return null
    if (bot().entity.position.distanceTo(table.position) <= 4) return table

    await withTimeout(
      bot().pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3)),
      10000,
      'aproximar da crafting table'
    )
    return table
  }

  function availableRecipeForItem (itemName, desiredCount, table) {
    const item = mcData.itemsByName[itemName]
    if (!item) return null

    const withTable = table ? bot().recipesFor(item.id, null, desiredCount, table) : []
    if (withTable.length > 0) return { recipe: withTable[0], table }

    const withoutTable = bot().recipesFor(item.id, null, desiredCount, null)
    if (withoutTable.length > 0) return { recipe: withoutTable[0], table: null }

    return null
  }

  function anyRecipeForItem (itemName, table) {
    const item = mcData.itemsByName[itemName]
    if (!item) return null

    const withTable = table ? bot().recipesAll(item.id, null, table) : []
    if (withTable.length > 0) return { recipe: withTable[0], table, requiresTable: true }

    const withoutTable = bot().recipesAll(item.id, null, null)
    if (withoutTable.length > 0) return { recipe: withoutTable[0], table: null, requiresTable: false }

    const virtualTable = bot().recipesAll(item.id, null, true)
    if (virtualTable.length > 0) return { recipe: virtualTable[0], table: null, requiresTable: true }

    return null
  }

  function recipeMissingItems (recipe) {
    const missing = []
    for (const entry of recipe.delta || []) {
      if (entry.count >= 0) continue
      const item = mcData.items[entry.id] || mcData.blocks[entry.id]
      const name = item?.name
      if (!name) continue
      const needed = Math.abs(entry.count)
      const available = itemCount(name)
      if (available < needed) missing.push({ name, needed, available, missing: needed - available })
    }
    return missing
  }

  function scaledRecipeMissingItems (recipe, craftRuns) {
    const missing = []
    for (const entry of recipe.delta || []) {
      if (entry.count >= 0) continue
      const item = mcData.items[entry.id] || mcData.blocks[entry.id]
      const name = item?.name
      if (!name) continue
      const needed = Math.abs(entry.count) * craftRuns
      const available = itemCount(name)
      if (available < needed) missing.push({ name, needed, available, missing: needed - available })
    }
    return missing
  }

  function recipeNeedsTable (itemName, table) {
    const item = mcData.itemsByName[itemName]
    if (!item) return false
    const handRecipes = bot().recipesAll(item.id, null, null)
    if (handRecipes.length > 0) return false
    return Boolean(anyRecipeForItem(itemName, table)?.requiresTable)
  }

  function chooseCraftCandidate (query) {
    const target = resolveCraftTarget(query)
    for (const candidate of target.candidates) {
      if (mcData.itemsByName[candidate.name]) return { target, itemName: candidate.name }
    }
    return { target, itemName: null }
  }

  function survivalBlocksCrafting () {
    const status = survival.assess()
    if (status.severity >= 80) return status.top?.reason || 'risco de sobrevivencia alto'
    return null
  }

  function askForMaterials (missing) {
    if (!missing.length) return
    bot().chat(`${owner}, preciso de materiais para craftar isso.`)
  }

  function askForCraftingTable () {
    bot().chat(`${owner}, preciso de uma crafting table.`)
  }

  async function craftDirectByName (itemName, count, skill, options = {}) {
    const desiredCount = Math.max(1, Math.floor(count || 1))
    const before = inventory.inventorySnapshot()
    const startedCount = itemCount(itemName)
    const table = findNearbyCraftingTable()
    const recipeInfo = anyRecipeForItem(itemName, table)

    if (!recipeInfo) {
      return actionFail('crafting.craft', `nao encontrei receita para ${itemName}`, { itemName })
    }

    if (recipeInfo.requiresTable && !table) {
      askForCraftingTable()
      return actionFail('crafting.craft', `preciso de crafting table para ${itemName}`, { itemName })
    }

    const resultCount = resultCountFromRecipe(recipeInfo.recipe)
    const craftRuns = plannedCraftRuns(desiredCount, resultCount)
    const missing = scaledRecipeMissingItems(recipeInfo.recipe, craftRuns)
    if (missing.length > 0) {
      askForMaterials(missing)
      return actionFail('crafting.craft', `materiais insuficientes para ${desiredCount}x ${itemName}`, { itemName, desiredCount, craftRuns, missing })
    }

    const available = availableRecipeForItem(itemName, desiredCount, table)
    if (!available) {
      return actionFail('crafting.craft', `receita indisponivel para ${desiredCount}x ${itemName}`, { itemName, desiredCount, craftRuns })
    }

    const targetTable = available.table ? await moveToCraftingTable(available.table) : null
    assertSkillActive(skill)

    if (options.announce !== false) {
      bot().chat(`Craftando ${desiredCount}x ${itemName}.`)
    }

    await withTimeout(
      bot().craft(available.recipe, craftRuns, targetTable),
      12000,
      `craftar ${itemName}`
    )

    const after = inventory.inventorySnapshot()
    const gained = (after.get(itemName) || 0) - startedCount
    const gains = inventory.diffInventorySnapshots(before, after)

    if (gained < desiredCount) {
      return actionFail('crafting.craft', `craft executado, mas nao detectei ${itemName} novo`, { itemName, gains })
    }

    return actionOk('crafting.craft', `craftei ${gained}x ${itemName}`, { itemName, requested: desiredCount, craftRuns, recipeResultCount: resultCount, gained, gains })
  }

  async function craftBasicDependencies (itemName, count, skill, depth = 0) {
    if (depth > 2 || !BASIC_CHAIN_TARGETS.has(itemName)) return []
    const crafted = []

    if (itemName.endsWith('_planks')) {
      return crafted
    }

    if (itemName === 'stick' && itemCount('stick') < count) {
      const plank = firstAvailablePlank()
      if (!plank) await craftAnyPlanks(skill)
      if (firstAvailablePlank()) {
        const result = await craftDirectByName('stick', count - itemCount('stick'), skill, { announce: false })
        crafted.push(result)
      }
    }

    if (['crafting_table', 'wooden_pickaxe', 'chest'].includes(itemName) && totalPlanks() < 4) {
      const result = await craftAnyPlanks(skill)
      if (result) crafted.push(result)
    }

    if (['wooden_pickaxe', 'stone_pickaxe'].includes(itemName) && itemCount('stick') < 2) {
      const result = await craftDirectByName('stick', 2 - itemCount('stick'), skill, { announce: false })
      crafted.push(result)
    }

    if (itemName === 'torch' && itemCount('stick') < Math.ceil(count / 4)) {
      const result = await craftDirectByName('stick', Math.ceil(count / 4) - itemCount('stick'), skill, { announce: false })
      crafted.push(result)
    }

    if (itemName === 'stone_pickaxe' && itemCount('wooden_pickaxe') === 0 && !inventory.findInventoryItem('picareta')) {
      await craftBasicDependencies('wooden_pickaxe', 1, skill, depth + 1)
      const result = await craftDirectByName('wooden_pickaxe', 1, skill, { announce: false })
      crafted.push(result)
    }

    if (['furnace', 'stone_pickaxe'].includes(itemName) && itemCount('cobblestone') === 0 && itemCount('stone') === 0) {
      // Fase 2 prepara cadeia curta, mas nao coleta recursos automaticamente aqui.
    }

    return crafted
  }

  function firstAvailableLog () {
    return bot().inventory.items().find(item =>
      item.name.endsWith('_log') || item.name.endsWith('_stem') || item.name.endsWith('_hyphae')
    ) || null
  }

  function firstAvailablePlank () {
    return bot().inventory.items().find(item => item.name.endsWith('_planks')) || null
  }

  function totalPlanks () {
    return bot().inventory.items()
      .filter(item => item.name.endsWith('_planks'))
      .reduce((sum, item) => sum + item.count, 0)
  }

  async function craftAnyPlanks (skill) {
    const plank = firstAvailablePlank()
    if (plank) return null

    const log = firstAvailableLog()
    if (!log) return null

    const family = log.name
      .replace('_log', '_planks')
      .replace('_stem', '_planks')
      .replace('_hyphae', '_planks')
    if (!mcData.itemsByName[family]) return null

    return craftDirectByName(family, 1, skill, { announce: false })
  }

  async function craftByQuery (query, count = 1, options = {}) {
    if (getActiveSkill()) {
      return actionFail('crafting.craft', `ja estou executando ${getActiveSkill().name}`)
    }

    const survivalRisk = survivalBlocksCrafting()
    if (survivalRisk) return actionFail('crafting.craft', `nao vou craftar agora: ${survivalRisk}`)

    const { target, itemName } = chooseCraftCandidate(query)
    if (!itemName) return actionFail('crafting.craft', `nao encontrei item craftavel para "${query}"`, { candidates: target.candidates.slice(0, 5) })

    const skill = startSkill('crafting')
    getNavigationController()?.stop('skill crafting')

    try {
      if (options.allowBasicChain !== false && BASIC_CHAIN_TARGETS.has(itemName)) {
        await craftBasicDependencies(itemName, count, skill)
      }

      const result = await craftDirectByName(itemName, count, skill, options)
      return result
    } catch (err) {
      return actionFail('crafting.craft', err.message, { itemName, stack: err.stack })
    } finally {
      bot().pathfinder.stop()
      bot().clearControlStates()
      finishSkill(skill)
    }
  }

  function describeRecipeByQuery (query) {
    const { target, itemName } = chooseCraftCandidate(query)
    if (!itemName) return `Receita: nao encontrei item para "${query}".`

    const table = findNearbyCraftingTable()
    const recipeInfo = anyRecipeForItem(itemName, table)
    if (!recipeInfo) return `Receita: nao conheco receita para ${itemName}.`

    const missing = recipeMissingItems(recipeInfo.recipe)
    const tableText = recipeNeedsTable(itemName, table) ? 'precisa de crafting table' : 'sem mesa'
    const missingText = missing.length > 0
      ? `faltando ${missing.map(item => `${item.missing}x ${item.name}`).join(', ')}`
      : 'materiais disponiveis'

    return `Receita ${itemName}: ${describeRecipe(recipeInfo.recipe)} | ${tableText} | ${missingText}`
  }

  function describeStatus () {
    const table = findNearbyCraftingTable()
    return `Crafting: mesa=${table ? `${table.position.x},${table.position.y},${table.position.z}` : 'nao encontrada'} inventario=${inventory.summarizeInventory().slice(0, 8).join(', ') || 'vazio'}`
  }

  return {
    craftByQuery,
    describeRecipeByQuery,
    describeStatus,
    resolveCraftTarget,
    chooseCraftCandidate
  }
}

module.exports = {
  createCraftingHelpers,
  plannedCraftRuns,
  plannedCraftOutput
}
