'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, History, MessageSquare, PanelRightClose, Plus, SquareArrowOutUpRight, X } from 'lucide-react';
import { api, type Message } from '@/lib/api';
import { cancelGeneration, resumeGeneration, sendMessage, streamMessageAction, type ChatMessageInput, type ChatStreamEvent } from '@/lib/chat-stream';
import { CHAT_OPEN_EVENT, type ChatOpenRequest, type ChatNoteContext } from '@/lib/chat-context';
import { ErrorNotice, Loading } from '@/components/common';
import { Button } from '@/components/ui/button';
import { useOptionalWorkspace } from '@/components/workspace/context';
import { isViewTab } from '@/components/workspace/layout';
import { ChatComposer } from './composer';
import { ThreadsPanel } from './threads';
import { ConversationSharing } from './sharing';
import { ConversationPresence } from './presence';
import { ChatMessageView } from './message-view';
import { ChatProposal } from './proposal';
import { toolWorkStep, type WorkStep } from './work-steps';

interface RunningStream { conversationId: string; controller: AbortController; generationId?: string; answerId: string; stopRequested?: boolean; onAccepted?: () => void }
const phases: Record<string, string> = { queued: '답변 준비 중', thinking: '생각 중', answering: '답변 작성 중', summarizing: '이전 대화 요약 중', tool: '위키 확인 중' };
const lastThreadKey = 'llmwiki.chat.last-thread.';
const examples = ['위키에서 최근 변경된 내용을 요약해 주세요.', '관련 노트를 찾아 공통점과 차이점을 설명해 주세요.', '첨부한 자료를 분석하고 중요한 내용을 정리해 주세요.'];

export function ChatPane({ variant, conversationId, onClose }: { variant: 'panel' | 'page'; conversationId?: string; onClose?: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const workspace = useOptionalWorkspace();
  const pathname = usePathname();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [panelId, setPanelId] = useState(conversationId);
  const id = variant === 'page' ? conversationId : panelId;
  const detail = useQuery({ queryKey: ['conversation', id], queryFn: () => api.conversation(id!), enabled: Boolean(id) });
  const [localMessages, setLocalMessages] = useState<Message[] | null>(null);
  const [steps, setSteps] = useState<Record<string, WorkStep[]>>({});
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [proposal, setProposal] = useState<{messageId: string; mode: 'new' | 'edit'} | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState(false);
  const [focusSearch, setFocusSearch] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<{key:number; files:File[]}>();
  const [prompt, setPrompt] = useState<{key:number; content:string; context?:ChatNoteContext}>();
  const [away, setAway] = useState(false);
  const active = useRef<RunningStream | null>(null);
  const routeId = useRef(id);
  routeId.current = id;
  const creationStarted = useRef(false);
  const panelRequested = useRef(Boolean(conversationId));
  const restoredUser = useRef<number | null>(null);
  const attached = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const sequence = useRef(0);

  const select = useCallback((next?: string) => {
    setHistory(false); setFocusSearch(false);
    if (variant === 'panel') { panelRequested.current = true; setPanelId(next); }
    else router.push(next ? `/chat/${encodeURIComponent(next)}` : '/chat');
  }, [variant, router]);
  useEffect(() => {
    if (variant !== 'panel' || !me.data || restoredUser.current === me.data.user.id) return;
    restoredUser.current = me.data.user.id;
    if (!panelRequested.current) { try { setPanelId(localStorage.getItem(lastThreadKey + me.data.user.id) || undefined); } catch { /* Storage is optional. */ } }
  }, [variant, me.data]);
  useEffect(() => {
    if (variant !== 'panel' || !me.data || !panelRequested.current && restoredUser.current !== me.data.user.id) return;
    try { if (id) localStorage.setItem(lastThreadKey + me.data.user.id, id); else localStorage.removeItem(lastThreadKey + me.data.user.id); } catch { /* Storage is optional. */ }
  }, [variant, id, me.data]);
  useEffect(() => {
    setLocalMessages(null); setSteps({}); setStreaming(false); setError(null); setEditing(null); setProposal(null); follow.current = true; setAway(false);
    return () => { active.current?.controller.abort(); active.current = null; attached.current.clear(); };
  }, [id]);

  const create = useCallback(async () => {
    if (creationStarted.current) return;
    creationStarted.current = true; setCreating(true); setError(null);
    try {
      const {conversation} = await api.createConversation();
      void queryClient.invalidateQueries({queryKey: ['conversations']});
      setHistory(false); setFocusSearch(false);
      if (variant === 'panel') { panelRequested.current = true; setPanelId(conversation.id); }
      else router.replace(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (failure) { setError(failure); }
    finally { creationStarted.current = false; setCreating(false); }
  }, [queryClient, router, variant]);
  const wantsNew = variant === 'page' && params.get('new') === '1';
  const wantsSearch = variant === 'page' && params.get('search') === '1';
  useEffect(() => { if (!id && wantsNew) void create(); }, [id, wantsNew, create]);
  useEffect(() => { if (wantsSearch) {setHistory(true); setFocusSearch(true);} }, [wantsSearch]);
  useEffect(() => {
    if (variant !== 'panel') return;
    const open = (event: Event) => {
      if (window.matchMedia('(max-width: 767px)').matches || pathname.startsWith('/chat')) return;
      panelRequested.current = true;
      const request = (event as CustomEvent<ChatOpenRequest>).detail || {};
      if (request.newThread) void create();
      else if (request.conversationId) select(request.conversationId);
      if (request.focusSearch) {setHistory(true);setFocusSearch(true);}
    };
    window.addEventListener(CHAT_OPEN_EVENT, open);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, open);
  }, [variant, create, select, pathname]);

  const run = useCallback(async (stream: RunningStream, operation: (handlers: {onEvent: (event: ChatStreamEvent) => void}, signal: AbortSignal) => Promise<Message | null>) => {
    active.current = stream; setStreaming(true); setError(null);
    const current = () => active.current === stream && routeId.current === stream.conversationId;
    const updateAnswer = (update: (message: Message) => Message) => {
      if (current()) setLocalMessages(previous => previous?.map(message => message.id === stream.answerId ? update(message) : message) ?? null);
    };
    const appendStep = (step: WorkStep) => setSteps(previous => ({...previous,[stream.answerId]:[...(previous[stream.answerId] ?? []).map(item => item.status === 'active' ? {...item,status:'done' as const} : item),step]}));
    try {
      await operation({onEvent: event => {
        if (!current()) return;
        switch (event.event) {
          case 'generation':
            stream.generationId = event.data.generationId;
            stream.onAccepted?.();
            if (stream.stopRequested) void cancelGeneration(event.data.generationId).catch(setError);
            setLocalMessages(previous => previous?.map(message => message.id.startsWith('local-user-') && event.data.userMessageId ? {...message, id: event.data.userMessageId} : message) ?? null);
            break;
          case 'status': appendStep({kind:'status',label:phases[event.data.phase] ?? '답변 생성 중',status:'active'}); break;
          case 'tool':
            setSteps(previous => {
              const list = [...(previous[stream.answerId] ?? [])];
              const match = event.data.state === 'end' ? list.findLastIndex(step => step.kind === 'tool' && step.status === 'active') : -1;
              const item = toolWorkStep(event.data);
              if (match >= 0) list[match] = item;
              else { for (let index=0;index<list.length;index++) if(list[index].status==='active') list[index]={...list[index],status:'done'}; list.push(item); }
              return {...previous,[stream.answerId]:list};
            }); break;
          case 'citation':
            updateAnswer(message => ({...message, citations:[...message.citations, event.data]}));
            appendStep({kind:'citation',label:`인용 · ${event.data.heading || event.data.path}`,path:event.data.path,status:'done'}); break;
          case 'delta': updateAnswer(message => ({...message,content:message.content + event.data.text})); break;
          case 'usage': updateAnswer(message => ({...message,usage:event.data})); break;
          case 'done':
            updateAnswer(() => event.data.message);
            setSteps(previous => ({...previous,[event.data.message.id]:(previous[stream.answerId] ?? []).map(step => ({...step,status:'done'}))})); break;
          case 'error':
            updateAnswer(message => ({...message,status:event.data.code === 'generation_cancelled' ? 'cancelled' : event.data.code === 'generation_interrupted' ? 'interrupted' : 'failed'}));
            if (event.data.code !== 'generation_cancelled') setError(new Error(event.data.message)); break;
        }
      }}, stream.controller.signal);
    } catch (failure) { if (current() && !stream.controller.signal.aborted) setError(failure); }
    finally {
      await Promise.allSettled([queryClient.invalidateQueries({queryKey:['conversation',stream.conversationId]}),queryClient.invalidateQueries({queryKey:['conversations']})]);
      if (current()) {
        const saved = queryClient.getQueryData<{messages:Message[]}>(['conversation',stream.conversationId])?.messages.findLast(message => message.role === 'assistant' && message.generationId === stream.generationId);
        if (saved) setSteps(previous => ({...previous,[saved.id]:previous[saved.id] ?? previous[stream.answerId] ?? []}));
        active.current = null; setStreaming(false); setLocalMessages(null);
      }
    }
  }, [queryClient]);

  useEffect(() => {
    if (!id || active.current || !detail.data) return;
    const message = detail.data.messages.findLast(message => message.role === 'assistant' && message.status === 'running');
    if (!message?.generationId || attached.current.has(message.generationId)) return;
    attached.current.add(message.generationId);
    setLocalMessages(detail.data.messages.map(item => item.id === message.id ? {...item,content:'',citations:[],usage:null} : item));
    void run({conversationId:id,controller:new AbortController(),generationId:message.generationId,answerId:message.id},(handlers,signal) => resumeGeneration(message.generationId!,handlers,signal));
  }, [detail.data,id,run,streaming]);
  const stop = useCallback(async () => {
    const stream = active.current;
    if (!stream) return;
    stream.stopRequested = true;
    if (stream.generationId) { try { await cancelGeneration(stream.generationId); } catch (failure) { setError(failure); } }
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && history) {event.preventDefault();setHistory(false);return;}
      if (event.key === 'Escape' && active.current) { event.preventDefault(); void stop(); }
    };
    window.addEventListener('keydown',keyboard);
    return () => window.removeEventListener('keydown',keyboard);
  }, [stop,history]);

  const messages = localMessages ?? detail.data?.messages ?? [];
  const submit = async (input: ChatMessageInput) => {
    if (!id || active.current || !detail.data) return false;
    const accepted = Promise.withResolvers<boolean>();
    const temporary = crypto.randomUUID();
    const answer: Message = {id:`local-answer-${temporary}`,role:'assistant',content:'',citations:[],attachments:[],context:null,status:'running',usage:null,model:input.model ?? null,effort:input.effort ?? null,createdAt:new Date().toISOString()};
    const previous = editing ? messages.slice(0,messages.findIndex(message => message.id === editing.id)+1).map(message => message.id === editing.id ? {...message,content:input.content} : message) : [...messages,{...answer,id:`local-user-${temporary}`,role:'user' as const,content:input.content,status:'completed' as const,attachments:input.attachments ?? [],context:input.context ?? null}];
    setLocalMessages([...previous,answer]); follow.current = true; setAway(false);
    const editId = editing?.id;
    void run({conversationId:id,controller:new AbortController(),answerId:answer.id,onAccepted:() => {setEditing(null);accepted.resolve(true);}},(handlers,signal) => editId ? streamMessageAction(id,editId,'edit',{content:input.content},handlers,signal) : sendMessage(id,input,handlers,signal)).finally(() => accepted.resolve(false));
    return accepted.promise;
  };
  const action = async (message: Message, kind: 'retry' | 'regenerate') => {
    if (!id || active.current) return;
    const index = messages.findIndex(item => item.id === message.id);
    const answer = {...message,id:`local-answer-${crypto.randomUUID()}`,role:'assistant' as const,content:'',citations:[],attachments:[],context:null,usage:null,status:'running' as const};
    setLocalMessages([...messages.slice(0,message.role === 'user' ? index+1 : index),answer]);
    await run({conversationId:id,controller:new AbortController(),answerId:answer.id},(handlers,signal) => streamMessageAction(id,message.id,kind,{},handlers,signal));
  };
  useEffect(() => {
    const element = viewport.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [messages.at(-1)?.content,messages.length,steps,history]);
  const readonly = detail.data?.conversation.role === 'viewer';
  const canAttach = Boolean(id && detail.data && !readonly && !streaming && !editing);
  const choosePrompt = (content:string,context?:ChatNoteContext) => {setPrompt({key:++sequence.current,content,context});if(!id)void create();};
  return <div data-chat-pane={variant} className={`chat-page relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background ${variant === 'panel' ? 'h-full' : 'h-[calc(100dvh-10rem)] min-h-96 rounded-lg border'}`} onDragOver={event => {if(canAttach && event.dataTransfer.types.includes('Files')) {event.preventDefault();setDragging(true);}}} onDragLeave={event => {if(!event.currentTarget.contains(event.relatedTarget as Node | null))setDragging(false);}} onDrop={event => {setDragging(false);if(!event.dataTransfer.files.length)return;event.preventDefault();if(canAttach)setFiles({key:++sequence.current,files:Array.from(event.dataTransfer.files)});}}>
    <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
      <h1 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground" title={detail.data?.conversation.title || '도니와 대화'}>{detail.data?.conversation.title || '도니와 대화'}</h1>
      <div className="flex shrink-0 items-center gap-0.5"><Button variant="ghost" size="icon-sm" aria-label="대화 기록" aria-expanded={history} onClick={() => {setHistory(value=>!value);setFocusSearch(false);}}><History className="size-4"/></Button><Button variant="ghost" size="icon-sm" aria-label="새 대화" disabled={creating} onClick={() => void create()}><Plus className="size-4"/></Button>{variant === 'panel' && id && <Button variant="ghost" size="icon-sm" aria-label="편집기 영역에서 대화 열기" onClick={() => router.push(`/chat/${encodeURIComponent(id)}`)}><SquareArrowOutUpRight className="size-4"/></Button>}{onClose && <Button variant="ghost" size="icon-sm" aria-label="대화 패널 닫기" onClick={onClose}><PanelRightClose className="size-4"/></Button>}</div>
    </header>
    {id && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1"><ConversationPresence id={id}/><ConversationSharing id={id}/></div>}
    {history ? <div className="min-h-0 flex-1 overflow-auto pt-2"><div className="flex justify-end px-2"><Button variant="ghost" size="icon-sm" aria-label="대화 기록 닫기" onClick={()=>setHistory(false)}><X className="size-4"/></Button></div><ThreadsPanel activeId={id} onSelect={select} onNew={()=>void create()} focusSearch={focusSearch} onDeleted={deleted=>{if(deleted===id)select();}}/></div> : <>
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto px-3 py-3" onScroll={event => {const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<80;setAway(!follow.current);}}>
        {error != null && <div className="mb-3"><ErrorNotice error={error}/></div>}
        {creating ? <Loading label="새 대화를 만드는 중…"/> : id && detail.isPending ? <Loading label="대화를 불러오는 중…"/> : id && (detail.isError || !detail.data) ? <div className="space-y-2"><ErrorNotice error={detail.error}/><Button variant="outline" onClick={()=>void detail.refetch()}>다시 불러오기</Button><Button variant="ghost" onClick={()=>select()}>대화 목록으로</Button></div> : <section aria-label="대화 메시지">
          {!messages.length && <div className="mx-auto flex max-w-xl flex-col gap-2 py-6"><div className="flex h-7 items-center gap-1.5 border-b"><span className="text-primary"><MessageSquare className="size-3.5"/></span><h2 className="text-label-13 font-semibold">안녕하세요, 도니입니다.</h2></div><p className="text-label-13 text-muted-foreground">위키의 근거를 함께 찾고 자료를 노트로 정리해 드립니다. 무엇을 도와드릴까요?</p><div className="divide-y border-y">{examples.map(example=><button key={example} className="w-full px-2 py-1.5 text-left text-label-13 hover:bg-accent" onClick={()=>choosePrompt(example)}>{example}</button>)}{workspace?.activePath && !isViewTab(workspace.activePath) && <button className="w-full px-2 py-1.5 text-left text-label-13 hover:bg-accent" onClick={()=>choosePrompt('이 노트의 핵심 내용을 설명해 주세요.',{notePath:workspace.activePath,...(workspace.noteInfo?.path===workspace.activePath ? {ref:workspace.noteInfo.updatedSha}: {})})}>현재 노트에 대해 질문하기<span className="mt-0.5 block truncate text-xs text-muted-foreground">{workspace.activePath}</span></button>}</div>{!id && <Button variant="outline" onClick={()=>{setHistory(true);setFocusSearch(true);}}>이전 대화 찾기</Button>}</div>}
          <ol className="space-y-4">{messages.map(message=><li key={message.id}><ChatMessageView message={message} steps={steps[message.id]} disabled={streaming || readonly} onEdit={setEditing} onAction={(item,kind)=>void action(item,kind)} onProposal={(item,mode)=>setProposal({messageId:item.id,mode})}/></li>)}</ol>
        </section>}
      </div>
      {away && <div className="pointer-events-none absolute bottom-56 left-0 right-0 flex justify-center"><Button className="pointer-events-auto" size="sm" variant="secondary" onClick={()=>{follow.current=true;setAway(false);if(viewport.current)viewport.current.scrollTo({top:viewport.current.scrollHeight,behavior:'smooth'});}}><ArrowDown className="size-4"/>최근 메시지로</Button></div>}
    </>}
    {id && detail.data && <div className="shrink-0 border-t bg-background p-2"><ChatComposer conversationId={id} files={files} prompt={prompt} disabled={readonly || !detail.data} streaming={streaming} onSubmit={submit} onStop={()=>void stop()} edit={editing} onCancelEdit={()=>setEditing(null)} onEditLast={()=>{const last=messages.findLast(item=>item.role==='user');if(last && !streaming && window.confirm('질문을 수정하면 이후 답변과 대화가 교체됩니다. 계속할까요?'))setEditing(last);}} onSaveLast={()=>{const last=messages.findLast(item=>item.role==='assistant' && item.status==='completed');if(last)setProposal({messageId:last.id,mode:'new'});}}/>{readonly && <p className="px-1 pt-2 text-xs text-muted-foreground">읽기 전용 대화입니다. 질문하려면 소유자에게 편집 권한을 요청하세요.</p>}</div>}
    {dragging && <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-y border-primary bg-background/90 p-3"><p className="text-center text-label-13 font-semibold text-primary">이미지·PDF·텍스트를 놓아 첨부하세요.<span className="mt-1 block text-xs font-normal text-muted-foreground">최대 10개 · 파일당 20 MB</span></p></div>}
    {id && proposal && <ChatProposal conversationId={id} messageId={proposal.messageId} mode={proposal.mode} onClose={()=>setProposal(null)}/>}
  </div>;
}
