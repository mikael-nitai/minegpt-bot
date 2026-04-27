const assert = require('assert')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')
const {
  isContainerBlockName,
  isContainerCommandText,
  parseContainerSearchCommand,
  parseContainerWithdrawCommand,
  parseContainerDepositCommand,
  classifyItemStorageRole,
  classifyContainerItems
} = require('../containers')

assert.strictEqual(isContainerBlockName('chest'), true)
assert.strictEqual(isContainerBlockName('barrel'), true)
assert.strictEqual(isContainerBlockName('ender_chest'), true)
assert.strictEqual(isContainerBlockName('white_shulker_box'), true)
assert.strictEqual(isContainerBlockName('copper_chest'), true)
assert.strictEqual(isContainerBlockName('furnace'), false)

assert.strictEqual(isContainerCommandText('pegar ferro de bau'), true)
assert.strictEqual(isContainerCommandText('pegar drops'), false)

assert.deepStrictEqual(parseContainerSearchCommand('procurar carvao em baus proximos'), {
  target: 'carvao'
})

assert.deepStrictEqual(parseContainerSearchCommand('procurar pão em baús próximos'), {
  target: 'pão'
})

assert.deepStrictEqual(parseContainerWithdrawCommand('pegar 3 ferro de bau'), {
  target: 'ferro',
  count: 3
})

assert.deepStrictEqual(parseContainerWithdrawCommand('buscar picareta em container'), {
  target: 'picareta',
  count: 1
})

assert.deepStrictEqual(parseContainerDepositCommand('guardar tudo'), {
  mode: 'all',
  target: null,
  count: null
})

assert.deepStrictEqual(parseContainerDepositCommand('guardar 10 dirt'), {
  mode: 'target',
  target: 'dirt',
  count: 10
})

const catalog = createMinecraftCatalog(minecraftData('1.20.4'))
assert.strictEqual(catalog.catalogBlockHasCategory('chest', 'container'), true)
assert.strictEqual(catalog.catalogBlockHasCategory('barrel', 'container'), true)
assert.strictEqual(catalog.catalogBlockHasCategory('white_shulker_box', 'container'), true)

assert.deepStrictEqual(classifyItemStorageRole('oak_log', catalog), {
  primaryRole: 'blocks',
  secondaryRole: 'wood',
  specificRole: 'oak'
})

assert.deepStrictEqual(classifyItemStorageRole('cobbled_deepslate', catalog), {
  primaryRole: 'blocks',
  secondaryRole: 'stone',
  specificRole: 'deepslate'
})

assert.deepStrictEqual(classifyContainerItems([
  { name: 'oak_log', count: 32 },
  { name: 'oak_planks', count: 32 }
], catalog), {
  primaryRole: 'blocks',
  secondaryRole: 'wood',
  specificRole: 'oak',
  confidence: 1,
  mixed: false,
  evidence: ['32x oak_log', '32x oak_planks']
})

assert.strictEqual(classifyContainerItems([
  { name: 'spruce_log', count: 40 },
  { name: 'oak_log', count: 10 }
], catalog).specificRole, 'spruce')

assert.strictEqual(classifyContainerItems([
  { name: 'cobblestone', count: 48 },
  { name: 'stone', count: 8 }
], catalog).specificRole, 'cobblestone')

assert.strictEqual(classifyContainerItems([
  { name: 'oak_log', count: 16 },
  { name: 'cobblestone', count: 16 }
], catalog).secondaryRole, 'mixed')

assert.strictEqual(classifyContainerItems([
  { name: 'name_tag', count: 1 }
], catalog).primaryRole, 'unknown')

console.log('containers ok')
