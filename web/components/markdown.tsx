'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { noteHref } from '@/components/common'
import { markdownNoteHref, remarkWikilinks, WIKILINK_PREFIX } from '@/lib/wikilinks'

function WikiLink({ name, children }: { name: string; children: ReactNode }) {
  const resolved = useQuery({
    queryKey: ['notes/resolve', name],
    queryFn: () => api.resolve(name),
    retry: false,
    staleTime: 60_000,
  })

  if (resolved.data) {
    return <Link href={noteHref(resolved.data.path)} className="underline underline-offset-4 hover:text-foreground">{children}</Link>
  }
  return (
    <span
      className="text-muted-foreground underline decoration-dotted underline-offset-4"
      aria-busy={resolved.isPending || undefined}
      title={resolved.isError ? `노트를 찾을 수 없습니다: ${name}` : `노트 링크 확인 중: ${name}`}
    >
      {children}
    </span>
  )
}

export function Markdown({ content, path }: { content: string; path?: string }) {
  return (
    <div className="markdown min-w-0 [&_input]:mr-2 [&_input]:accent-neutral-900 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilinks]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>
            if (href.startsWith(WIKILINK_PREFIX)) {
              let name: string
              try {
                name = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
              } catch {
                return <span>{children}</span>
              }
              return <WikiLink name={name} key={name}>{children}</WikiLink>
            }
            const noteLink = markdownNoteHref(href, path)
            if (noteLink) return <Link href={noteLink} className="underline underline-offset-4 hover:text-muted-foreground">{children}</Link>
            // Non-note relative links cannot escape to engine routes; fragments stay local.
            if (!/^(https?:|mailto:|#)/i.test(href)) return <span>{children}</span>
            return <a href={href} className="underline underline-offset-4 hover:text-muted-foreground" rel="noopener noreferrer">{children}</a>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
