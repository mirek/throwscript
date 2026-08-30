// Packs every workspace package and installs the tarballs into a throwaway
// consumer project, then checks what a user would actually get: no
// `workspace:` ranges leaked into the manifests, no source/test files in the
// tarball, the `throwscript` bin runs, the core package imports, and the
// eslint plugin reports through a real eslint run.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pnpmCli = process.env.npm_execpath
if (!pnpmCli) throw new Error('pack-check must be run through pnpm')

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDirectories = ['packages/core', 'packages/cli', 'packages/eslint-plugin'].map(p => path.join(root, p))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
  return result
}

const pnpm = (args, cwd) => run(process.execPath, [pnpmCli, ...args], { cwd })

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'throwscript-pack-check-'))
const consumer = path.join(temporaryDirectory, 'consumer')

try {
  const tarballs = new Map()
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    console.log(`pack-check ${manifest.name}`)
    const destination = path.join(temporaryDirectory, path.basename(directory))
    const report = JSON.parse(pnpm(['pack', '--pack-destination', destination, '--json'], directory).stdout)
    const packed = Array.isArray(report) ? report[0] : report
    const files = packed.files.map(f => (typeof f === 'string' ? f : f.path).replace(/^package\//, ''))
    const tarball = path.join(destination, path.basename(packed.filename))

    const forbidden = files.filter(f => /^(src|test)\//.test(f) || /tsconfig.*\.json$/.test(f))
    if (forbidden.length > 0) {
      throw new Error(`${manifest.name} packs development-only files:\n${forbidden.join('\n')}`)
    }
    if (!files.includes('dist/index.js') && !files.includes('dist/main.js')) {
      throw new Error(`${manifest.name} packs no built entry point`)
    }
    const packedManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']).stdout)
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(packedManifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) {
          throw new Error(`${manifest.name} retains ${field}.${name}=${range} in its tarball`)
        }
      }
    }
    tarballs.set(manifest.name, tarball)
  }

  const dependencies = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [name, `file:${path.relative(consumer, tarball)}`])
  )
  run('mkdir', ['-p', consumer])
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'throwscript-consumer',
    private: true,
    type: 'module',
    dependencies: {
      ...dependencies,
      typescript: '^5.9.3',
      eslint: '^10.9.1',
      '@typescript-eslint/parser': '^8.68.0'
    }
  }, null, 2))
  // Route the CLI's dependency on core to the local tarball as well.
  writeFileSync(
    path.join(consumer, 'pnpm-workspace.yaml'),
    `overrides:\n${Object.entries(dependencies).map(([n, t]) => `  '${n}': '${t}'\n`).join('')}`
  )
  pnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer)

  writeFileSync(path.join(consumer, 'sample.ts'), 'export function boom(): void {\n  throw new Error("x");\n}\n')
  const version = pnpm(['exec', 'throwscript', '--version'], consumer).stdout.trim()
  if (!/^throwscript \d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${version}`)

  const check = spawnSync(process.execPath, [pnpmCli, 'exec', 'throwscript', 'sample.ts'], { cwd: consumer, encoding: 'utf8' })
  if (check.status !== 1 || !/'boom' can throw \{Error\}/.test(check.stdout)) {
    throw new Error(`throwscript did not report the sample throw (status ${check.status}):\n${check.stdout}${check.stderr}`)
  }

  writeFileSync(
    path.join(consumer, 'api.mjs'),
    'import { analyzeFiles, formatReport } from "@mirek/throwscript-core";\n' +
      'const d = analyzeFiles(["sample.ts"]);\n' +
      'if (d.length !== 1 || !formatReport(d).includes("boom")) throw new Error("core API check failed");\n'
  )
  run(process.execPath, ['api.mjs'], { cwd: consumer })

  writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    include: ['sample.ts']
  }))
  writeFileSync(
    path.join(consumer, 'eslint.config.mjs'),
    'import throwscript from "@mirek/eslint-plugin-throwscript";\n' +
      'import tsParser from "@typescript-eslint/parser";\n' +
      'export default [\n' +
      '  throwscript.configs.recommended,\n' +
      '  { files: ["**/*.ts"], languageOptions: { parser: tsParser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },\n' +
      '];\n'
  )
  const lint = spawnSync(process.execPath, [pnpmCli, 'exec', 'eslint', 'sample.ts'], { cwd: consumer, encoding: 'utf8' })
  if (lint.status !== 1 || !/'boom' can throw \{Error\}.*throwscript\/missing-throws/.test(lint.stdout)) {
    throw new Error(`eslint plugin did not report the sample throw (status ${lint.status}):\n${lint.stdout}${lint.stderr}`)
  }
  console.log('pack-check ok')
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
