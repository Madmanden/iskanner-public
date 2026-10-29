// Finds duplicate part numbers in parts-database.js.
// In an object literal the last occurrence silently wins, so editing an
// earlier duplicate has no effect. Conflicting duplicates (same key,
// different location) are the dangerous case.
//
// Run: node scripts/check-parts-duplicates.mjs [--strict] [--report <file.md>]
//   --strict  exit 1 when conflicting duplicates exist
//   --report  write a Markdown list of all duplicates for manual review
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ENTRY_PATTERN = /^\s*'([^']+)'\s*:\s*'([^']*)'/

export function findDuplicateParts(source) {
  const occurrences = new Map()
  source.split('\n').forEach((line, index) => {
    const match = ENTRY_PATTERN.exec(line)
    if (!match) return
    const [, key, value] = match
    if (!occurrences.has(key)) occurrences.set(key, [])
    occurrences.get(key).push({ line: index + 1, value })
  })

  const conflicting = []
  const identical = []
  for (const [key, entries] of occurrences) {
    if (entries.length < 2) continue
    const distinctValues = new Set(entries.map((entry) => entry.value))
    const duplicate = { key, entries, effectiveValue: entries.at(-1).value }
    ;(distinctValues.size > 1 ? conflicting : identical).push(duplicate)
  }
  return { conflicting, identical }
}

function formatReport({ conflicting, identical }, sourceName) {
  const lines = [
    '# Dublerede varenumre i parts-database.js',
    '',
    `Genereret af \`scripts/check-parts-duplicates.mjs\` fra \`${sourceName}\`.`,
    'Den sidste forekomst er den, appen faktisk bruger.',
    '',
    `## Konflikter (${conflicting.length})`,
    '',
    'Samme varenummer med forskellige placeringer. Skal afklares manuelt.',
    '',
    '| Varenummer | Forekomster (linje: placering) | Gælder nu |',
    '| --- | --- | --- |',
  ]
  for (const { key, entries, effectiveValue } of conflicting) {
    const all = entries.map((entry) => `${entry.line}: \`${entry.value}\``).join('<br>')
    lines.push(`| \`${key}\` | ${all} | \`${effectiveValue}\` |`)
  }
  lines.push(
    '',
    `## Identiske dubletter (${identical.length})`,
    '',
    'Samme varenummer og samme placering. Kan fjernes uden at ændre opslag.',
    '',
  )
  for (const { key, entries } of identical) {
    lines.push(`- \`${key}\` (linje ${entries.map((entry) => entry.line).join(', ')})`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const jsFile = join(root, 'parts-database.js')
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const reportIndex = args.indexOf('--report')

  const result = findDuplicateParts(readFileSync(jsFile, 'utf8'))
  const { conflicting, identical } = result
  console.log(
    `[check-parts-duplicates] conflicting: ${conflicting.length}, identical: ${identical.length}`,
  )

  if (reportIndex !== -1) {
    const reportFile = join(process.cwd(), args[reportIndex + 1])
    writeFileSync(reportFile, formatReport(result, relative(root, jsFile)))
    console.log(`[check-parts-duplicates] report written to ${relative(root, reportFile)}`)
  }

  if (conflicting.length > 0) {
    const message = strict ? 'ERROR' : 'WARNING'
    console.log(`[check-parts-duplicates] ${message}: conflicting part numbers:`)
    for (const { key, entries } of conflicting) {
      console.log(`  ${key}: ${entries.map((entry) => `L${entry.line}=${entry.value}`).join(' | ')}`)
    }
    if (strict) process.exit(1)
  }
}
