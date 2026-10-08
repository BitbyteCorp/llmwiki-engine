"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChartNoAxesCombined, RefreshCw } from "lucide-react"
import { opsApi } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading } from "@/components/common"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

const metrics = [
  { key: "inputTokens", label: "입력 토큰" },
  { key: "cachedInputTokens", label: "캐시 입력 토큰" },
  { key: "outputTokens", label: "출력 토큰" },
  { key: "reasoningTokens", label: "추론 토큰" },
] as const

export function UsageCard() {
  const [days, setDays] = useState(30)
  const usage = useQuery({
    queryKey: ["ops", "usage", days],
    queryFn: ({ signal }) => opsApi.usage(days, signal),
  })
  const totals = usage.data?.rows.reduce((sum, row) => ({
    inputTokens: sum.inputTokens + row.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    reasoningTokens: sum.reasoningTokens + row.reasoningTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })

  return <section className="min-w-0 space-y-2" aria-labelledby="usage-heading">
    <div className="flex h-7 items-center justify-between gap-2 border-b">
      <h2 id="usage-heading" className="flex items-center gap-1.5 text-label-13 font-semibold"><ChartNoAxesCombined className="size-3.5" />모델 토큰 사용량</h2>
      <Button size="sm" variant="outline" disabled={usage.isFetching} onClick={() => void usage.refetch()}><RefreshCw className="size-3.5" />새로고침</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="usage-days" className="text-xs text-muted-foreground">조회 기간</label>
      <NativeSelect id="usage-days" size="sm" value={days} onChange={event => setDays(Number(event.target.value))}>
        {[7, 30, 90].map(value => <NativeSelectOption key={value} value={value}>최근 {value}일</NativeSelectOption>)}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">오늘 포함 · UTC 날짜 기준</p>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">캐시 입력은 입력 토큰에, 추론은 출력 토큰에 포함된 부분집합입니다. 각각 별도로 더하지 않습니다. 제공자가 보고한 토큰 수이며 요금이나 청구액이 아닙니다.</p>
    {usage.isPending && <Loading label="토큰 사용량을 불러오는 중…" />}
    {usage.error && <div className="space-y-2"><ErrorNotice error={usage.error} /><Button size="sm" variant="outline" disabled={usage.isFetching} onClick={() => void usage.refetch()}>사용량 다시 시도</Button></div>}
    {usage.data && totals && <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 @5xl/settings-panel:grid-cols-4">
        {metrics.map(metric => <div key={metric.key} className="min-w-0"><dt className="text-xs text-muted-foreground">{usage.data.days}일 합계 · {metric.label}</dt><dd className="text-sm font-semibold tabular-nums">{totals[metric.key].toLocaleString("ko-KR")}</dd></div>)}
      </dl>
      {usage.data.rows.length === 0 ? <EmptyState title="해당 기간에 기록된 토큰 사용량이 없습니다" /> : <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[800px] text-left text-label-13">
          <caption className="sr-only">최근 {usage.data.days}일의 UTC 날짜·작업 유형·모델별 토큰 사용량</caption>
          <thead className="whitespace-nowrap border-b text-xs text-muted-foreground"><tr>
            {["날짜 (UTC)", "작업 유형 (lane)", "모델"].map(label => <th scope="col" key={label} className="px-2 py-1.5 font-medium">{label}</th>)}
            {["호출 수", ...metrics.map(metric => metric.label)].map(label => <th scope="col" key={label} className="px-2 py-1.5 text-right font-medium">{label}</th>)}
          </tr></thead>
          <tbody className="divide-y">{usage.data.rows.map(row => <tr key={JSON.stringify([row.day, row.lane, row.model])} className="align-top">
            <td className="whitespace-nowrap px-2 py-1.5">{row.day}</td>
            <td className="px-2 py-1.5">{row.lane}</td>
            <td className="break-all px-2 py-1.5 font-mono text-xs">{row.model}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{row.calls.toLocaleString("ko-KR")}</td>
            {metrics.map(metric => <td key={metric.key} className="px-2 py-1.5 text-right tabular-nums">{row[metric.key].toLocaleString("ko-KR")}</td>)}
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
  </section>
}
