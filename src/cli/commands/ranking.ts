import chalk from 'chalk'
import ora from 'ora'
import Table from 'cli-table3'
import { GitCollector } from '../../git/git-collector'
import { GitParser } from '../../git/git-parser'
import { AnalyzeOptions } from '../index'
import { calculateTimeRange, getTerminalWidth } from '../../utils/terminal'
import { getIndexColor } from '../../utils/formatter'
import { GitLogOptions } from '../../types/git-types'

type TimeRangeMode = 'all-time' | 'custom' | 'auto-last-commit' | 'fallback'

interface AuthorRankingEntry {
  author: string
  commits: number
  index996: number
  indexText: string
  overtimeRate: number
  weekendRate: number
}

interface TimeRangeResult {
  since?: string
  until?: string
  mode: TimeRangeMode
  note?: string
}

export class RankingExecutor {
  static async execute(path: string, options: AnalyzeOptions): Promise<void> {
    try {
      const collector = new GitCollector()
      const { since, until, mode, note } = await resolveTimeRange({ collector, path, options })
      const limit = normalizeLimit(options.limit)
      const authorQuery = options.author?.trim()

      console.log(chalk.blue('🔍 卷王排行榜仓库:'), path || process.cwd())
      const periodText = buildPeriodText({ since, until, mode, note, options })
      console.log(chalk.blue('📅 时间范围:'), periodText)
      console.log()

      const authorList = await collector.listAuthors({ path, since, until, silent: true })

      if (authorList.length === 0) {
        console.log(chalk.yellow('🤷 仓库中没有可统计的提交者'))
        return
      }

      const filteredAuthors = filterAuthors(authorList, authorQuery)

      if (authorQuery && filteredAuthors.length === 0) {
        console.log(chalk.yellow(`未找到匹配作者: ${authorQuery}`))
        return
      }

      const limitedAuthors = authorQuery ? filteredAuthors : filteredAuthors.slice(0, limit)

      if (!authorQuery && authorList.length > limitedAuthors.length) {
        console.log(chalk.gray(`提示: 作者过多，默认仅统计提交数排名前 ${limit} 位。使用 --limit 可调整数量。`))
        console.log()
      }

      const spinner = ora('📦 正在计算卷王排行榜...').start()
      const ranking: AuthorRankingEntry[] = []

      for (const author of limitedAuthors) {
        spinner.text = `计算 ${author.label} 的 996 指数...`

        const authorPatternSource = author.email || author.name
        const authorOptions: GitLogOptions = {
          path,
          since,
          until,
          authorPattern: collector.createAuthorPattern(authorPatternSource),
          silent: true,
        }

        const rawData = await collector.collect(authorOptions)
        const parsedData = GitParser.parseGitData(rawData, undefined, since, until)
        const result = GitParser.calculate996Index(parsedData)
        const weekendCommits = parsedData.workWeekPl[1].count
        const weekendRate = rawData.totalCommits > 0 ? (weekendCommits / rawData.totalCommits) * 100 : 0

        ranking.push({
          author: author.label,
          commits: rawData.totalCommits,
          index996: result.index996,
          indexText: result.index996Str,
          overtimeRate: result.overTimeRadio,
          weekendRate,
        })
      }

      spinner.succeed('排行榜计算完成！')
      console.log()

      const sortedRanking = ranking.sort((a, b) => b.index996 - a.index996)
      printRankingTable(sortedRanking)
      printRankingSummary(sortedRanking)
    } catch (error) {
      console.error(chalk.red('❌ 排行榜生成失败:'), (error as Error).message)
      process.exit(1)
    }
  }
}

function printRankingTable(entries: AuthorRankingEntry[]): void {
  console.log(chalk.blue('📊 卷王排行榜:'))

  const terminalWidth = Math.min(getTerminalWidth(), 120)
  const baseWidths = [4, 32, 10, 12, 10, 14]
  const colWidths = scaleWidths(baseWidths, terminalWidth)

  const table = new Table({
    head: ['#', '作者', '提交数', '996指数', '加班率', '周末占比'],
    colWidths,
    style: { head: ['cyan'] },
    wordWrap: true,
  })

  entries.forEach((entry, index) => {
    const rankNumber = index + 1
    const rankLabel = formatRankLabel(rankNumber)
    const indexColor = getIndexColor(entry.index996)
    const overtimeColor = formatRiskColor(entry.overtimeRate)
    const weekendColor = formatRiskColor(entry.weekendRate)

    table.push([
      rankLabel,
      entry.author,
      entry.commits,
      indexColor(entry.index996.toFixed(1)),
      overtimeColor(`${entry.overtimeRate.toFixed(1)}%`),
      weekendColor(`${entry.weekendRate.toFixed(1)}%`),
    ])
  })

  console.log(table.toString())
  console.log()
}

function printRankingSummary(entries: AuthorRankingEntry[]): void {
  const totalAuthors = entries.length
  const totalCommits = entries.reduce((sum, item) => sum + item.commits, 0)
  const avg996 = totalAuthors > 0 ? entries.reduce((sum, item) => sum + item.index996, 0) / totalAuthors : 0

  const highest = entries[0]
  const lowest = entries[entries.length - 1]

  console.log(chalk.blue('🧾 统计摘要:'))
  console.log(`- 总提交者数量: ${totalAuthors}`)
  console.log(`- 总提交数: ${totalCommits}`)
  console.log(`- 平均 996 指数: ${avg996.toFixed(1)}`)

  if (highest) {
    console.log(`- 最高 996 指数: ${getIndexColor(highest.index996)(highest.index996.toFixed(1))} (${highest.author})`)
  }

  if (lowest) {
    console.log(`- 最低 996 指数: ${getIndexColor(lowest.index996)(lowest.index996.toFixed(1))} (${lowest.author})`)
  }

  console.log()
}

function formatRankLabel(rank: number): string {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return rank.toString().padStart(2, ' ')
}

function formatRiskColor(value: number): (text: string) => string {
  if (value <= 20) return chalk.green
  if (value <= 50) return chalk.yellow
  if (value <= 80) return chalk.keyword('orange')
  return chalk.red
}

type AuthorInfo = { name: string; email: string; label: string; count: number }

function filterAuthors(authors: AuthorInfo[], query?: string): AuthorInfo[] {
  if (!query) return authors

  const keyword = query.toLowerCase()
  return authors.filter((author) => {
    const name = author.name.toLowerCase()
    const email = author.email.toLowerCase()
    const label = author.label.toLowerCase()
    return name.includes(keyword) || email.includes(keyword) || label.includes(keyword)
  })
}

function normalizeLimit(limit?: number): number {
  const parsed = Number(limit)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), 500)
  }

  return 30
}

function scaleWidths(base: number[], terminalWidth: number): number[] {
  const borderOverhead = base.length + 1
  const available = Math.max(terminalWidth - borderOverhead, base.length * 3)
  const totalBase = base.reduce((sum, n) => sum + n, 0)
  const scale = available / totalBase

  const scaled = base.map((width) => Math.max(3, Math.floor(width * scale)))
  let sum = scaled.reduce((s, n) => s + n, 0)
  let index = 0

  while (sum < available) {
    scaled[index % scaled.length] += 1
    sum++
    index++
  }

  return scaled
}

interface ResolveTimeRangeParams {
  collector: GitCollector
  path: string
  options: AnalyzeOptions
}

async function resolveTimeRange({
  collector,
  path,
  options,
}: ResolveTimeRangeParams): Promise<TimeRangeResult> {
  if (options.allTime) {
    return { mode: 'all-time' }
  }

  if (options.year) {
    const yearRange = parseYearOption(options.year)
    if (yearRange) {
      return { ...yearRange, mode: 'custom' }
    }
  }

  if (options.since || options.until) {
    const fallback = calculateTimeRange(false)
    return {
      since: options.since || fallback.since,
      until: options.until || fallback.until,
      mode: 'custom',
    }
  }

  try {
    const lastCommitDate = await collector.getLastCommitDate({ path })
    if (lastCommitDate) {
      const untilDate = toUTCDate(lastCommitDate)
      const sinceDate = new Date(untilDate.getTime())
      sinceDate.setUTCDate(sinceDate.getUTCDate() - 365)

      const baseline = Date.UTC(1970, 0, 1)
      if (sinceDate.getTime() < baseline) {
        sinceDate.setTime(baseline)
      }

      return {
        since: formatUTCDate(sinceDate),
        until: formatUTCDate(untilDate),
        mode: 'auto-last-commit',
        note: '以最后一次提交为基准回溯365天',
      }
    }
  } catch {
    // ignore, fallback below
  }

  const fallback = calculateTimeRange(false)
  return {
    since: fallback.since,
    until: fallback.until,
    mode: 'fallback',
  }
}

function parseYearOption(yearStr: string): { since: string; until: string; note?: string } | null {
  yearStr = yearStr.trim()

  const rangeMatch = yearStr.match(/^(\d{4})-(\d{4})$/)
  if (rangeMatch) {
    const startYear = parseInt(rangeMatch[1], 10)
    const endYear = parseInt(rangeMatch[2], 10)

    if (startYear < 1970 || endYear < 1970 || startYear > endYear) {
      console.error(chalk.red('❌ 年份格式错误: 起始年份不能大于结束年份，且年份必须 >= 1970'))
      process.exit(1)
    }

    return {
      since: `${startYear}-01-01`,
      until: `${endYear}-12-31`,
      note: `${startYear}-${endYear}年`,
    }
  }

  const singleMatch = yearStr.match(/^(\d{4})$/)
  if (singleMatch) {
    const year = parseInt(singleMatch[1], 10)

    if (year < 1970) {
      console.error(chalk.red('❌ 年份格式错误: 年份必须 >= 1970'))
      process.exit(1)
    }

    return {
      since: `${year}-01-01`,
      until: `${year}-12-31`,
    }
  }

  console.error(chalk.red('❌ 年份格式错误: 请使用 "2025" 或 "2023-2025" 格式'))
  process.exit(1)
}

function toUTCDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map((part) => parseInt(part, 10))
  return new Date(Date.UTC(year, month - 1, day))
}

function formatUTCDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildPeriodText({
  since,
  until,
  mode,
  note,
  options,
}: TimeRangeResult & { options: AnalyzeOptions }): string {
  if (options.since && options.until) return `${options.since} 至 ${options.until}`
  if (options.since) return `从 ${options.since} 开始`
  if (options.until) return `截至 ${options.until}`
  if (options.allTime) return '所有时间'
  if (mode === 'auto-last-commit' && since && until) {
    return `${since} 至 ${until}${note ? `（${note}）` : ''}`
  }
  if (mode === 'fallback' && since && until) {
    return `${since} 至 ${until}（按当前日期回溯）`
  }
  if (since && until) return `${since} 至 ${until}`
  return '最近一年'
}
