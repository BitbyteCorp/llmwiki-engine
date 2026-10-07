import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12"><section className="w-full max-w-sm space-y-3 rounded-lg border bg-card p-4"><FileQuestion aria-hidden="true" className="size-6 text-muted-foreground" /><h1 className="text-heading-20">페이지를 찾을 수 없다.</h1><p className="text-sm text-muted-foreground">주소를 확인하거나 위키에서 필요한 노트를 찾아보세요.</p><Button size="lg" nativeButton={false} render={<Link href="/wiki" />}>위키로 돌아가기</Button></section></main>
}
