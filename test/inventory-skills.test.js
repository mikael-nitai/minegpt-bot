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
