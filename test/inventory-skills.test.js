const test = require('node:test')
const assert = require('node:assert/strict')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')
const { createInventoryHelpers } = require('../inventory')
const { actionOk, actionFail, itemRequirement, suggestSkillAction } = require('../action-result')
const { createSkillRegistry, validateArgs } = require('../skills')

function createMockInventory () {
  const mcData = minecraftData('1.20.4')
  const catalog = createMinecraftCatalog(mcData)
  const items = [
    { name: 'stone_pickaxe', count: 1, stackSize: 1, slot: 36, type: 724, metadata: 0 },
    { name: 'bread', count: 3, stackSize: 64, slot: 10, type: 882, metadata: 0 },
    { name: 'coal', count: 16, stackSize: 64, slot: 11, type: 294, metadata: 0 },
    { name: 'dirt', count: 64, stackSize: 64, slot: 12, type: 32, metadata: 0 }
  ]
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
      items: () => items.filter(item => item.count > 0),
      emptySlotCount: () => 0,
      firstEmptyInventorySlot: () => null
    },
    equip: async (item) => {
      bot.heldItem = item
    },
    tossStack: async (item) => {
      item.count = 0
      if (item.slot != null) bot.inventory.slots[item.slot] = null
    },
    toss: async (type, metadata, amount) => {
      let remaining = amount
      for (const item of items) {
        if (item.type !== type || item.metadata !== metadata || remaining <= 0) continue
        const removed = Math.min(item.count, remaining)
        item.count -= removed
        remaining -= removed
        if (item.count <= 0 && item.slot != null) bot.inventory.slots[item.slot] = null
      }
    },
    moveSlotItem: async (fromSlot, toSlot) => {
      const item = items.find(candidate => candidate.slot === fromSlot)
      if (!item) throw new Error(`slot vazio: ${fromSlot}`)
      bot.inventory.slots[fromSlot] = null
      item.slot = toSlot
      bot.inventory.slots[toSlot] = item
    }
  }
  for (const item of items) bot.inventory.slots[item.slot] = item

  const inventory = createInventoryHelpers({
    getBot: () => bot,
    mcData,
    catalog,
    toolTier: itemName => itemName.startsWith('stone_') ? 2 : 0
  })

  return { inventory, bot }
}

test('inventario formata, diferencia snapshots e resolve aliases', () => {
  const { inventory } = createMockInventory()

  assert.equal(inventory.formatItem({ name: 'bread', count: 3 }), '3x bread')
  assert.deepEqual(inventory.diffInventorySnapshots(
    new Map([['coal', 4]]),
    new Map([['coal', 7], ['bread', 1]])
  ), [{ name: 'bread', count: 1 }, { name: 'coal', count: 3 }])

  assert.equal(inventory.findInventoryItem('pao').name, 'bread')
  assert.equal(inventory.findInventoryItem('picareta').name, 'stone_pickaxe')
  assert.equal(inventory.hotbarSlotToInventorySlot(1), 36)
})

test('inventario reporta hotbar/status e capacidade de receber itens', () => {
  const { inventory } = createMockInventory()

  assert.match(inventory.describeHotbar(), /1\*:1x stone_pickaxe/)
  assert.match(inventory.describeStatus(), /vida 18\/20/)
  assert.equal(inventory.inventoryCanReceiveAny(['coal']), true)
  assert.equal(inventory.inventoryCanReceiveAny(['diamond']), false)
  assert.equal(inventory.possibleDropNamesForBlock({ name: 'coal_ore' }).includes('coal'), true)
})

test('acoes estruturadas de inventario retornam ActionResult honesto', async () => {
  const { inventory, bot } = createMockInventory()

  const missingEquip = await inventory.equipItemAction('diamond')
  assert.equal(missingEquip.ok, false)
  assert.equal(missingEquip.code, 'item_not_found')
  assert.equal(missingEquip.retryable, true)
  assert.deepEqual(missingEquip.missingRequirements, [{ type: 'item', name: 'diamond', count: 1 }])

  const equip = await inventory.equipItemAction('pao')
  assert.equal(equip.ok, true)
  assert.equal(equip.code, 'equipped')
  assert.equal(bot.heldItem.name, 'bread')

  const invalidDrop = await inventory.dropItemAction('coal', 0)
  assert.equal(invalidDrop.ok, false)
  assert.equal(invalidDrop.code, 'invalid_amount')

  const drop = await inventory.dropItemAction('coal', 4)
  assert.equal(drop.ok, true)
  assert.equal(drop.code, 'dropped')
  assert.equal(drop.data.dropped, 4)
  assert.deepEqual(drop.inventoryDelta, [{ name: 'coal', before: 16, after: 12, delta: -4 }])

  const invalidSlot = await inventory.moveItemToHotbarAction(10, 'bread')
  assert.equal(invalidSlot.ok, false)
  assert.equal(invalidSlot.code, 'invalid_slot')

  const missingHotbar = await inventory.moveItemToHotbarAction(2, 'diamond')
  assert.equal(missingHotbar.ok, false)
  assert.equal(missingHotbar.code, 'item_not_found')

  const hotbar = await inventory.moveItemToHotbarAction(2, 'bread')
  assert.equal(hotbar.ok, true)
  assert.equal(hotbar.code, 'moved_to_hotbar')
  assert.equal(bot.inventory.slots[37].name, 'bread')
})

test('SkillRegistry usa resultados reais das skills de inventario', async () => {
  const { inventory } = createMockInventory()
  const registry = createSkillRegistry({ defaultContext: { bot: {}, reconnecting: false } })

  registry.register({
    id: 'inventory.equip',
    inputSchema: { item: 'string' },
    requires: ['botOnline'],
    run: ({ item }) => inventory.equipItemAction(item)
  })
  registry.register({
    id: 'inventory.drop',
    inputSchema: { item: 'string', amount: 'number optional' },
    requires: ['botOnline'],
    run: ({ item, amount = null }) => inventory.dropItemAction(item, amount)
  })
  registry.register({
    id: 'inventory.hotbar',
    inputSchema: { slot: 'number 1-9', item: 'string' },
    requires: ['botOnline'],
    run: ({ slot, item }) => inventory.moveItemToHotbarAction(slot, item)
  })

  const missingEquip = await registry.execute('inventory.equip', { item: 'diamond' })
  assert.equal(missingEquip.ok, false)
  assert.equal(missingEquip.code, 'item_not_found')

  const invalidDrop = await registry.execute('inventory.drop', { item: 'coal', amount: 0 })
  assert.equal(invalidDrop.ok, false)
  assert.equal(invalidDrop.code, 'invalid_amount')

  const invalidHotbar = await registry.execute('inventory.hotbar', { slot: 10, item: 'bread' })
  assert.equal(invalidHotbar.ok, false)
  assert.equal(invalidHotbar.code, 'validation_failed')

  const missingHotbar = await registry.execute('inventory.hotbar', { slot: 2, item: 'diamond' })
  assert.equal(missingHotbar.ok, false)
  assert.equal(missingHotbar.code, 'item_not_found')
})

test('ActionResult padroniza sucesso e falha', () => {
  const ok = actionOk('test.ok', 'feito', { value: 1 }, Date.now() - 5)
  assert.equal(ok.ok, true)
  assert.equal(ok.skill, 'test.ok')
  assert.equal(ok.code, 'ok')
  assert.equal(ok.severity, 'info')
  assert.equal(ok.retryable, false)
  assert.equal(ok.data.value, 1)
  assert.equal(ok.durationMs >= 0, true)

  const fail = actionFail('test.fail', 'falhou', {}, Date.now(), {
    code: 'missing_materials',
    retryable: true,
    missingRequirements: [itemRequirement('coal', 1)],
    suggestedNextActions: [suggestSkillAction('collection.collect', { target: 'coal' }, 'obter material faltante')]
  })
  assert.equal(fail.ok, false)
  assert.equal(fail.code, 'missing_materials')
  assert.equal(fail.retryable, true)
  assert.equal(fail.reason, 'falhou')
  assert.equal(fail.message, 'falhou')
  assert.deepEqual(fail.missingRequirements, [{ type: 'item', name: 'coal', count: 1 }])
  assert.equal(fail.suggestedNextActions[0].skill, 'collection.collect')
})

test('skill registry executa skills e padroniza skill ausente', async () => {
  const registry = createSkillRegistry()
  registry.register({
    id: 'demo.echo',
    description: 'eco',
    inputSchema: { text: 'string' },
    run: ({ text }) => actionOk('demo.echo', text, { text })
  })

  assert.equal(registry.get('demo.echo').id, 'demo.echo')
  assert.match(registry.describe(), /demo.echo/)

  const ok = await registry.execute('demo.echo', { text: 'ok' })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.text, 'ok')

  const missing = await registry.execute('missing.skill')
  assert.equal(missing.ok, false)
})

test('skill registry valida argumentos e pre-condicoes antes de executar', async () => {
  let executed = false
  const registry = createSkillRegistry()
  registry.register({
    id: 'demo.requires_bot',
    description: 'acao com contrato',
    inputSchema: { text: 'string', count: 'number optional max 3' },
    requires: ['botOnline'],
    effects: ['chat'],
    cost: { base: 2 },
    run: ({ text, count = 1 }) => {
      executed = true
      return actionOk('demo.requires_bot', text, { text, count })
    }
  })

  const invalid = await registry.execute('demo.requires_bot', { count: 4 }, { bot: {} })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'validation_failed')
  assert.equal(invalid.retryable, true)
  assert.match(invalid.reason, /text ausente/)
  assert.match(invalid.reason, /count deve ser <= 3/)
  assert.deepEqual(invalid.missingRequirements, [{ type: 'argument', name: 'text', expected: 'string' }])
  assert.equal(executed, false)

  const noBotPlan = await registry.plan('demo.requires_bot', { text: 'ok' })
  assert.equal(noBotPlan.ok, false)
  assert.equal(noBotPlan.code, 'precondition_failed')
  assert.match(noBotPlan.reason, /bot offline/)
  assert.deepEqual(noBotPlan.missingRequirements, [{ type: 'state', name: 'botOnline' }])

  const okPlan = await registry.plan('demo.requires_bot', { text: 'ok', count: 2 }, { bot: {} })
  assert.equal(okPlan.ok, true)
  assert.deepEqual(okPlan.effects, ['chat'])
  assert.equal(okPlan.cost.base, 2)

  const ok = await registry.execute('demo.requires_bot', { text: 'ok', count: 2 }, { bot: {} })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.text, 'ok')
  assert.equal(ok.data.plan.skill, 'demo.requires_bot')
  assert.equal(executed, true)
})

test('skill registry aplica timeout e validacao standalone', async () => {
  const validation = validateArgs({
    slot: 'number 1-9',
    mode: 'front|below'
  }, {
    slot: 10,
    mode: 'side'
  })

  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('; '), /slot deve ser <= 9/)
  assert.match(validation.errors.join('; '), /mode deve ser um de/)

  const registry = createSkillRegistry()
  registry.register({
    id: 'demo.timeout',
    timeoutMs: 5,
    run: () => new Promise(resolve => setTimeout(() => resolve(actionOk('demo.timeout')), 50))
  })

  const result = await registry.execute('demo.timeout')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'timeout')
  assert.equal(result.retryable, true)
  assert.match(result.reason, /timeout/)
})
