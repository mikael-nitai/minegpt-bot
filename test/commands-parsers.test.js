const test = require('node:test')
const assert = require('node:assert/strict')
const { parsePlaceCommand } = require('../placement')
const {
  isContainerBlockName,
  isContainerCommandText,
  parseContainerSearchCommand,
  parseContainerWithdrawCommand,
  parseContainerDepositCommand
} = require('../containers')
const { parseCoords, parsePositiveInteger, ownerMatchesFactory } = require('../utils')

test('parser de colocar blocos cobre modos suportados', () => {
  assert.deepEqual(parsePlaceCommand('dirt'), {
    target: 'dirt',
    mode: 'front',
    raw: 'dirt'
  })
  assert.deepEqual(parsePlaceCommand('cobblestone na frente'), {
    target: 'cobblestone',
    mode: 'front',
    raw: 'cobblestone na frente'
  })
  assert.deepEqual(parsePlaceCommand('bloco abaixo'), {
    target: 'bloco',
    mode: 'below',
    raw: 'bloco abaixo'
  })
  assert.deepEqual(parsePlaceCommand('dirt perto de mim'), {
    target: 'dirt',
    mode: 'near_owner',
    raw: 'dirt perto de mim'
  })
  assert.deepEqual(parsePlaceCommand('cobblestone em -10 64 35'), {
    target: 'cobblestone',
    mode: 'coords',
    coords: { x: -10, y: 64, z: 35 },
    raw: 'cobblestone em -10 64 35'
  })
})

test('parser de containers diferencia busca, retirada e deposito', () => {
  assert.equal(isContainerBlockName('chest'), true)
  assert.equal(isContainerBlockName('barrel'), true)
  assert.equal(isContainerBlockName('white_shulker_box'), true)
  assert.equal(isContainerBlockName('furnace'), false)
  assert.equal(isContainerCommandText('pegar ferro de bau'), true)
  assert.equal(isContainerCommandText('pegar drops'), false)

  assert.deepEqual(parseContainerSearchCommand('procurar carvao em baus proximos'), {
    target: 'carvao'
  })
  assert.deepEqual(parseContainerWithdrawCommand('pegar 3 ferro de bau'), {
    target: 'ferro',
    count: 3
  })
  assert.deepEqual(parseContainerWithdrawCommand('buscar picareta em container'), {
    target: 'picareta',
    count: 1
  })
  assert.deepEqual(parseContainerDepositCommand('guardar tudo'), {
    mode: 'all',
    target: null,
    count: null
  })
  assert.deepEqual(parseContainerDepositCommand('guardar 10 dirt'), {
    mode: 'target',
    target: 'dirt',
    count: 10
  })
})

test('utils validam coordenadas, inteiros positivos e dono', () => {
  assert.deepEqual(parseCoords(['1', '64', '-2']), { x: 1, y: 64, z: -2 })
  assert.equal(parseCoords(['1', 'x', '-2']), null)
  assert.equal(parsePositiveInteger('3'), 3)
  assert.equal(parsePositiveInteger('0'), null)
  assert.equal(parsePositiveInteger('1.5'), null)

  const ownerMatches = ownerMatchesFactory('NWintendo')
  assert.equal(ownerMatches('nwintendo'), true)
  assert.equal(ownerMatches('Outro'), false)
})
