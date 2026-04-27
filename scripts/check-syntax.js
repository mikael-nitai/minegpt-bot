const { readdirSync, statSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')

const root = process.cwd()
const ignoredDirs = new Set(['.git', 'node_modules'])
const files = []

function collectJsFiles (dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      collectJsFiles(fullPath)
    } else if (entry.endsWith('.js')) {
      files.push(fullPath)
    }
  }
}

collectJsFiles(root)

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.status || 1)
  }
}

console.log(`Syntax check ok: ${files.length} arquivo(s).`)
