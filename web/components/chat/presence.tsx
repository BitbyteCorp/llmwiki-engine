'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, request } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { Button } from '@/components/ui/button'

interface PresenceUser { id: number; name: string; typing: boolean }

export function ConversationPresence({ id, typing }: { id: string; typing?: boolean }) {
  const [users, setUsers] = useState<PresenceUser[]>([])
  const [error, setError] = useState<unknown>(null)
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const surface = useRef<HTMLDivElement>(null)
  const typingRef = useRef(typing ?? false)
  const heartbeat = useRef<() => void>(() => {})
  const explicitTyping = useRef(typing !== undefined)
  explicitTyping.current = typing !== undefined
  useEffect(() => {
    if (typing === undefined) return
    typingRef.current = typing
    heartbeat.current()
  }, [typing])
  useEffect(() => {
    setUsers([])
    setError(null)
    let requestController: AbortController | null = null
    let typingTimer: number | undefined
    let disposed = false
    const focused = () => document.visibilityState === 'visible' && document.hasFocus() && Boolean(surface.current?.getClientRects().length)
    const send = () => {
      if (disposed || !focused() || requestController) return
      const controller = new AbortController()
      requestController = controller
      const sentTyping = typingRef.current
      void request<{ expiresAt: string }>(`/api/conversations/${encodeURIComponent(id)}/presence`, { method: 'POST', body: JSON.stringify({ typing: sentTyping }), signal: controller.signal })
        .then(() => { if (!disposed) setError(null) })
        .catch(cause => { if (!disposed && !controller.signal.aborted) setError(cause) })
        .finally(() => {
          if (requestController !== controller) return
          requestController = null
          if (!disposed && !controller.signal.aborted && sentTyping !== typingRef.current) send()
        })
    }
    const stop = () => {
      requestController?.abort()
      requestController = null
      clearTimeout(typingTimer)
      if (!explicitTyping.current) typingRef.current = false
    }
    const visibility = () => { if (focused()) send(); else stop() }
    const input = (event: Event) => {
      if (explicitTyping.current || !(event.target instanceof HTMLElement) || !event.target.closest('[data-chat-composer]') || event.target.closest('[data-chat-pane]') !== surface.current?.closest('[data-chat-pane]')) return
      const target = event.target
      typingRef.current = (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value.length > 0
      clearTimeout(typingTimer)
      send()
      typingTimer = window.setTimeout(() => { typingRef.current = false; send() }, 3000)
    }
    const unsubscribe = onLiveEvent('conversation.presence', event => {
      if (event.conversationId !== id || !Array.isArray(event.users)) return
      setUsers(event.users.filter((user): user is PresenceUser => typeof user === 'object' && user !== null && typeof user.id === 'number' && typeof user.name === 'string' && typeof user.typing === 'boolean'))
    })
    const reconnect = onLiveEvent('connection', event => { if (event.state === 'connected') send(); else setUsers([]) })
    heartbeat.current = send
    window.addEventListener('focus', send)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('input', input)
    const timer = setInterval(send, 10000)
    send()
    return () => {
      disposed = true
      stop()
      clearInterval(timer)
      heartbeat.current = () => {}
      unsubscribe()
      reconnect()
      window.removeEventListener('focus', send)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('input', input)
    }
  }, [id])
  const others = users.filter(user => user.id !== me.data?.user.id)
  const typists = others.filter(user => user.typing)
  return <div ref={surface} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="대화 접속 상태">
    {others.length > 0 && <><div className="flex -space-x-1">{others.slice(0, 5).map(user => <span key={user.id} title={`${user.name} · ${user.typing ? '입력 중' : '보는 중'}`} aria-label={`${user.name} · ${user.typing ? '입력 중' : '보는 중'}`} className="flex size-6 items-center justify-center rounded-full border border-background bg-secondary font-semibold text-secondary-foreground">{Array.from(user.name.trim())[0] || '?'}</span>)}</div><span>{others.length}명 보는 중</span></>}
    <span role="status" aria-live="polite">{typists.length > 0 ? `${typists.map(user => user.name).join(', ')} 입력 중…` : ''}</span>
    {Boolean(error) && <span className="flex items-center gap-1 text-destructive">접속 상태를 갱신하지 못했습니다.<Button size="xs" variant="ghost" onClick={() => heartbeat.current()}>다시 시도</Button></span>}
  </div>
}
