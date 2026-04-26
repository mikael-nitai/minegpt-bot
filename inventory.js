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
    formatItemList,
    normalizeItemTarget,
    itemTargetMatchesName,
    itemTargetScore,
    findInventoryItems,
    findInventoryItem,
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
