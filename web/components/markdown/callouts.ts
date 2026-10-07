interface Node {
  type: string
  value?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const titles: Record<string, string> = {
  note: '노트', abstract: '요약', summary: '요약', tldr: '요약', info: '정보', todo: '할 일',
  tip: '팁', hint: '힌트', important: '중요', success: '성공', check: '확인', done: '완료',
  question: '질문', help: '도움말', faq: '자주 묻는 질문', warning: '주의', caution: '주의',
  attention: '주의', failure: '실패', fail: '실패', missing: '누락', danger: '위험', error: '오류',
  bug: '버그', example: '예시', quote: '인용', cite: '인용',
}

// Callouts are blockquotes in the parsed tree; code and raw HTML are never rewritten.
export function remarkCallouts() {
  return (tree: Node) => {
    function visit(node: Node) {
      if (['code', 'inlineCode', 'html'].includes(node.type)) return
      if (node.type === 'blockquote') {
        const paragraph = node.children?.[0]
        const first = paragraph?.children?.[0]
        const marker = first?.type === 'text' && first.value?.match(/^\[!([a-z][\w-]*)\]([+-])?[ \t]*/i)
        if (marker && first && paragraph?.children) {
          const kind = marker[1].toLowerCase()
          const title: Node[] = []
          const body: Node[] = []
          let afterTitle = false
          for (const [index, child] of paragraph.children.entries()) {
            const value = index === 0 ? first.value!.slice(marker[0].length) : child.value
            if (!afterTitle && child.type === 'text' && value?.includes('\n')) {
              const newline = value.indexOf('\n')
              if (newline > 0) title.push({ ...child, value: value.slice(0, newline) })
              if (newline + 1 < value.length) body.push({ ...child, value: value.slice(newline + 1) })
              afterTitle = true
            } else if (afterTitle) {
              body.push({ ...child, ...(value === undefined ? {} : { value }) })
            } else if (child.type === 'break') {
              afterTitle = true
            } else if (value !== '') {
              title.push({ ...child, ...(value === undefined ? {} : { value }) })
            }
          }
          const fold = marker[2]
          node.data = { hName: fold ? 'details' : 'aside', hProperties: {
            className: ['callout'], 'data-callout': kind, ...(fold === '+' ? { open: true } : {}),
          } }
          node.children = [
            { type: 'paragraph', data: { hName: fold ? 'summary' : 'div', hProperties: { className: ['callout-title'] } }, children: title.length ? title : [{ type: 'text', value: titles[kind] ?? '노트' }] },
            ...(body.length ? [{ ...paragraph, children: body }] : []),
            ...node.children!.slice(1),
          ]
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
