import Link from 'next/link'

export default function NotFound() {
  return <main className="mx-auto max-w-lg space-y-3 px-6 py-20"><h1 className="text-heading-24">페이지를 찾을 수 없다.</h1><Link href="/wiki" className="text-sm underline">위키로 돌아가기</Link></main>
}
