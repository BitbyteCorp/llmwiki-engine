'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, type Message } from '@/lib/api';
import { sendMessage } from '@/lib/chat-stream';
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from '@/components/common';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ActiveStream {
  id: string;
  controller: AbortController;
}

export function ChatPage() {
  const { id: encodedId } = useParams<{ id: string }>();
  const id = encodedId === undefined ? undefined : decodeURIComponent(encodedId);
  const router = useRouter();
  const queryClient = useQueryClient();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: api.conversations });
  const detail = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.conversation(id!),
    enabled: Boolean(id),
  });
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<Message[] | null>(null);
  const [partialMessages, setPartialMessages] = useState<Record<string, true>>({});
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<ActiveStream | null>(null);
  const routeId = useRef(id);
  routeId.current = id;
  const hasPartial = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft('');
    setLocalMessages(null);
    setPartialMessages({});
    setStreaming(false);
    setChatError(null);
    setNotice(null);
    hasPartial.current = false;
    return () => {
      const previous = active.current;
      active.current = null;
      previous?.controller.abort();
    };
  }, [id]);

  const create = useMutation({
    mutationFn: () => api.createConversation(),
    onSuccess: async ({ conversation }) => {
      router.push(`/chat/${encodeURIComponent(conversation.id)}`);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const remove = useMutation({
    mutationFn: async (conversationId: string) => {
      if (active.current?.id === conversationId) {
        throw new Error('답변 생성 중에는 이 대화를 삭제할 수 없습니다.');
      }
      await api.deleteConversation(conversationId);
      return conversationId;
    },
    onSuccess: async (conversationId) => {
      if (routeId.current === conversationId) router.push('/chat');
      queryClient.removeQueries({ queryKey: ['conversation', conversationId] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!id || !content || active.current || !detail.data || detail.isError || (remove.isPending && remove.variables === id)) return;
    const stream: ActiveStream = { id, controller: new AbortController() };
    active.current = stream;
    const temporaryId = `local-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const question: Message = {
      id: `${temporaryId}-user`, role: 'user', content, citations: [], createdAt,
    };
    const answer: Message = {
      id: `${temporaryId}-assistant`, role: 'assistant', content: '', citations: [], createdAt,
    };
    setLocalMessages([...(localMessages ?? detail.data.messages), question, answer]);
    setDraft('');
    setChatError(null);
    setNotice(null);
    setStreaming(true);
    const isCurrent = () => active.current === stream && routeId.current === stream.id;
    let finalMessageId: string | undefined;
    try {
      const finalMessage = await sendMessage(id, content, {
        onDelta: (text) => {
          if (!isCurrent()) return;
          setLocalMessages((messages) => messages?.map((message) => (
            message.id === answer.id ? { ...message, content: message.content + text } : message
          )) ?? null);
        },
        onDone: (finalMessage) => {
          if (!isCurrent()) return;
          finalMessageId = finalMessage.id;
          setLocalMessages((messages) => messages?.map((message) => (
            message.id === answer.id ? finalMessage : message
          )) ?? null);
        },
      }, stream.controller.signal);
      finalMessageId = finalMessage.id;
    } catch (error) {
      if (isCurrent()) {
        hasPartial.current = true;
        setPartialMessages((previous) => ({ ...previous, [answer.id]: true }));
        if (stream.controller.signal.aborted) {
          setNotice('답변 생성을 중지했습니다. 지금까지 받은 답변은 이 화면에 남습니다.');
        } else {
          setChatError(error);
        }
      }
    } finally {
      // Both endpoints are refreshed even on failure: the user message may already be saved.
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', stream.id] }),
      ]);
      if (isCurrent()) {
        active.current = null;
        setStreaming(false);
        if (finalMessageId && !hasPartial.current) {
          const refreshed = queryClient.getQueryData<{ messages: Message[] }>(['conversation', stream.id]);
          if (refreshed?.messages.some((message) => message.id === finalMessageId)) {
            setLocalMessages(null);
          }
        }
        textarea.current?.focus();
      }
    }
  };

  const messages = localMessages ?? detail.data?.messages ?? [];
  const deletingCurrent = remove.isPending && remove.variables === id;
  const canSend = Boolean(id && detail.data && !detail.isError && draft.trim() && !streaming && !deletingCurrent);

  return (
    <div className="space-y-6">
      <PageHeader title="Luna와 대화" description="위키를 근거로 질문에 답하고, 참고한 노트를 함께 보여드립니다." />
      <div className="grid items-start gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside aria-label="내 대화 목록" className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">내 대화</h2>
            <Button size="sm" variant="outline" disabled={create.isPending || streaming} onClick={() => create.mutate()}>
              {create.isPending ? '만드는 중…' : '새 대화'}
            </Button>
          </div>
          {create.isError && <ErrorNotice error={create.error} />}
          {remove.isError && <ErrorNotice error={remove.error} />}
          {conversations.isPending ? <Loading label="대화 목록을 불러오는 중…" /> : conversations.isError ? (
            <ErrorNotice error={conversations.error} />
          ) : conversations.data.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">아직 대화가 없습니다.</p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto lg:max-h-[65vh]">
              {conversations.data.conversations.map((conversation) => (
                <li key={conversation.id} className={`flex items-center gap-1 rounded-md ${id === conversation.id ? 'bg-muted' : ''}`}>
                  <Link
                    href={`/chat/${encodeURIComponent(conversation.id)}`}
                    aria-current={id === conversation.id ? 'page' : undefined}
                    className="min-w-0 flex-1 rounded-md px-2 py-2 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="block truncate text-sm font-medium">{conversation.title || '새 대화'}</span>
                    <span className="block text-xs text-muted-foreground">{formatDate(conversation.updatedAt)}</span>
                  </Link>
                  <Button
                    variant="ghost" size="sm" className="shrink-0 px-2 text-xs text-muted-foreground"
                    aria-label={`${conversation.title || '새 대화'} 삭제`}
                    disabled={remove.isPending || (streaming && id === conversation.id)}
                    onClick={() => {
                      if (window.confirm('이 대화와 모든 메시지를 삭제할까요? 삭제 후 복구할 수 없습니다.')) {
                        remove.mutate(conversation.id);
                      }
                    }}
                  >삭제</Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-5 text-muted-foreground">대화 기록은 본인에게만 보입니다. 대화에서 알려준 사실과 정정은 공용 위키에 반영될 수 있습니다.</p>
        </aside>

        <section aria-label="대화" className="min-w-0 space-y-6">
          {!id ? (
            <div className="space-y-4 rounded-lg border p-8 text-center">
              <EmptyState title="위키에 대해 질문해 보세요" description="새 대화를 만들거나 왼쪽에서 이전 대화를 선택하세요." />
              <Button disabled={create.isPending} onClick={() => create.mutate()}>새 대화 시작</Button>
            </div>
          ) : detail.isPending ? <Loading label="대화를 불러오는 중…" /> : !detail.data ? (
            <ErrorNotice error={detail.error} />
          ) : (
            <>
              <h2 className="text-lg font-semibold">{detail.data.conversation.title || '새 대화'}</h2>
              {detail.isError && (
                <div className="space-y-2">
                  <ErrorNotice error={detail.error} />
                  <Button variant="outline" size="sm" onClick={() => { void detail.refetch(); }}>대화 다시 불러오기</Button>
                </div>
              )}
              {messages.length === 0 ? (
                <EmptyState title="무엇이 궁금하신가요?" description="질문을 입력하면 Luna가 관련 노트를 찾아 답변합니다." />
              ) : (
                <ol aria-label="대화 메시지" className="space-y-6">
                  {messages.map((message) => (
                    <li key={message.id}>
                      <article className={`space-y-3 rounded-lg border p-4 ${message.role === 'user' ? 'bg-muted/40' : 'bg-background'}`}>
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-sm font-semibold">{message.role === 'user' ? '나' : 'Luna'}</h3>
                          <time dateTime={message.createdAt} className="text-xs text-muted-foreground">{formatDate(message.createdAt)}</time>
                        </div>
                        {partialMessages[message.id] && (
                          <p className="text-xs text-muted-foreground">완료되지 않은 답변 · 이 화면에만 남습니다.</p>
                        )}
                        {message.content ? message.role === 'assistant' ? (
                          <Markdown content={message.content} />
                        ) : <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p> : (
                          <p className="text-sm text-muted-foreground">{streaming && !partialMessages[message.id] ? '위키를 살펴보고 있습니다…' : '받은 답변이 없습니다.'}</p>
                        )}
                        {message.citations.length > 0 && (
                          <div className="space-y-2 border-t pt-3">
                            <h4 className="text-xs font-medium text-muted-foreground">근거 노트</h4>
                            <ul className="flex flex-wrap gap-2">
                              {Array.from(new Set(message.citations)).map((path) => (
                                <li key={path}><Link href={noteHref(path)} className="inline-block max-w-full break-all rounded-md border px-2 py-1 text-xs underline-offset-4 hover:underline">{path}</Link></li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </article>
                    </li>
                  ))}
                </ol>
              )}
              {chatError != null && <ErrorNotice error={chatError} />}
              {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
              <form className="space-y-3 border-t pt-4" onSubmit={(event) => { void submit(event); }}>
                <Label htmlFor="chat-question">질문</Label>
                <Textarea
                  ref={textarea} id="chat-question" value={draft} disabled={streaming || deletingCurrent}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="위키에 대해 궁금한 내용을 입력하세요."
                  aria-describedby="chat-keyboard-help" className="min-h-28 resize-y"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (canSend) void submit();
                    }
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p id="chat-keyboard-help" className="text-xs text-muted-foreground">Enter 전송 · Shift+Enter 줄바꿈</p>
                  <div className="flex items-center gap-3">
                    {streaming && <span role="status" className="text-sm text-muted-foreground">Luna가 답변 중…</span>}
                    {streaming ? (
                      <Button type="button" variant="outline" onClick={() => active.current?.controller.abort()}>생성 중지</Button>
                    ) : <Button type="submit" disabled={!canSend}>질문 보내기</Button>}
                  </div>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
