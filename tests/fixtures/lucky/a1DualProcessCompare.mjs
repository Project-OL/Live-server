/**
 * Spawn current + baseline A1 runners and deep-diff normalized JSON artifacts.
 *
 * Run: node tests/fixtures/lucky/a1DualProcessCompare.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  A1_CASES,
  BASELINE_ROOT,
  EXPECT_DIFF_WHEN_FIX_TRUE,
  LIVE_SERVER_ROOT,
  NORMALIZED_KEYS,
  normalize,
} from './a1DualProcess.shared.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(__dirname, 'a1DualProcessRunner.mjs')
const ARTIFACT_DIR = join(__dirname, '_a1_dual_artifacts')
const RESULTS_PATH = join(__dirname, '_a1_dual_results.json')

function stripMeta(payload) {
  const { meta, ...rest } = payload
  return rest
}

function collectDiffs(a, b, path = '', diffs = []) {
  const na = normalize(a)
  const nb = normalize(b)
  if (JSON.stringify(na) === JSON.stringify(nb)) return diffs
  if (
    na === null ||
    nb === null ||
    typeof na !== 'object' ||
    typeof nb !== 'object' ||
    Array.isArray(na) !== Array.isArray(nb)
  ) {
    diffs.push({ path: path || '(root)', current: na, baseline: nb })
    return diffs
  }
  if (Array.isArray(na)) {
    const len = Math.max(na.length, nb.length)
    for (let i = 0; i < len; i++) {
      collectDiffs(na[i], nb[i], `${path}[${i}]`, diffs)
    }
    return diffs
  }
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)])
  for (const k of keys) {
    collectDiffs(na[k], nb[k], path ? `${path}.${k}` : k, diffs)
  }
  return diffs
}

function runSide(side, caseId, legacyFix, outPath) {
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      RUNNER,
      `--side=${side}`,
      `--case=${caseId}`,
      `--legacy-fix=${legacyFix}`,
      `--out=${outPath}`,
    ],
    {
      cwd: join(__dirname, '../../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IS_TEST: '1',
        NODE_PATH: join(LIVE_SERVER_ROOT, 'node_modules'),
        A1_BASELINE_ROOT: BASELINE_ROOT,
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  if (res.status !== 0) {
    throw new Error(
      `[${side}/${caseId}] runner failed (${res.status}): ${res.stderr || res.stdout}`,
    )
  }
  return JSON.parse(readFileSync(outPath, 'utf8'))
}

function compareCase(caseId, legacyFix) {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const currentPath = join(ARTIFACT_DIR, `${caseId}_fix-${legacyFix}_current.json`)
  const baselinePath = join(ARTIFACT_DIR, `${caseId}_fix-${legacyFix}_baseline.json`)

  const current = runSide('current', caseId, legacyFix, currentPath)
  const baseline = runSide('baseline', caseId, legacyFix, baselinePath)

  const diffs = collectDiffs(stripMeta(current), stripMeta(baseline))
  return {
    caseId,
    legacyFix,
    diffCount: diffs.length,
    diffs: diffs.slice(0, 40),
    truncated: diffs.length > 40,
    artifacts: { current: currentPath, baseline: baselinePath },
  }
}

function main() {
  const blockers = []
  const byFix = { false: [], true: [] }

  for (const legacyFix of ['false', 'true']) {
    for (const c of A1_CASES) {
      try {
        const row = compareCase(c.id, legacyFix)
        byFix[legacyFix === 'true' ? 'true' : 'false'].push(row)
      } catch (err) {
        blockers.push({ caseId: c.id, legacyFix, error: String(err.message || err) })
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    normalizedKeys: NORMALIZED_KEYS,
    baselineCommit: 'a838c93',
    currentHeadNote: 'Live-server HEAD should remain 61fb7ae (not modified by harness)',
    runs: byFix,
    expectations: {
      fixFalse: 'zero diffs on all cases except documented skips',
      fixTrue: `diffs only on: ${[...EXPECT_DIFF_WHEN_FIX_TRUE].join(', ')}`,
    },
    analysis: {
      fixFalse: byFix.false.map((r) => ({
        caseId: r.caseId,
        diffCount: r.diffCount,
        pass: r.diffCount === 0 || r.caseId === 'non_lucky_entry_paths',
      })),
      fixTrue: byFix.true.map((r) => ({
        caseId: r.caseId,
        diffCount: r.diffCount,
        pass:
          EXPECT_DIFF_WHEN_FIX_TRUE.has(r.caseId)
            ? r.diffCount > 0
            : r.diffCount === 0 || r.caseId === 'non_lucky_entry_paths',
      })),
    },
    blockers,
    resultsPath: RESULTS_PATH,
    artifactDir: ARTIFACT_DIR,
  }

  writeFileSync(RESULTS_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${RESULTS_PATH}`)
  console.log(JSON.stringify(summary.analysis, null, 2))
  if (blockers.length) {
    console.error('Blockers:', blockers)
    process.exitCode = 1
  }
}

main()
