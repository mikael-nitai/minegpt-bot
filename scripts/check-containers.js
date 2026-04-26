const assert = require('assert')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')
const {
  isContainerBlockName,
  isContainerCommandText,
  parseContainerSearchCommand,
  parseContainerWithdrawCommand,
  parseContainerDepositCommand
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

console.log('containers ok')
