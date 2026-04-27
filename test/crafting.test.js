const test = require('node:test')
const assert = require('node:assert/strict')
const { plannedCraftRuns, plannedCraftOutput } = require('../crafting')

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
