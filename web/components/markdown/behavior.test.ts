import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { markdownNoteTarget, remarkWikilinks, wikiTarget, WIKILINK_PREFIX } from '../../lib/wikilinks'
import { remarkCallouts } from './callouts'

function render(content: string) {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkCallouts, remarkWikilinks],
    rehypePlugins: [rehypeSlug, [rehypeKatex, { trust: false }]],
    skipHtml: true, children: content,
  }))
  return parseHTML(`<html><body>${html}</body></html>`).document
}

describe('note link targets', () => {
  it('keeps qualified wikilinks, resolves explicit relative paths, and separates heading fragments', () => {
    expect(wikiTarget('wiki/한국어.md#첫 제목', 'wiki/current.md')).toEqual({ name: 'wiki/한국어.md', fragment: '첫-제목', local: false })
    expect(wikiTarget('../other/note#A Heading', 'wiki/sub/current.md')).toEqual({ name: 'wiki/other/note', fragment: 'a-heading', local: false })
    expect(wikiTarget('#Local heading', 'wiki/current.md')).toEqual({ name: 'wiki/current.md', fragment: 'local-heading', local: true })
    expect(wikiTarget('../../escape', 'wiki/current.md')).toBeNull()
    expect(wikiTarget('.git/config')).toBeNull()
  })

  it('resolves percent-encoded relative markdown paths without losing the fragment', () => {
    expect(markdownNoteTarget('../%ED%95%9C%EA%B8%80.md#%ED%95%9C%EA%B8%80%20%EC%A0%9C%EB%AA%A9', 'wiki/sub/current.md'))
      .toEqual({ path: 'wiki/한글.md', fragment: '한글-제목' })
    expect(markdownNoteTarget('/index.md#Intro', 'wiki/current.md')).toEqual({ path: 'index.md', fragment: 'intro' })
    expect(markdownNoteTarget('%2520.md#Details', 'wiki/current.md')).toEqual({ path: 'wiki/%20.md', fragment: 'details' })
  })

  it.each(['../../escape.md', 'https://outside.test/note.md', '//outside.test/note.md', '%2F%2Foutside.test/note.md', '.git/config.md', '..%2F.git/config.md', 'bad%ZZ.md', 'bad%5Cname.md'])('does not treat unsafe target %s as an internal note', (href) => {
    expect(markdownNoteTarget(href, 'wiki/current.md')).toBeNull()
  })
})

describe('rich markdown parsing', () => {
  it('renders wikilink aliases but leaves inline, indented, fenced code and existing links literal', () => {
    const document = render('[[wiki/Note.md#Heading|표시 제목]]\n\n`[[inline]]`\n\n    [[indented]]\n\n```md\n[[fenced]]\n> [!warning]- Not a callout\n```\n\n[existing [[literal]]](https://example.test)')
    const links = [...document.querySelectorAll('a')]
    expect(links.map((link) => [link.getAttribute('href'), link.textContent])).toEqual([
      [WIKILINK_PREFIX + encodeURIComponent('wiki/Note.md#Heading'), '표시 제목'],
      ['https://example.test', 'existing [[literal]]'],
    ])
    expect([...document.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      '[[inline]]', '[[indented]]\n', '[[fenced]]\n> [!warning]- Not a callout\n',
    ])
    expect(document.querySelector('details')).toBeNull()
  })

  it('preserves formatted callout titles and renders +/- folds with independent bodies', () => {
    const document = render('> [!warning]- **주의 제목**\n> 본문 [[Note]]\n>\n> 다음 문단\n\n> [!tip]+\n> 팁 본문\n\n> [!note] 정보\n> 일반 본문')
    const folds = [...document.querySelectorAll('details')]
    expect(folds.map((fold) => fold.hasAttribute('open'))).toEqual([false, true])
    expect(folds[0].querySelector('summary strong')?.textContent).toBe('주의 제목')
    expect(folds[0].querySelectorAll('p')[0].textContent).toBe('본문 Note')
    expect(folds[0].querySelectorAll('p')[1].textContent).toBe('다음 문단')
    expect(folds[1].querySelector('summary')?.textContent).toBe('팁')
    expect(document.querySelector('aside')?.getAttribute('data-callout')).toBe('note')
    expect(document.querySelector('p summary, p aside, p details')).toBeNull()
  })

  it('uses heading slugs matching link fragments and renders math while disabling raw HTML', () => {
    const document = render('## 한글 제목\n\n## 한글 제목\n\n$x^2$\n\n$$\nx^2 + y^2\n$$\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect([...document.querySelectorAll('h2')].map((heading) => heading.id)).toEqual(['한글-제목', '한글-제목-1'])
    expect(wikiTarget('#한글 제목', 'note.md')?.fragment).toBe(document.querySelector('h2')!.id)
    expect(document.querySelector('math')?.getAttribute('xmlns')).toBe('http://www.w3.org/1998/Math/MathML')
    expect(document.querySelector('.katex-display math')?.textContent).toContain('x2+y2')
    expect(document.querySelector('script, img, p .katex-display')).toBeNull()
  })
})
