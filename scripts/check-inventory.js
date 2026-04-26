const assert = require('assert')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')
const { createInventoryHelpers } = require('../inventory')

const mcData = minecraftData('1.20.4')
const catalog = createMinecraftCatalog(mcData)

const bot = {
  QUICK_BAR_START: 36,
  quickBarSlot: 0,
  health: 18,
  food: 17,
  foodSaturation: 4.25,
  heldItem: { name: 'stone_pickaxe', count: 1 },
  entity: {
    position: { x: 10.25, y: 64, z: -5.5 }
  },
  inventory: {
    slots: [],
    items: () => [
      { name: 'stone_pickaxe', count: 1, stackSize: 1 },
      { name: 'bread', count: 3, stackSize: 64 },
      { name: 'coal', count: 16, stackSize: 64 },
      { name: 'dirt', count: 64, stackSize: 64 }
    ],
    emptySlotCount: () => 0,
    firstEmptyInventorySlot: () => null
  }
}
bot.inventory.slots[36] = { name: 'stone_pickaxe', count: 1 }

const inventory = createInventoryHelpers({
  getBot: () => bot,
  mcData,
  catalog,
  toolTier: itemName => itemName.startsWith('stone_') ? 2 : 0
})

assert.strictEqual(inventory.formatItem({ name: 'bread', count: 3 }), '3x bread')
assert.deepStrictEqual(inventory.diffInventorySnapshots(
  new Map([['coal', 4]]),
  new Map([['coal', 7], ['bread', 1]])
), [{ name: 'bread', count: 1 }, { name: 'coal', count: 3 }])

assert.strictEqual(inventory.findInventoryItem('pao').name, 'bread')
assert.strictEqual(inventory.findInventoryItem('picareta').name, 'stone_pickaxe')
assert.strictEqual(inventory.hotbarSlotToInventorySlot(1), 36)
assert(inventory.describeHotbar().includes('1*:1x stone_pickaxe'))
assert(inventory.describeStatus().includes('vida 18/20'))
assert.strictEqual(inventory.inventoryCanReceiveAny(['coal']), true)
assert.strictEqual(inventory.inventoryCanReceiveAny(['diamond']), false)
assert(inventory.possibleDropNamesForBlock({ name: 'coal_ore' }).includes('coal'))

console.log('Inventory smoke test passou.')
