const test = require('node:test')
const assert = require('node:assert/strict')
const {
  plannedCraftRuns,
  plannedCraftOutput,
  missingRequirementsForCrafting,
  suggestedActionsForMissingCraftingItems
} = require('../crafting')

test('crafting converte quantidade desejada em execucoes de receita', () => {
  assert.equal(plannedCraftRuns(4, 4), 1)
  assert.equal(plannedCraftOutput(4, 4), 4)
  assert.equal(plannedCraftRuns(8, 4), 2)
  assert.equal(plannedCraftOutput(8, 4), 8)
  assert.equal(plannedCraftRuns(5, 4), 2)
  assert.equal(plannedCraftOutput(5, 4), 8)
})

test('crafting respeita craft minimo mesmo quando receita entrega mais que pedido', () => {
  assert.equal(plannedCraftRuns(1, 4), 1)
  assert.equal(plannedCraftOutput(1, 4), 4)
  assert.equal(plannedCraftRuns(1, 1), 1)
  assert.equal(plannedCraftRuns(3, 1), 3)
})

test('crafting converte materiais faltantes em requisitos e proximas acoes', () => {
  const missing = [{ name: 'coal', needed: 1, available: 0, missing: 1 }]

  assert.deepEqual(missingRequirementsForCrafting(missing), [
    { type: 'item', name: 'coal', count: 1, needed: 1, available: 0 }
  ])

  const suggestions = suggestedActionsForMissingCraftingItems(missing)
  assert.equal(suggestions.length, 2)
  assert.deepEqual(suggestions[0], {
    type: 'skill',
    skill: 'containers.withdraw',
    args: { target: 'coal', count: 1 },
    reason: 'buscar coal em containers conhecidos'
  })
  assert.equal(suggestions[1].skill, 'collection.collect')
})
