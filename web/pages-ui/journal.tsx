'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api, dreamsApi } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const Markdown = dynamic(() => import('@/components/markdown').then(module => module.Markdown), { loading: () => <Loading label="일기 본문을 준비하는 중…" /> })

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function shiftDay(date: string, amount: number) {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + amount)
  return next.toISOString().slice(0, 10)
}

function shiftMonth(month: string, amount: number) {
  const next = new Date(`${month}-01T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + amount)
  return next.toISOString().slice(0, 7)
}

function todayKst() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function JournalPage() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const dateParam = params.get('date')
  const invalidDate = dateParam !== null && !validDate(dateParam)
  const journal = useQuery({ queryKey: ['journal'], queryFn: ({ signal }) => dreamsApi.journal(signal) })
  const entries = journal.data ?? []
  const selectedDate = dateParam && !invalidDate ? dateParam : entries[0]?.date ?? todayKst()
  const selected = entries.find((entry) => entry.date === selectedDate)
  const [browsedMonth, setBrowsedMonth] = useState<string | null>(null)
  const month = browsedMonth ?? selectedDate.slice(0, 7)
  const monthEntries = entries.filter((entry) => entry.date.startsWith(`${month}-`))
  const existingDates = new Set(monthEntries.map((entry) => entry.date))
  const firstDay = new Date(`${month}-01T00:00:00Z`).getUTCDay()
  const daysInMonth = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`)
  daysInMonth.setUTCDate(0)
  const count = daysInMonth.getUTCDate()
  const note = useQuery({
    queryKey: ['notes/content', selected?.path],
    queryFn: () => api.note(selected!.path),
    enabled: journal.isSuccess && !!selected && !invalidDate,
  })

  function selectDate(date: string) {
    if (!validDate(date)) return
    const next = new URLSearchParams(params.toString())
    next.set('date', date)
    setBrowsedMonth(null)
    router.push(`${pathname}?${next}`)
  }

  useEffect(() => {
    if (dateParam !== null || !journal.isSuccess) return
    const next = new URLSearchParams(params.toString())
    next.set('date', selectedDate)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }, [dateParam, journal.isSuccess, params, pathname, router, selectedDate])

  return <div className="min-w-0 space-y-6">
    <PageHeader title="일기" description="날짜별로 dreaming이 정리한 지식과 하루의 기록을 읽습니다." actions={<Button variant="outline" nativeButton={false} render={<Link href="/dreams" />}>Dreaming 실행 기록</Button>} />
    {invalidDate ? <div className="space-y-3"><ErrorNotice error={new Error('날짜는 실제 달력의 YYYY-MM-DD 형식으로 선택해 주세요.')} /><Button variant="outline" nativeButton={false} render={<Link href="/journal" />}>최근 일기로 이동</Button></div> : <>
      <nav aria-label="일기 날짜 탐색" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <Button variant="outline" onClick={() => selectDate(shiftDay(selectedDate, -1))} aria-label="이전 날짜 일기"><ChevronLeft />이전 날</Button>
        <label className="order-first w-full min-w-0 flex-none space-y-1 sm:order-none sm:w-52"><span className="text-xs text-muted-foreground">선택한 날짜</span><Input className="h-8 tabular-nums" type="date" aria-label="일기 날짜" value={selectedDate} onChange={(event) => selectDate(event.target.value)} /></label>
        <Button variant="outline" onClick={() => selectDate(shiftDay(selectedDate, 1))} aria-label="다음 날짜 일기">다음 날<ChevronRight /></Button>
        <Button variant="ghost" onClick={() => selectDate(todayKst())}>오늘 · 한국 시간</Button>
      </nav>
      {journal.isPending && <Loading label="일기 목록을 불러오는 중…" />}
      {journal.error && <div className="space-y-3"><ErrorNotice error={journal.error} /><Button variant="outline" disabled={journal.isFetching} onClick={() => void journal.refetch()}>목록 다시 시도</Button></div>}
      {journal.isSuccess && <div className="grid min-w-0 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3" aria-label="일기 달력과 월별 목록">
          <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="journal-month-title">
            <div className="flex items-center justify-between gap-3"><Button variant="ghost" size="icon" aria-label="이전 달" onClick={() => setBrowsedMonth(shiftMonth(month, -1))}><ChevronLeft /></Button><h2 id="journal-month-title" className="text-sm font-semibold tabular-nums">{Number(month.slice(0, 4))}년 {Number(month.slice(5))}월</h2><Button variant="ghost" size="icon" aria-label="다음 달" onClick={() => setBrowsedMonth(shiftMonth(month, 1))}><ChevronRight /></Button></div>
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">월 선택</span><Input className="h-8 tabular-nums" type="month" aria-label="일기 목록의 월" value={month} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setBrowsedMonth(event.target.value) }} /></label>
            <div className="grid grid-cols-7 gap-1 text-center text-xs">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day} className="py-1 text-muted-foreground">{day}</span>)}{Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}{Array.from({ length: count }, (_, index) => {
              const date = `${month}-${String(index + 1).padStart(2, '0')}`
              const exists = existingDates.has(date)
              return <button key={date} type="button" aria-label={`${date}${exists ? ', 일기 있음' : ', 일기 없음'}`} aria-pressed={date === selectedDate} onClick={() => selectDate(date)} className={`flex min-h-10 flex-col items-center justify-center rounded-md border border-transparent transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${date === selectedDate ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}`}><span>{index + 1}</span><span aria-hidden="true" className={`mt-1 size-1 rounded-full ${exists ? 'bg-current' : 'bg-transparent'}`} /></button>
            })}</div>
            <p className="text-xs text-muted-foreground">날짜 아래 점은 일기가 있는 날입니다. 점이 없는 날도 선택할 수 있습니다.</p>
          </section>
          <section className="space-y-3" aria-labelledby="journal-month-list-title"><h2 id="journal-month-list-title" className="flex items-center justify-between gap-3 text-sm font-semibold"><span>이번 달 일기</span><span className="text-right tabular-nums text-muted-foreground">{monthEntries.length}개</span></h2>{monthEntries.length === 0 ? <p className="text-sm text-muted-foreground">이 달에는 기록된 일기가 없습니다.</p> : <ul className="divide-y overflow-hidden rounded-lg border bg-card">{monthEntries.map((entry) => <li key={entry.date}><Link href={`/journal?date=${entry.date}`} aria-current={entry.date === selectedDate ? 'date' : undefined} onClick={() => setBrowsedMonth(null)} className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-accent ${entry.date === selectedDate ? 'bg-accent font-medium' : ''}`}><time className="whitespace-nowrap tabular-nums" dateTime={entry.date}>{entry.date}</time>{entry.dreamRunId && <span className="text-xs text-muted-foreground">dreaming 연결됨</span>}</Link></li>)}</ul>}</section>
        </aside>
        <section className="min-w-0 space-y-3" aria-labelledby="journal-entry-title">
          <h2 id="journal-entry-title" className="text-sm font-semibold"><time className="whitespace-nowrap tabular-nums" dateTime={selectedDate}>{selectedDate}</time> 일기</h2>
          {!selected ? <EmptyState title="이 날짜에는 일기가 없습니다" description={entries.length === 0 ? '아직 기록된 일기가 없습니다. Dreaming이 일기를 작성하면 달력에 표시됩니다.' : '다른 날짜를 선택하거나 이전 날·다음 날 버튼으로 이동해 보세요.'} /> : <>
            <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/history?${new URLSearchParams({ path: selected.path })}`} />}>이 일기의 커밋</Button>{selected.dreamRunId && <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/dreams/${encodeURIComponent(selected.dreamRunId)}`} />}>이날의 dreaming</Button>}<Button variant="ghost" size="sm" nativeButton={false} render={<Link href={noteHref(selected.path)} />}>노트로 열기</Button></div>
            {!selected.dreamRunId && <p className="text-xs text-muted-foreground">이 일기에 연결된 dreaming 실행 기록이 없습니다.</p>}
            {note.isPending && <Loading label="일기 본문을 불러오는 중…" />}
            {note.error && <div className="space-y-3"><ErrorNotice error={note.error} /><Button variant="outline" disabled={note.isFetching} onClick={() => void note.refetch()}>본문 다시 시도</Button></div>}
            {note.isSuccess && <article className="min-w-0 rounded-lg border bg-card p-4" aria-label={`${selectedDate} 일기 본문`}><Markdown content={note.data.body} path={selected.path} /></article>}
          </>}
        </section>
      </div>}
    </>}
  </div>
}
