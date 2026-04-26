const assert = require('assert')
const { plannedCraftRuns, plannedCraftOutput } = require('../crafting')

assert.strictEqual(plannedCraftRuns(4, 4), 1, '4 tochas com receita de 4 deve fazer 1 craft')
assert.strictEqual(plannedCraftOutput(4, 4), 4)

assert.strictEqual(plannedCraftRuns(1, 4), 1, '1 stick solicitado ainda precisa de 1 craft minimo')
assert.strictEqual(plannedCraftOutput(1, 4), 4)

assert.strictEqual(plannedCraftRuns(8, 4), 2, '8 sticks com receita de 4 deve fazer 2 crafts')
assert.strictEqual(plannedCraftOutput(8, 4), 8)

assert.strictEqual(plannedCraftRuns(5, 4), 2, '5 itens com receita de 4 precisa arredondar para 2 crafts')
assert.strictEqual(plannedCraftOutput(5, 4), 8)

assert.strictEqual(plannedCraftRuns(1, 1), 1)
assert.strictEqual(plannedCraftRuns(3, 1), 3)

console.log('Crafting smoke test passou.')
