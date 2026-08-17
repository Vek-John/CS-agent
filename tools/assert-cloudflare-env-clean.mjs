import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const root = process.cwd()
const app = resolve(root, 'apps/web')
const sensitiveName = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i
const envNames = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
]

function sensitiveEntries(values) {
  return Object.entries(values)
    .filter(([key, value]) => sensitiveName.test(key) && String(value).trim())
    .map(([key]) => key)
}

function assertSourceEnvFiles() {
  const violations = []
  for (const directory of [root, app]) {
    for (const name of envNames) {
      const file = resolve(directory, name)
      if (!existsSync(file)) continue
      const keys = sensitiveEntries(parseEnv(readFileSync(file, 'utf8')))
      if (keys.length) violations.push(`${file}: ${keys.join(', ')}`)
    }
  }
  if (violations.length) {
    throw new Error(
      `[cloudflare-env] local secret found in a Next/OpenNext env file:\n${violations.join('\n')}\n` +
      'Move local DeepSeek values to .local-data/deepseek.env; Cloudflare uses Worker Secrets.',
    )
  }
}

function assertCompiledEnvFile() {
  const file = resolve(app, '.open-next/cloudflare/next-env.mjs')
  if (!existsSync(file)) throw new Error(`[cloudflare-env] missing build artifact: ${file}`)
  const violations = []
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    const json = line.slice(line.indexOf('=') + 1).trim().replace(/;$/, '')
    if (!json || json === line.trim()) continue
    const keys = sensitiveEntries(JSON.parse(json))
    if (keys.length) violations.push(`line ${index + 1}: ${keys.join(', ')}`)
  }
  if (violations.length) {
    throw new Error(`[cloudflare-env] generated bundle contains local secrets:\n${violations.join('\n')}`)
  }
}

assertSourceEnvFiles()
if (process.argv.includes('--bundle')) assertCompiledEnvFile()
process.stdout.write(`[cloudflare-env] ${process.argv.includes('--bundle') ? 'source and bundle' : 'source'} secret check passed\n`)
