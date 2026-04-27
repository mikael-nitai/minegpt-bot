const { actionOk, actionFail, itemRequirement, suggestSkillAction } = require('./action-result')

function createInventoryHelpers ({ getBot, mcData, catalog, toolTier }) {
  const {
    normalizeItemName,
    resolveCatalogQuery,
    catalogItemHasCategory
  } = catalog

  function currentBot () {
    const bot = getBot()
    if (!bot) throw new Error('bot ainda nao inicializado')
    return bot
  }

  function formatItem (item) {
    if (!item) return 'vazio'
    return `${item.count}x ${item.name}`
  }

  function summarizeInventory () {
    const summary = new Map()

    for (const item of currentBot().inventory.items()) {
      summary.set(item.name, (summary.get(item.name) || 0) + item.count)
    }

    return [...summary.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${count}x ${name}`)
  }

  function inventorySnapshot () {
    const snapshot = new Map()

    for (const item of currentBot().inventory.items()) {
      snapshot.set(item.name, (snapshot.get(item.name) || 0) + item.count)
    }

    return snapshot
  }

  function diffInventorySnapshots (before, after) {
    const gains = []
    const itemNames = new Set([...before.keys(), ...after.keys()])

    for (const itemName of itemNames) {
      const amount = (after.get(itemName) || 0) - (before.get(itemName) || 0)
      if (amount > 0) gains.push({ name: itemName, count: amount })
    }

    return gains.sort((a, b) => a.name.localeCompare(b.name))
  }

  function inventoryDeltaBetweenSnapshots (before, after) {
    const changes = []
    const itemNames = new Set([...before.keys(), ...after.keys()])

    for (const itemName of itemNames) {
      const beforeCount = before.get(itemName) || 0
      const afterCount = after.get(itemName) || 0
      const delta = afterCount - beforeCount
      if (delta !== 0) changes.push({ name: itemName, before: beforeCount, after: afterCount, delta })
    }

    return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name))
  }

  function formatItemList (items) {
    return items.map(item => `${item.count}x ${item.name}`).join(', ')
  }

  function normalizeItemTarget (query, context = 'inventory') {
    const resolution = resolveCatalogQuery(query, context)
    const itemNames = new Set()
    const itemCategories = new Set()
    const itemScores = new Map()

    for (const candidate of resolution.candidates) {
      if (candidate.kind === 'item') {
        itemNames.add(candidate.name)
        itemScores.set(candidate.name, Math.max(itemScores.get(candidate.name) || 0, candidate.score))
      } else if (candidate.kind === 'item_category') {
        itemCategories.add(candidate.name)
      }
    }

    return {
      raw: resolution.raw,
      resolution,
      itemNames,
      itemCategories,
      itemScores
    }
  }

  function itemTargetMatchesName (target, itemName) {
    if (target.itemNames.has(itemName)) return true
    for (const category of target.itemCategories) {
      if (catalogItemHasCategory(itemName, category)) return true
    }
    return false
  }

  function itemTargetScore (target, itemName) {
    let score = target.itemScores.get(itemName) || 0
    for (const category of target.itemCategories) {
      if (catalogItemHasCategory(itemName, category)) score = Math.max(score, 160)
    }
    return score
  }

  function findInventoryItems (query) {
    const target = normalizeItemTarget(query, 'inventory')
    const normalized = normalizeItemName(query)
    const items = currentBot().inventory.items()
    const resolved = items
      .filter(item => itemTargetMatchesName(target, item.name))
      .sort((a, b) => itemTargetScore(target, b.name) - itemTargetScore(target, a.name) || toolTier(b.name) - toolTier(a.name) || a.name.localeCompare(b.name))

    if (resolved.length > 0) return resolved

    const exact = items.filter(item => item.name.toLowerCase() === normalized)
    if (exact.length > 0) return exact

    return items.filter(item => item.name.toLowerCase().includes(normalized))
  }

  function findInventoryItem (query) {
    const items = findInventoryItems(query)
    if (items.length === 0) return null

    return items[0]
  }

  function resolveInventoryItemForAction (query, skill, startedAt = Date.now()) {
    const rawQuery = String(query || '').trim()
    if (!rawQuery) {
      return {
        result: actionFail(skill, 'Informe um item.', { query }, startedAt, {
          code: 'validation_failed',
          retryable: false
        })
      }
    }

    const target = normalizeItemTarget(rawQuery, 'inventory')
    const normalizedQuery = normalizeItemName(rawQuery)
    const matches = findInventoryItems(rawQuery)

    if (matches.length === 0) {
      return {
        result: actionFail(skill, `Nao tenho ${rawQuery}.`, { query: rawQuery }, startedAt, {
          code: 'item_not_found',
          retryable: true,
          missingRequirements: [itemRequirement(rawQuery, 1)],
          suggestedNextActions: [
            suggestSkillAction('containers.withdraw', { target: rawQuery, count: 1 }, 'procurar o item em containers'),
            suggestSkillAction('collection.collect', { target: rawQuery, count: 1 }, 'coletar o recurso no mundo, se for um bloco coletavel')
          ]
        })
      }
    }

    const names = Array.from(new Set(matches.map(item => item.name))).sort()
    const exactMatch = matches.find(item => normalizeItemName(item.name) === normalizedQuery)
    const isCatalogCategory = target.itemCategories.size > 0
    const isCatalogItem = target.itemNames.size > 0
    const shouldTreatAsAmbiguous = names.length > 1 && !exactMatch && !isCatalogCategory && !isCatalogItem

    if (shouldTreatAsAmbiguous) {
      return {
        result: actionFail(skill, `Nome ambiguo: ${rawQuery}.`, { query: rawQuery, options: names.slice(0, 8) }, startedAt, {
          code: 'ambiguous_item',
          retryable: false
        })
      }
    }

    return { item: exactMatch || matches[0], matches, target }
  }

  async function equipItemAction (query, startedAt = Date.now()) {
    const resolved = resolveInventoryItemForAction(query, 'inventory.equip', startedAt)
    if (resolved.result) return resolved.result

    try {
      const item = resolved.item
      const heldBefore = currentBot().heldItem?.name || null
      if (heldBefore === item.name) {
        return actionOk('inventory.equip', `Ja estou segurando ${item.name}.`, {
          itemName: item.name,
          item: formatItem(item),
          heldBefore
        }, startedAt, {
          code: 'already_equipped'
        })
      }

      await currentBot().equip(item, 'hand')
      return actionOk('inventory.equip', `Segurando ${item.name}.`, {
        itemName: item.name,
        item: formatItem(item),
        heldBefore,
        heldAfter: item.name
      }, startedAt, {
        code: 'equipped'
      })
    } catch (error) {
      return actionFail('inventory.equip', `Falha ao equipar ${query}: ${error.message}`, { query }, startedAt, {
        code: 'inventory_action_failed',
        retryable: true
      })
    }
  }

  async function dropItemAction (query, amount = null, startedAt = Date.now()) {
    if (amount != null && (!Number.isInteger(Number(amount)) || Number(amount) <= 0)) {
      return actionFail('inventory.drop', 'Quantidade invalida para dropar item.', { query, amount }, startedAt, {
        code: 'invalid_amount',
        retryable: false
      })
    }

    const resolved = resolveInventoryItemForAction(query, 'inventory.drop', startedAt)
    if (resolved.result) return resolved.result

    try {
      const item = resolved.item
      const before = inventorySnapshot()
      let dropped
      let message

      if (amount == null) {
        dropped = item.count
        await currentBot().tossStack(item)
        message = `Dropei ${formatItem(item)}.`
      } else {
        const requested = Number(amount)
        const totalAvailable = resolved.matches.reduce((sum, stack) => sum + stack.count, 0)
        dropped = Math.min(requested, totalAvailable)
        await currentBot().toss(item.type, item.metadata, dropped)
        message = `Dropei ${dropped}x ${item.name}.`
      }

      const after = inventorySnapshot()
      return actionOk('inventory.drop', message, {
        item: item.name,
        requestedAmount: amount,
        dropped
      }, startedAt, {
        code: 'dropped',
        worldChanged: true,
        inventoryDelta: inventoryDeltaBetweenSnapshots(before, after)
      })
    } catch (error) {
      return actionFail('inventory.drop', `Falha ao dropar ${query}: ${error.message}`, { query, amount }, startedAt, {
        code: 'inventory_action_failed',
        retryable: true
      })
    }
  }

  async function moveItemToHotbarAction (slot, query, startedAt = Date.now()) {
    const slotNumber = Number(slot)
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 9) {
      return actionFail('inventory.hotbar', 'Slot invalido. Use 1 a 9.', { slot, query }, startedAt, {
        code: 'invalid_slot',
        retryable: false
      })
    }

    const resolved = resolveInventoryItemForAction(query, 'inventory.hotbar', startedAt)
    if (resolved.result) return resolved.result

    try {
      const item = resolved.item
      const destinationSlot = hotbarSlotToInventorySlot(slotNumber)
      if (item.slot === destinationSlot) {
        return actionOk('inventory.hotbar', `${item.name} ja esta no slot ${slotNumber}.`, {
          item: formatItem(item),
          slot: slotNumber,
          destinationSlot
        }, startedAt, {
          code: 'already_in_slot'
        })
      }

      if (item.slot == null) {
        return actionFail('inventory.hotbar', `Nao consegui identificar o slot de ${item.name}.`, {
          item: formatItem(item),
          slot: slotNumber
        }, startedAt, {
          code: 'inventory_action_failed',
          retryable: true
        })
      }

      await currentBot().moveSlotItem(item.slot, destinationSlot)
      return actionOk('inventory.hotbar', `Coloquei ${item.name} na hotbar ${slotNumber}.`, {
        item: formatItem(item),
        slot: slotNumber,
        fromSlot: item.slot,
        destinationSlot
      }, startedAt, {
        code: 'moved_to_hotbar'
      })
    } catch (error) {
      return actionFail('inventory.hotbar', `Falha ao mover ${query} para hotbar: ${error.message}`, { query, slot }, startedAt, {
        code: 'inventory_action_failed',
        retryable: true
      })
    }
  }

  function hotbarSlotToInventorySlot (slotNumber) {
    return currentBot().QUICK_BAR_START + slotNumber - 1
  }

  function describeStatus () {
    const bot = currentBot()
    const pos = bot.entity.position
    const inventory = summarizeInventory()
    const held = bot.heldItem ? formatItem(bot.heldItem) : 'mao vazia'

    return [
      `vida ${bot.health}/20`,
      `fome ${bot.food}/20`,
      `saturacao ${Math.round((bot.foodSaturation || 0) * 10) / 10}`,
      `pos ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`,
      `mao ${held}`,
      inventory.length === 0 ? 'inventario vazio' : `itens ${inventory.slice(0, 8).join(', ')}`
    ].join(' | ')
  }

  function describeHotbar () {
    const bot = currentBot()
    const slots = []

    for (let slot = 1; slot <= 9; slot++) {
      const inventorySlot = hotbarSlotToInventorySlot(slot)
      const item = bot.inventory.slots[inventorySlot]
      const marker = bot.quickBarSlot === slot - 1 ? '*' : ''
      slots.push(`${slot}${marker}:${item ? formatItem(item) : 'vazio'}`)
    }

    return slots.join(' | ')
  }

  function inventoryHasFreeSlot () {
    const bot = currentBot()
    if (typeof bot.inventory.emptySlotCount === 'function') {
      return bot.inventory.emptySlotCount() > 0
    }

    return bot.inventory.firstEmptyInventorySlot() != null
  }

  function itemMaxStackSize (itemName) {
    const itemData = mcData.itemsByName[itemName] || mcData.blocksByName[itemName]
    return itemData?.stackSize || 64
  }

  function inventoryCanStackItemName (itemName) {
    return currentBot().inventory.items().some((item) => {
      if (item.name !== itemName) return false
      return item.count < (item.stackSize || itemMaxStackSize(item.name))
    })
  }

  function namesFromItemIds (ids = []) {
    return ids
      .map(id => mcData.items[id]?.name || mcData.blocks[id]?.name)
      .filter(Boolean)
  }

  function possibleDropNamesForBlock (block) {
    const blockData = mcData.blocksByName[block.name]
    const drops = namesFromItemIds(blockData?.drops)
    return drops.length > 0 ? drops : [block.name]
  }

  function inventoryCanReceiveAny (itemNames = []) {
    if (inventoryHasFreeSlot()) return true
    return itemNames.some(itemName => inventoryCanStackItemName(itemName))
  }

  return {
    formatItem,
    summarizeInventory,
    inventorySnapshot,
    diffInventorySnapshots,
    inventoryDeltaBetweenSnapshots,
    formatItemList,
    normalizeItemTarget,
    itemTargetMatchesName,
    itemTargetScore,
    findInventoryItems,
    findInventoryItem,
    resolveInventoryItemForAction,
    equipItemAction,
    dropItemAction,
    moveItemToHotbarAction,
    hotbarSlotToInventorySlot,
    describeStatus,
    describeHotbar,
    inventoryHasFreeSlot,
    itemMaxStackSize,
    inventoryCanStackItemName,
    possibleDropNamesForBlock,
    inventoryCanReceiveAny
  }
}

module.exports = {
  createInventoryHelpers
}
