import { findClaudeMdCandidates, findSkillCandidates, writeSuggestions } from '../../promotions.js'
import type { Config } from '../../types.js'

export async function runPromotionSuggestions(config: Config, dryRun: boolean): Promise<void> {
  try {
    if (dryRun) {
      const [skillCandidates, claudeCandidates] = await Promise.all([
        findSkillCandidates(config),
        findClaudeMdCandidates(config)
      ])
      const skills = skillCandidates.length
      const claudeMd = claudeCandidates.length
      console.error(`[claude-memory] [DRY RUN] Would generate promotion suggestions: skills=${skills} claude-md=${claudeMd}`)
      return
    }

    const result = await writeSuggestions(config, process.cwd())
    const skills = result.skillFiles.length
    const claudeMd = result.claudeMdFiles.length
    console.error(`[claude-memory] Promotion suggestions: skills=${skills} claude-md=${claudeMd}`)

    for (const file of result.skillFiles) {
      console.error(`[claude-memory] Skill suggestion: ${file}`)
    }
    for (const file of result.claudeMdFiles) {
      console.error(`[claude-memory] CLAUDE.md suggestion: ${file}`)
    }
  } catch (error) {
    console.error('[claude-memory] Failed to generate promotion suggestions:', error)
  }
}
