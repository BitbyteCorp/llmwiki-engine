// Browser-safe mirror of src/knowledge/note-metadata.ts, which imports Node-only modules.
export const NOTE_TYPES = ['hub', 'concept', 'entity', 'guide', 'decision', 'reference', 'project', 'note'] as const
export type NoteType = (typeof NOTE_TYPES)[number]
export const DESCRIPTION_MAX_CHARS = 300

export function expectedNoteType(path: string): NoteType | null {
  if (path.startsWith('wiki/concepts/')) return 'concept'
  if (path.startsWith('wiki/entities/')) return 'entity'
  return /^wiki\/[^/]+\/index\.md$/.test(path) ? 'hub' : null
}

export function newNoteContent(input: { path: string; title: string; type: NoteType; description: string; aliases: string; tags: string }): string {
  const title = input.title.trim()
  if (!title) throw new Error('노트 제목을 입력하세요.')
  const description = input.description.trim()
  if (!description) throw new Error('노트 설명을 입력하세요.')
  if (description.length > DESCRIPTION_MAX_CHARS) throw new Error(`노트 설명은 ${DESCRIPTION_MAX_CHARS}자 이하여야 합니다.`)
  const tags = [...new Set(input.tags.split(',').map(tag => tag.trim()).filter(Boolean))]
  if (!tags.length) throw new Error('태그를 하나 이상 입력하세요.')
  const invalidTags = tags.filter(tag => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))
  if (invalidTags.length) throw new Error(`태그는 영어 소문자·숫자를 하이픈(-)으로 연결하세요: ${invalidTags.join(', ')}`)
  const type = expectedNoteType(input.path) ?? input.type
  const aliases = [...new Set(input.aliases.split(',').map(alias => alias.trim()).filter(Boolean))]
  return `---\ntype: ${type}\naliases: ${JSON.stringify(aliases)}\ndescription: ${JSON.stringify(description)}\ntags: ${JSON.stringify(tags)}\n---\n\n# ${title}\n\n`
}
