import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SW_FILE = new URL('../sw.js', import.meta.url).pathname
function shortSha() {
  const fromEnv = (process.env.COMMIT_REF || '').trim()
  if (fromEnv) return fromEnv.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() }
  catch { return new Date().toISOString().slice(0, 10).replace(/-/g, '') }
}
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const version = `iskanner-${shortSha()}-${stamp}`
const src = readFileSync(SW_FILE, 'utf8')
const next = src.replace(/const CACHE_NAME = '[^']+'/, `const CACHE_NAME = '${version}'`)
if (next === src) throw new Error('[bump-sw] no CACHE_NAME found in sw.js')
writeFileSync(SW_FILE, next)
console.log(`[bump-sw] cache version -> ${version}`)
