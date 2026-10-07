"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Fragment, useState, type JSX } from "react"
import { request } from "@/lib/api"
import { ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"
import styles from "./history.module.css"

type Range = { start: number; end: number; sha: string; authorName: string; date: string; summary: string; jobId?: string; source?: string }

export function BlameView({ path, ref, content }: { path: string; ref?: string; content: string }): JSX.Element {
  const blame = useQuery({ queryKey: ["history", "blame", path, ref], queryFn: () => request<{ ref: string; ranges: Range[] }>(`/api/notes/blame?${new URLSearchParams({ path, ...(ref ? { ref } : {}) })}`) })
  const [hover, setHover] = useState<number | null>(null)
  if (blame.isPending) return <Loading/>
  if (blame.isError) return <div className="space-y-3"><ErrorNotice error={blame.error}/><Button variant="outline" onClick={() => blame.refetch()}>다시 시도</Button></div>
  const lines = content.replace(/\n$/, "").split("\n")
  const dates = blame.data.ranges.map(r => new Date(r.date).getTime())
  const oldest = Math.min(...dates), newest = Math.max(...dates)
  return <div className={styles.scroll}><table className={styles.blame} aria-label="줄별 작성 이력"><tbody>{blame.data.ranges.map(range => <Fragment key={range.start}>{Array.from({ length: range.end - range.start + 1 }, (_, offset) => <tr key={`${range.start}-${offset}`}>
    {offset === 0 && <td rowSpan={range.end - range.start + 1} className={styles.gutter} style={{ borderLeft: `4px solid hsl(${210 - 185 * ((new Date(range.date).getTime() - oldest) / (newest - oldest || 1))} 65% 55%)` }}><details open={hover === range.start} onMouseEnter={() => setHover(range.start)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(range.start)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setHover(null) }}><summary className="cursor-pointer"><Link href={`/history/commits/${range.sha}`} className="font-mono underline">{range.sha.slice(0, 8)}</Link><span className="block truncate">{range.authorName}</span><span className="text-muted-foreground">{new Intl.RelativeTimeFormat("ko", { numeric: "auto" }).format(Math.round((new Date(range.date).getTime() - Date.now()) / 86400000), "day")} · {range.source || "git"}</span></summary><div><strong>{range.summary}</strong><p className="mt-2">작성자: {range.authorName}</p><p>{formatDate(range.date)}</p><p>출처: <Link className="underline" href={`/history?source=${encodeURIComponent(range.source || "git")}`}>{range.source || "git"}</Link></p>{range.jobId && <Link className="underline" href={`/jobs/${range.jobId}`}>작업 {range.jobId.slice(0, 8)}</Link>}<p className="mt-2"><Link className="underline" href={`/history/commits/${range.sha}`}>커밋 보기</Link></p></div></details></td>}
    <td className={styles.number}>{range.start + offset}</td><td className={styles.blameContent}>{lines[range.start + offset - 1] || " "}</td></tr>)}</Fragment>)}</tbody></table></div>
}
