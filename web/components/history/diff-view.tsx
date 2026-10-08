"use client"

import { useEffect, useId, useMemo, useState } from "react"
import { createTwoFilesPatch, diffWordsWithSpace, parsePatch, type StructuredPatch } from "diff"
import { Button } from "@/components/ui/button"
import styles from "./history.module.css"

type Mode = "split" | "unified"
type Row = { old?: number; next?: number; left?: string; right?: string; kind: "context" | "change" }

function rowsFor(hunk: StructuredPatch["hunks"][number]): Row[] {
  const rows: Row[] = []
  let old = hunk.oldStart, next = hunk.newStart
  for (let i = 0; i < hunk.lines.length;) {
    const line = hunk.lines[i]
    if (line.startsWith("\\")) { i++; continue }
    if (line.startsWith(" ")) { rows.push({ old: old++, next: next++, left: line.slice(1), right: line.slice(1), kind: "context" }); i++; continue }
    const removed: string[] = [], added: string[] = []
    while (i < hunk.lines.length && (hunk.lines[i].startsWith("-") || hunk.lines[i].startsWith("\\"))) {
      const removedLine = hunk.lines[i++]
      if (removedLine.startsWith("-")) removed.push(removedLine.slice(1))
    }
    while (i < hunk.lines.length && (hunk.lines[i].startsWith("+") || hunk.lines[i].startsWith("\\"))) {
      const addedLine = hunk.lines[i++]
      if (addedLine.startsWith("+")) added.push(addedLine.slice(1))
    }
    if (!removed.length && !added.length) { i++; continue }
    for (let n = 0; n < Math.max(removed.length, added.length); n++) rows.push({ old: n < removed.length ? old++ : undefined, next: n < added.length ? next++ : undefined, left: removed[n], right: added[n], kind: "change" })
  }
  return rows
}

function Words({ text, other, added }: { text: string; other?: string; added: boolean }) {
  if (other === undefined || text.length + other.length > 12000) return <>{text || " "}</>
  const parts = diffWordsWithSpace(added ? other : text, added ? text : other)
  return <>{parts.filter(p => added ? !p.removed : !p.added).map((p, i) => <span key={i} className={p.added || p.removed ? styles.word : undefined}>{p.value}</span>)}</>
}

function Hunk({ hunk, mode }: { hunk: StructuredPatch["hunks"][number]; mode: Mode }) {
  const rows = useMemo(() => rowsFor(hunk), [hunk])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const result = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === "context" && (i === 0 || rows[i - 1].kind !== "context")) {
      let end = i
      while (end < rows.length && rows[end].kind === "context") end++
      if (end - i > 8 && !expanded.has(i)) {
        const start = i
        result.push(<tr key={`fold-${i}`}><td colSpan={mode === "split" ? 4 : 3} className={styles.fold}><Button size="sm" variant="ghost" onClick={() => setExpanded(s => new Set(s).add(start))}>변경 없는 {end - i}줄 펼치기</Button></td></tr>)
        i = end - 1
        continue
      }
    }
    if (mode === "split") result.push(<tr key={i}><td className={styles.number}>{row.old}</td><td className={row.kind === "change" && row.left !== undefined ? styles.removed : undefined}>{row.left !== undefined && <Words text={row.left} other={row.kind === "change" ? row.right : undefined} added={false}/>}</td><td className={styles.number}>{row.next}</td><td className={row.kind === "change" && row.right !== undefined ? styles.added : undefined}>{row.right !== undefined && <Words text={row.right} other={row.kind === "change" ? row.left : undefined} added/>}</td></tr>)
    else if (row.kind === "context") result.push(<tr key={i}><td className={styles.number}>{row.old}</td><td className={styles.number}>{row.next}</td><td> {row.left || " "}</td></tr>)
    else {
      if (row.left !== undefined) result.push(<tr key={`${i}-old`}><td className={styles.number}>{row.old}</td><td className={styles.number}/><td className={styles.removed}>− <Words text={row.left} other={row.right} added={false}/></td></tr>)
      if (row.right !== undefined) result.push(<tr key={`${i}-new`}><td className={styles.number}/><td className={styles.number}>{row.next}</td><td className={styles.added}>+ <Words text={row.right} other={row.left} added/></td></tr>)
    }
  }
  return <tbody><tr><td className={styles.fold} colSpan={mode === "split" ? 4 : 3} title={`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}>{Math.max(1, hunk.newStart || hunk.oldStart)}번째 줄 부근</td></tr>{result}</tbody>
}

export function DiffView({ patch, before = "", after = "", beforeLabel = "이전", afterLabel = "이후" }: { patch?: string; before?: string; after?: string; beforeLabel?: string; afterLabel?: string }) {
  const id = useId()
  const [narrow, setNarrow] = useState(true)
  const [savedMode, setSavedMode] = useState<Mode | null>(null)
  const [sessionMode, setSessionMode] = useState<Mode | null>(null)
  const [large, setLarge] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)")
    const updateWidth = () => setNarrow(!media.matches)
    updateWidth()
    media.addEventListener("change", updateWidth)
    try { const saved = localStorage.getItem("llmwiki.diff.mode"); if (saved === "split" || saved === "unified") setSavedMode(saved) } catch {}
    return () => media.removeEventListener("change", updateWidth)
  }, [])
  const selectedMode = sessionMode ?? (narrow ? "unified" : savedMode ?? "split")
  function selectMode(mode: Mode) {
    setSessionMode(mode)
    try { localStorage.setItem("llmwiki.diff.mode", mode) } catch {}
  }
  const input = useMemo(() => patch ?? (before.length + after.length <= 1500000 || large ? createTwoFilesPatch("노트.md", "노트.md", before, after, "", "", { context: 12 }) : ""), [patch, before, after, large])
  const huge = input.length > 1500000 || before.length + after.length > 1500000
  const parsed = useMemo(() => { if (!input.trim() || (huge && !large)) return []; try { return parsePatch(input) } catch { return [] } }, [input, huge, large])
  return <section className="min-w-0 space-y-3" aria-label="변경 비교"><div className="flex flex-wrap items-center gap-2"><Button size="xs" variant={selectedMode === "split" ? "secondary" : "outline"} aria-pressed={selectedMode === "split"} onClick={() => selectMode("split")}>나란히</Button><Button size="xs" variant={selectedMode === "unified" ? "secondary" : "outline"} aria-pressed={selectedMode === "unified"} onClick={() => selectMode("unified")}>한 줄씩</Button><span className="ml-auto text-right text-xs tabular-nums text-muted-foreground">파일 {parsed.length}개</span></div>
    {narrow && selectedMode === "split" && <p className="text-xs text-muted-foreground">좌우로 밀어 두 버전을 확인하세요</p>}
    {huge && !large ? <div className="space-y-2 text-label-13"><p>큰 변경은 자동으로 펼치지 않습니다.</p><Button variant="outline" onClick={() => setLarge(true)}>큰 diff 불러오기</Button></div> : parsed.length === 0 ? <p className="text-label-13 text-muted-foreground">{input.includes("Binary files") || input.includes("GIT binary patch") ? "바이너리 파일 변경입니다. 텍스트 비교를 제공하지 않습니다." : input.trim() ? "이 변경은 텍스트 diff로 표시할 수 없습니다." : "내용 변경이 없습니다."}</p> : <>
    {parsed.length > 1 && <nav aria-label="변경 파일" className="flex flex-wrap gap-2">{parsed.map((file, i) => <a className="break-all text-xs underline" key={i} href={`#${id}-diff-file-${i}`}>{file.newFileName === "/dev/null" ? file.oldFileName : file.newFileName}</a>)}</nav>}
    {parsed.map((file, i) => {
      const oldPath = file.oldFileName?.replace(/^a\//, ""), path = file.newFileName?.replace(/^b\//, "")
      const status = file.oldFileName === "/dev/null" ? "추가" : file.newFileName === "/dev/null" ? "삭제" : oldPath !== path ? "이름 변경" : "수정"
      const displayPath = status === "이름 변경" ? `${oldPath} → ${path}` : status === "삭제" ? oldPath : path
      let additions = 0, removals = 0
      for (const hunk of file.hunks) for (const line of hunk.lines) { if (line.startsWith("+")) additions++; else if (line.startsWith("-")) removals++ }
      return <article id={`${id}-diff-file-${i}`} className="overflow-hidden rounded-lg border" key={i}>
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/50 px-2 py-1.5 text-xs"><strong className="shrink-0">{status}</strong><span className="min-w-0 flex-1 break-all font-mono">{displayPath}</span>{(additions > 0 || removals > 0) && <span className="shrink-0 font-mono tabular-nums" aria-label={`추가 ${additions}줄, 삭제 ${removals}줄`}>+{additions} −{removals}</span>}</header>
        {file.hunks.length ? <>
          {selectedMode === "unified" && <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-2 py-1.5 text-xs"><span>− {beforeLabel}</span><span>+ {afterLabel}</span></div>}
          <div className={styles.scroll}><table className={`${styles.diff} ${selectedMode === "split" ? styles.split : styles.unified}`} aria-label={`${displayPath} ${selectedMode === "split" ? "나란히" : "한 줄씩"} 비교`}>
            {selectedMode === "split" ? <><colgroup><col style={{ width: "3rem" }}/><col/><col style={{ width: "3rem" }}/><col/></colgroup><thead><tr><th colSpan={2} scope="colgroup">{beforeLabel}</th><th colSpan={2} scope="colgroup">{afterLabel}</th></tr></thead></> : <colgroup><col style={{ width: "3rem" }}/><col style={{ width: "3rem" }}/><col/></colgroup>}
            {file.hunks.map((h, n) => <Hunk key={n} hunk={h} mode={selectedMode}/>)}
          </table></div>
        </> : <p className="p-2 text-label-13 text-muted-foreground">바이너리 변경 또는 이름만 변경된 파일입니다.</p>}
      </article>
    })}</>}
  </section>
}
