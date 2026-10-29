// Synchronizes the single user-facing version field from package.json.
// The operation is intentionally idempotent and fails closed if index.html
// does not contain exactly one version field.
import { readFileSync, writeFileSync } from 'node:fs'

const PACKAGE_FILE = new URL('../package.json', import.meta.url)
const INDEX_FILE = new URL('../index.html', import.meta.url)
const packageJson = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'))
const version = String(packageJson.version || '').trim()

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('[sync-version] package.json must contain a valid semver version')
}

const source = readFileSync(INDEX_FILE, 'utf8')
const versionFieldPattern = /(<span\b[^>]*\bclass=["'][^"']*\bversion\b[^"']*["'][^>]*>\s*V?)([^<]*)(<\/span>)/gi
const matches = [...source.matchAll(versionFieldPattern)]

if (matches.length !== 1) {
  throw new Error(`[sync-version] expected exactly one .version field in index.html, found ${matches.length}`)
}

const next = source.replace(versionFieldPattern, (_match, prefix, _oldVersion, suffix) => {
  const normalizedPrefix = prefix.replace(/V$/i, '')
  return `${normalizedPrefix}V${version}${suffix}`
})
writeFileSync(INDEX_FILE, next)
console.log(`[sync-version] app version -> ${version}`)
