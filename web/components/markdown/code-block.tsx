'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'

// Mermaid depends on the browser DOM; never evaluate its module during SSR.
const MermaidDiagram = dynamic(() => import('./mermaid'), { ssr: false, loading: () => <p role="status">다이어그램을 불러오는 중입니다.</p> })

export function CodeBlock({ source, language, children }: { source: string; language?: string; children: ReactNode }) {
  const [copiedSource, setCopiedSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>{language || '일반 텍스트'}</span><button type="button" aria-label="코드 복사" onClick={async () => {
        try {
          await navigator.clipboard.writeText(source)
          setCopiedSource(source)
          setError(null)
        } catch {
          setCopiedSource(null)
          setError('코드를 복사하지 못했습니다. 원문을 선택해 복사해 주세요.')
        }
      }}>{copiedSource === source ? '복사됨' : '복사'}</button></div>
      {error && <p role="alert">{error}</p>}
      {language?.toLowerCase() === 'mermaid' ? <MermaidDiagram source={source} /> : <pre>{children}</pre>}
      <span className="sr-only" role="status">{copiedSource === source ? '코드를 복사했습니다.' : ''}</span>
    </div>
  )
}
