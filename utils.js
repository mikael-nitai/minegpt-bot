function parseCoords (parts) {
  if (parts.length < 3) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])

  if ([x, y, z].some(Number.isNaN)) return null
  return { x, y, z }
}

function createChatHelpers ({ getBot }) {
  function sendLongMessage (text) {
    const bot = getBot()
    const maxLength = 220

    if (text.length <= maxLength) {
      bot.chat(text)
      return
    }

    let rest = text
    while (rest.length > 0) {
      if (rest.length <= maxLength) {
        bot.chat(rest)
        return
      }

      const splitAt = rest.lastIndexOf(', ', maxLength)
      const cut = splitAt > 0 ? splitAt + 1 : maxLength
      bot.chat(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
  }

  return { sendLongMessage }
}

function wait (durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}

function withTimeout (promise, durationMs, label) {
  let timeout

  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(durationMs / 1000)}s`)), durationMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

function parsePositiveInteger (value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return null
  return number
}

function ownerMatchesFactory (owner) {
  return function ownerMatches (username) {
    return username && username.toLowerCase() === owner.toLowerCase()
  }
}

module.exports = {
  parseCoords,
  createChatHelpers,
  wait,
  withTimeout,
  parsePositiveInteger,
  ownerMatchesFactory
}
