/** Git 文本链接与原生链接必须读取同一配置，普通 YAML 标量不作为链接。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCordisConfig } from './read-cordis-config.ts'

describe('配置检查读取 Git 符号链接', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'freecode-config-link-'))
    execFileSync('git', ['init', '--quiet', root])
    mkdirSync(join(root, 'profiles'))
    writeFileSync(join(root, 'target.yml'), '- name: example\n')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  function link(file: string, target: string): void {
    writeFileSync(join(root, file), target)
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: target, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},${file}`], { cwd: root })
  }
  it('读取 Windows 文本链接以及连续链接的工作区内容', () => {
    link('profiles/cordis.yml', '../alias.yml')
    link('alias.yml', 'target.yml')
    expect(readCordisConfig(root, 'profiles/cordis.yml')).toBe('- name: example\n')
    writeFileSync(join(root, 'target.yml'), '[]\n')
    expect(readCordisConfig(root, 'profiles/cordis.yml')).toBe('[]\n')
  })
  it('不把未声明的普通文件或 YAML 标量当成链接', () => {
    writeFileSync(join(root, 'ordinary.yml'), 'target.yml')
    expect(readCordisConfig(root, 'ordinary.yml')).toBe('target.yml')
    expect(readCordisConfig(root, 'target.yml')).toBe('- name: example\n')
  })
  it('拒绝循环、越界及缺失目标', () => {
    link('a.yml', 'b.yml')
    link('b.yml', 'a.yml')
    expect(() => readCordisConfig(root, 'a.yml')).toThrow('循环')
    link('a.yml', '../outside.yml')
    expect(() => readCordisConfig(root, 'a.yml')).toThrow('仓库外')
    link('a.yml', 'missing.yml')
    expect(() => readCordisConfig(root, 'a.yml')).toThrow()
  })
  it.skipIf(process.platform === 'win32')('支持原生符号链接', () => {
    symlinkSync('../target.yml', join(root, 'profiles/cordis.yml'))
    expect(readCordisConfig(root, 'profiles/cordis.yml')).toBe('- name: example\n')
  })
})
