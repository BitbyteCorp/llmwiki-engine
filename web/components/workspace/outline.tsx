'use client'

import { useEffect, useState, type RefObject } from 'react'

type Heading = { element: HTMLHeadingElement; id: string; title: string; level: number }

export function Outline({ contentRef, scrollerRef, revision }: {
  contentRef: RefObject<HTMLDivElement | null>
  scrollerRef: RefObject<HTMLDivElement | null>
  revision: string
}) {
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState('')

  useEffect(() => {
    const content = contentRef.current
    const scroller = scrollerRef.current
    if (!content || !scroller) return
    let collected: Heading[] = []
    let frame = 0
    const updateActive = () => {
      frame = 0
      const top = scroller.getBoundingClientRect().top + 32
      let current = collected[0]
      for (const heading of collected) {
        if (heading.element.getBoundingClientRect().top > top) break
        current = heading
      }
      setActive(current?.id ?? '')
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(updateActive) }
    const intersection = new IntersectionObserver(schedule, { root: scroller, threshold: [0, 1], rootMargin: '0px 0px -65% 0px' })
    const collect = () => {
      intersection.disconnect()
      collected = Array.from(content.querySelectorAll<HTMLHeadingElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')).map(element => ({
        element, id: element.id, title: element.textContent?.trim() || '제목 없음', level: Number(element.tagName.slice(1)),
      }))
      setHeadings(collected)
      for (const heading of collected) intersection.observe(heading.element)
      schedule()
    }
    collect()
    const mutation = new MutationObserver(collect)
    mutation.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id'] })
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      mutation.disconnect()
      intersection.disconnect()
      scroller.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [contentRef, scrollerRef, revision])

  function navigate(heading: Heading) {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollTop + heading.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 })
    heading.element.setAttribute('tabindex', '-1')
    heading.element.focus({ preventScroll: true })
    heading.element.addEventListener('blur', () => heading.element.removeAttribute('tabindex'), { once: true })
    setActive(heading.id)
  }

  if (!headings.length) return null
  const minimumLevel = Math.min(...headings.map(heading => heading.level))
  return (
    <details className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer rounded text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">목차</summary>
      <nav aria-label="노트 목차" className="mt-2 max-h-52 overflow-y-auto">
        <ol className="space-y-0.5">{headings.map(heading => <li key={heading.id}><button type="button" aria-current={active === heading.id ? 'location' : undefined} onClick={() => navigate(heading)} style={{ paddingLeft: `${(heading.level - minimumLevel) * 12 + 8}px` }} className={`w-full break-words rounded py-1.5 pr-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring ${active === heading.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{heading.title}</button></li>)}</ol>
      </nav>
    </details>
  )
}
