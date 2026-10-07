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
  return <><tbody><tr><td className={styles.fold} colSpan={mode === "split" ? 4 : 3}>@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</td></tr>{result}</tbody></>
}

export function DiffView({ patch, before = "", after = "", mode }: { patch?: string; before?: string; after?: string; mode: Mode }) {
  const id = useId()
  const [selectedMode, setMode] = useState<Mode>(mode)
  const [large, setLarge] = useState(false)
  useEffect(() => { try { const saved = localStorage.getItem("llmwiki.diff.mode"); if (saved === "split" || saved === "unified") setMode(saved) } catch {} }, [])
  const input = useMemo(() => patch ?? (before.length + after.length <= 1500000 || large ? createTwoFilesPatch("노트.md", "노트.md", before, after, "", "", { context: 12 }) : ""), [patch, before, after, large])
  const huge = input.length > 1500000 || before.length + after.length > 1500000
  const parsed = useMemo(() => { if (!input.trim() || (huge && !large)) return []; try { return parsePatch(input) } catch { return [] } }, [input, huge, large])
  return <section className="min-w-0 space-y-3" aria-label="변경 비교"><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant={selectedMode === "split" ? "secondary" : "outline"} aria-pressed={selectedMode === "split"} onClick={() => { setMode("split"); try { localStorage.setItem("llmwiki.diff.mode", "split") } catch {} }}>나란히</Button><Button size="sm" variant={selectedMode === "unified" ? "secondary" : "outline"} aria-pressed={selectedMode === "unified"} onClick={() => { setMode("unified"); try { localStorage.setItem("llmwiki.diff.mode", "unified") } catch {} }}>통합</Button><span className="ml-auto text-right text-xs tabular-nums text-muted-foreground">{parsed.length}개 파일</span></div>
    {huge && !large ? <div className="space-y-3 rounded-lg border bg-card p-4 text-sm"><p>큰 변경은 자동으로 펼치지 않습니다.</p><Button variant="outline" onClick={() => setLarge(true)}>큰 diff 불러오기</Button></div> : parsed.length === 0 ? <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{input.includes("Binary files") || input.includes("GIT binary patch") ? "바이너리 파일 변경입니다. 텍스트 비교를 제공하지 않습니다." : input.trim() ? "이 변경은 텍스트 diff로 표시할 수 없습니다." : "내용 변경이 없습니다."}</p> : <>
    {parsed.length > 1 && <nav aria-label="변경 파일" className="flex flex-wrap gap-3">{parsed.map((file, i) => <a className="break-all text-xs underline" key={i} href={`#${id}-diff-file-${i}`}>{file.newFileName === "/dev/null" ? file.oldFileName : file.newFileName}</a>)}</nav>}
    {parsed.map((file, i) => { const oldPath = file.oldFileName?.replace(/^a\//, ""), path = file.newFileName?.replace(/^b\//, ""); const status = file.oldFileName === "/dev/null" ? "A" : file.newFileName === "/dev/null" ? "D" : oldPath !== path ? "R" : "M"; return <article id={`${id}-diff-file-${i}`} className="overflow-hidden rounded-lg border bg-card" key={i}><header className="break-all border-b bg-muted/50 px-4 py-3 font-mono text-xs"><strong>{status}</strong> {status === "R" ? `${oldPath} → ${path}` : status === "D" ? oldPath : path}</header>{file.hunks.length ? <div className={styles.scroll}><table className={`${styles.diff} ${selectedMode === "split" ? styles.split : ""}`} aria-label={`${path} ${selectedMode === "split" ? "나란히" : "통합"} diff`}>{selectedMode === "split" && <colgroup><col style={{width: "3rem"}}/><col/><col style={{width: "3rem"}}/><col/></colgroup>}{file.hunks.map((h, n) => <Hunk key={n} hunk={h} mode={selectedMode}/>)}</table></div> : <p className="p-4 text-sm text-muted-foreground">바이너리 변경 또는 이름만 변경된 파일입니다.</p>}</article> })}</>}
  </section>
}
