/** 配置检查兼容 core.symlinks=false 的 Git 工作区。 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 读取工作区配置，仅跟随原生链接或 Git 索引明确声明的文本链接。
 * @param root - Git 仓库根目录。
 * @param file - 仓库相对配置路径。
 * @returns 最终目标的当前工作区文本。
 * @throws 链接循环、仓库外目标或不可读取的目标。
 */
export function readCordisConfig(root: string, file: string): string {
  const repo = realpathSync(root)
  const seen = new Set<string>()
  let path = resolve(repo, file)
  for (;;) {
    const local = relative(repo, path)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`配置链接指向仓库外：${file}`)
    if (seen.has(path)) throw new Error(`配置链接循环：${file}`)
    seen.add(path)
    if (lstatSync(path).isSymbolicLink()) {
      path = resolve(dirname(path), readlinkSync(path))
      continue
    }
    const canonical = realpathSync(path)
    if (canonical !== path) {
      path = canonical
      continue
    }
    const text = readFileSync(path, 'utf8')
    // 普通 YAML 不需要查询 Git；单行路径也必须经过索引模式确认。
    if (/^[^\r\n]+\.ya?ml(?:\r?\n)?$/.test(text)) {
      const entries = execFileSync('git', ['ls-files', '--stage', '-z', '--', local], { cwd: repo, encoding: 'utf8' })
      if (entries.startsWith('120000 ')) {
        path = resolve(dirname(path), text.trimEnd())
        continue
      }
    }
    return text
  }
}
