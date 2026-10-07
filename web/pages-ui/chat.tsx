'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api, type Message } from '@/lib/api';
import { cancelGeneration, resumeGeneration, sendMessage, streamMessageAction, type ChatMessageInput, type ChatStreamEvent } from '@/lib/chat-stream';
import { EmptyState, ErrorNotice, Loading } from '@/components/common';
import { Button } from '@/components/ui/button';
import { ChatComposer } from '@/components/chat/composer';
import { ThreadsPanel } from '@/components/chat/threads';
import { ConversationSharing } from '@/components/chat/sharing';
import { ConversationPresence } from '@/components/chat/presence';
import { ChatMessageView } from '@/components/chat/message-view';
import { ChatProposal } from '@/components/chat/proposal';

interface RunningStream { conversationId: string; controller: AbortController; generationId?: string; answerId: string; stopRequested?: boolean }
interface ToolActivity { name: string; summary?: string; status?: string; path?: string }
const phases: Record<string, string> = { queued: '답변 준비 중', thinking: '생각 중', answering: '답변 작성 중', summarizing: '이전 대화 요약 중', tool: '위키 확인 중' };

export function ChatPage() {
  const { id: encodedId } = useParams<{ id?: string }>();
  const id = encodedId === undefined ? undefined : decodeURIComponent(encodedId);
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const detail = useQuery({ queryKey: ['conversation', id], queryFn: () => api.conversation(id!), enabled: Boolean(id) });
  const [localMessages, setLocalMessages] = useState<Message[] | null>(null);
  const [tools, setTools] = useState<Record<string, ToolActivity[]>>({});
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [proposal, setProposal] = useState<{messageId: string; mode: 'new' | 'edit'} | null>(null);
  const [creating, setCreating] = useState(false);
  const active = useRef<RunningStream | null>(null);
  const routeId = useRef(id);
  routeId.current = id;
  const creationStarted = useRef(false);
  const attached = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalMessages(null); setTools({}); setStreaming(false); setError(null); setEditing(null); setProposal(null); setPhase('');
    return () => { active.current?.controller.abort(); active.current = null; attached.current.clear(); };
  }, [id]);

  const create = useCallback(async () => {
    if (creationStarted.current) return;
    creationStarted.current = true; setCreating(true); setError(null);
    try {
      const {conversation} = await api.createConversation();
      await queryClient.invalidateQueries({queryKey: ['conversations']});
      router.replace(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (failure) { setError(failure); }
    finally { creationStarted.current = false; setCreating(false); }
  }, [queryClient, router]);

  useEffect(() => { if (!id && params.get('new') === '1') void create(); }, [id, params, create]);

  const run = useCallback(async (stream: RunningStream, operation: (handlers: {onEvent: (event: ChatStreamEvent) => void}, signal: AbortSignal) => Promise<Message | null>) => {
    active.current = stream; setStreaming(true); setError(null); setPhase('답변 준비 중');
    const current = () => active.current === stream && routeId.current === stream.conversationId;
    const updateAnswer = (update: (message: Message) => Message) => {
      if (!current()) return;
      setLocalMessages(previous => previous?.map(message => message.id === stream.answerId ? update(message) : message) ?? null);
    };
    try {
      await operation({onEvent: event => {
        if (!current()) return;
        switch (event.event) {
          case 'generation':
            stream.generationId = event.data.generationId;
            if (stream.stopRequested) void cancelGeneration(event.data.generationId).catch(setError);
            setLocalMessages(previous => previous?.map(message => message.id.startsWith('local-user-') && event.data.userMessageId ? {...message, id: event.data.userMessageId} : message) ?? null);
            break;
          case 'status': setPhase(phases[event.data.phase] ?? '답변 생성 중'); break;
          case 'tool':
            setTools(previous => {
              const list = [...(previous[stream.answerId] ?? [])];
              const match = event.data.state === 'end' ? list.findLastIndex(tool => tool.name === event.data.name && tool.status === 'start') : -1;
              const item = {name:event.data.name, summary:event.data.summary, path:event.data.path, status:event.data.state};
              if (match >= 0) list[match] = item; else list.push(item);
              return {...previous, [stream.answerId]:list};
            });
            break;
          case 'citation':
            updateAnswer(message => ({...message, citations:[...message.citations, event.data]}));
            break;
          case 'delta': updateAnswer(message => ({...message,content:message.content + event.data.text})); break;
          case 'usage': updateAnswer(message => ({...message,usage:event.data})); break;
          case 'done':
            updateAnswer(() => event.data.message);
            setTools(previous => ({...previous, [event.data.message.id]: previous[stream.answerId] ?? []}));
            break;
          case 'error':
            updateAnswer(message => ({...message,status:event.data.code === 'generation_cancelled' ? 'cancelled' : event.data.code === 'generation_interrupted' ? 'interrupted' : 'failed'}));
            if (event.data.code !== 'generation_cancelled') setError(new Error(event.data.message));
            break;
        }
      }}, stream.controller.signal);
    } catch (failure) {
      if (current() && !stream.controller.signal.aborted) setError(failure);
    } finally {
      await Promise.allSettled([queryClient.invalidateQueries({queryKey:['conversation',stream.conversationId]}),queryClient.invalidateQueries({queryKey:['conversations']})]);
      if (current()) { active.current = null; setStreaming(false); setLocalMessages(null); setPhase(''); }
    }
  }, [queryClient]);

  useEffect(() => {
    if (!id || active.current || !detail.data) return;
    const message = detail.data.messages.findLast(message => message.role === 'assistant' && message.status === 'running');
    if (!message?.generationId || attached.current.has(message.generationId)) return;
    attached.current.add(message.generationId);
    setLocalMessages(detail.data.messages.map(item => item.id === message.id ? {...item,content:'',citations:[],usage:null} : item));
    const stream: RunningStream = {conversationId:id,controller:new AbortController(),generationId:message.generationId,answerId:message.id};
    void run(stream,(handlers,signal) => resumeGeneration(message.generationId!,handlers,signal));
  }, [detail.data,id,run,streaming]);

  const stop = useCallback(async () => {
    const stream = active.current;
    if (!stream) return;
    stream.stopRequested = true;
    const generationId = stream.generationId;
    if (!generationId) return;
    try { await cancelGeneration(generationId); } catch (failure) { setError(failure); }
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && active.current) { event.preventDefault(); void stop(); }
    };
    window.addEventListener('keydown',keyboard);
    return () => window.removeEventListener('keydown',keyboard);
  }, [stop]);

  const messages = localMessages ?? detail.data?.messages ?? [];
  const submit = async (input: ChatMessageInput) => {
    if (!id || active.current || !detail.data) return;
    const temporary = crypto.randomUUID();
    const answer: Message = {id:`local-answer-${temporary}`,role:'assistant',content:'',citations:[],attachments:[],context:null,status:'running',usage:null,model:input.model ?? null,effort:input.effort ?? null,createdAt:new Date().toISOString()};
    const previous = editing ? messages.slice(0,messages.findIndex(message => message.id === editing.id)+1).map(message => message.id === editing.id ? {...message,content:input.content} : message) : [...messages,{...answer,id:`local-user-${temporary}`,role:'user' as const,content:input.content,status:'completed' as const,attachments:input.attachments ?? [],context:input.context ?? null}];
    setLocalMessages([...previous,answer]);
    const editId = editing?.id; setEditing(null);
    await run({conversationId:id,controller:new AbortController(),answerId:answer.id},(handlers,signal) => editId ? streamMessageAction(id,editId,'edit',{content:input.content},handlers,signal) : sendMessage(id,input,handlers,signal));
  };
  const action = async (message: Message, kind: 'retry' | 'regenerate') => {
    if (!id || active.current) return;
    const index = messages.findIndex(item => item.id === message.id);
    const before = messages.slice(0,index);
    const answer = {...message,id:`local-answer-${crypto.randomUUID()}`,content:'',citations:[],usage:null,status:'running' as const};
    setLocalMessages([...before,answer]);
    await run({conversationId:id,controller:new AbortController(),answerId:answer.id},(handlers,signal) => streamMessageAction(id,message.id,kind,{},handlers,signal));
  };
  useEffect(() => { bottom.current?.scrollIntoView({block:'end',behavior:'instant'}); }, [messages.at(-1)?.content]);
  const readonly = detail.data?.conversation.role === 'viewer';

  return <div className="chat-page flex min-h-[calc(100dvh-12rem)] min-w-0 flex-col gap-5" onDragOver={event => {if (event.dataTransfer.types.includes('Files')) event.preventDefault();}} onDrop={event => {if (!event.dataTransfer.files.length) return; event.preventDefault(); window.dispatchEvent(new CustomEvent('chat-files',{detail:Array.from(event.dataTransfer.files)}));}}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <div><h1 className="text-lg font-semibold">{detail.data?.conversation.title || 'Luna와 대화'}</h1><p className="text-xs text-muted-foreground">위키의 근거를 찾고, 답변을 노트로 다듬는다.</p></div>
      <div className="flex flex-wrap items-center gap-2">{id && <><ConversationPresence id={id}/><ConversationSharing id={id}/></>}<Button size="sm" variant="outline" disabled={creating} onClick={() => router.push('/chat?new=1')}>새 대화</Button></div>
    </header>
    {error != null && <ErrorNotice error={error}/>}
    {!id ? <div className="space-y-4">{creating ? <Loading label="새 대화를 만드는 중…"/> : <><EmptyState title="무엇이 궁금하신가요?" description="대화를 선택하거나 새 대화를 시작하세요."/><Button onClick={() => void create()} disabled={creating}>새 대화 시작</Button></>}{me.data && <ThreadsPanel userId={me.data.user.id}/>}</div> : detail.isPending ? <Loading label="대화를 불러오는 중…"/> : detail.isError || !detail.data ? <div><ErrorNotice error={detail.error}/><Button onClick={() => void detail.refetch()}>다시 불러오기</Button></div> : <>
      <section aria-label="대화 메시지" className="flex-1 space-y-6">
        {!messages.length && <EmptyState title="질문과 자료를 함께 보내세요" description="노트를 @로 첨부하거나 이미지·PDF를 끌어 놓을 수 있습니다."/>}
        <ol className="space-y-6">{messages.map(message => <li key={message.id}><ChatMessageView message={message} tools={tools[message.id]} disabled={streaming || readonly} onEdit={setEditing} onAction={(item,kind) => void action(item,kind)} onProposal={(item,mode) => setProposal({messageId:item.id,mode})}/></li>)}</ol>
        {streaming && <p role="status" aria-live="polite" className="animate-pulse text-xs text-muted-foreground">{phase}…</p>}
      </section>
      <div className="sticky bottom-0 z-10 bg-background pb-2 pt-3"><ChatComposer conversationId={id} disabled={readonly || !detail.data} streaming={streaming} onSubmit={input => void submit(input)} onStop={() => void stop()} edit={editing} onCancelEdit={() => setEditing(null)} onEditLast={() => {const last=messages.findLast(item => item.role==='user');if(last && !streaming && window.confirm('질문을 수정하면 이후 답변과 대화가 교체됩니다. 계속할까요?')) setEditing(last);}} onSaveLast={() => {const last=messages.findLast(item => item.role==='assistant' && item.status==='completed');if(last)setProposal({messageId:last.id,mode:'new'});}}/>{readonly && <p className="text-xs text-muted-foreground">공유된 대화를 읽는 권한입니다. 질문하려면 소유자에게 편집 권한을 요청하세요.</p>}</div>
      <div ref={bottom}/>
    </>}
    {id && proposal && <ChatProposal conversationId={id} messageId={proposal.messageId} mode={proposal.mode} onClose={() => setProposal(null)}/>}
  </div>;
}
