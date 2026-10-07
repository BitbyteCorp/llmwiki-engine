'use client'

import { useEffect, useId, useState } from 'react'
import { useTheme } from 'next-themes'

// Mermaid configuration is global. Serialize initialization + rendering so adjacent
// light/dark diagrams cannot render with another diagram's configuration.
let renderQueue: Promise<unknown> = Promise.resolve()

export default function MermaidDiagram({ source }: { source: string }) {
  const { resolvedTheme } = useTheme()
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [result, setResult] = useState<{ source: string; theme: string; svg?: string; error?: string } | null>(null)
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'

  useEffect(() => {
    let canceled = false
    const task = renderQueue.catch(() => undefined).then(async () => {
      if (canceled) return
      // Client-only lazy loading: Mermaid's DOM dependency must not run in SSR.
      const mermaid = (await import('mermaid')).default
      const tokens = getComputedStyle(document.documentElement)
      const color = (name: string) => tokens.getPropertyValue(`--${name}`).trim()
      const foreground = color('foreground')
      const background = color('background')
      const border = color('border')
      const muted = color('muted')
      const card = color('card')
      const line = color('muted-foreground')
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        theme: 'base',
        themeVariables: {
          darkMode: theme === 'dark',
          background, textColor: foreground,
          primaryColor: muted, primaryTextColor: foreground, primaryBorderColor: border,
          secondaryColor: card, secondaryTextColor: foreground, secondaryBorderColor: border,
          tertiaryColor: color('accent'), tertiaryTextColor: foreground, tertiaryBorderColor: border,
          lineColor: line, mainBkg: muted, nodeBorder: border,
          clusterBkg: card, clusterBorder: border, titleColor: foreground, edgeLabelBackground: background,
          actorBkg: card, actorBorder: border, actorTextColor: foreground, actorLineColor: line,
          signalColor: foreground, signalTextColor: foreground,
          labelBoxBkgColor: card, labelBoxBorderColor: border, labelTextColor: foreground, loopTextColor: foreground,
          noteBkgColor: muted, noteBorderColor: border, noteTextColor: foreground,
          activationBkgColor: color('accent'), activationBorderColor: border,
          sequenceNumberColor: color('primary-foreground'),
        },
      })
      // Strict security sanitizes Mermaid's SVG, disables HTML/click directives,
      // and protects secure configuration from overrides in note source.
      const { svg } = await mermaid.render(`wiki-mermaid-${id}`, source)
      if (!canceled) setResult({ source, theme, svg })
    })
    renderQueue = task
    void task.catch((error: unknown) => {
      if (!canceled) setResult({ source, theme, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { canceled = true }
  }, [id, source, theme])

  const current = result?.source === source && result.theme === theme ? result : null
  return (
    <div className="mermaid-diagram">
      {current?.svg ? <div role="img" aria-label="Mermaid 다이어그램" dangerouslySetInnerHTML={{ __html: current.svg }} />
        : current?.error ? <p role="alert">다이어그램을 표시할 수 없습니다: {current.error}</p>
          : <p role="status">다이어그램을 그리는 중입니다.</p>}
      <details open={Boolean(current?.error)}><summary>다이어그램 원문</summary><pre><code>{source}</code></pre></details>
    </div>
  )
}
