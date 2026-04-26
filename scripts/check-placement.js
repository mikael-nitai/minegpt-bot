const assert = require('assert')
const { parsePlaceCommand } = require('../placement')

assert.deepStrictEqual(parsePlaceCommand('dirt'), {
  target: 'dirt',
  mode: 'front',
  raw: 'dirt'
})

assert.deepStrictEqual(parsePlaceCommand('cobblestone na frente'), {
  target: 'cobblestone',
  mode: 'front',
  raw: 'cobblestone na frente'
})

assert.deepStrictEqual(parsePlaceCommand('bloco abaixo'), {
  target: 'bloco',
  mode: 'below',
  raw: 'bloco abaixo'
})

assert.deepStrictEqual(parsePlaceCommand('dirt perto de mim'), {
  target: 'dirt',
  mode: 'near_owner',
  raw: 'dirt perto de mim'
})

assert.deepStrictEqual(parsePlaceCommand('cobblestone em -10 64 35'), {
  target: 'cobblestone',
  mode: 'coords',
  coords: { x: -10, y: 64, z: 35 },
  raw: 'cobblestone em -10 64 35'
})

assert.deepStrictEqual(parsePlaceCommand(''), {
  target: 'bloco',
  mode: 'front',
  raw: ''
})

console.log('placement ok')
