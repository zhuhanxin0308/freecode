/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rewriteVendorNames } from './rescope-vendor.ts'

describe('保留产品标识并检查包引用', () => {
  const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
  it('保留预设和事件名', () => {
    expect(rewriteVendorNames("const preset = 'cordis'", file)).toBe("const preset = 'cordis'")
    expect(rewriteVendorNames("ctx.on('cordis/inspect-query', handler)", 'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts'))
      .toBe("ctx.on('cordis/inspect-query', handler)")
    expect(rewriteVendorNames("    name: 'cordis/inspect-query',", 'packages/extensions/tool-cordis/src/api-catalog.ts'))
      .toBe("    name: 'cordis/inspect-query',")
  })
  it.each(["import { Context } from 'cordis'", "export * from 'cordis'", "declare module 'cordis'", "import('cordis')", "require('cordis')"])(
    '仍改写真实模块引用：%s', (source) => {
      expect(rewriteVendorNames(source, file)).toBe(source.replace("'cordis'", "'@deepseek-ai/cordis'"))
    },
  )
  it('仅保留 YAML 中的产品说明，仍检查插件名称', () => {
    const file = 'packages/bundle/web-app/cordis.patch.yml'
    expect(rewriteVendorNames('# preset: `cordis`\n- name: cordis\n', file))
      .toBe('# preset: `cordis`\n- name: @deepseek-ai/cordis\n')
  })
})

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})
