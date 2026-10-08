import { HttpException, Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import type { ResponseInputContent } from 'openai/resources/responses/responses';
import type { Logger } from 'pino';
import { DB, LOGGER } from '../common/tokens.js';
import { EventsService } from '../events/events.service.js';
import { AgentService } from '../agent/agent.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiError, notFound } from './api-error.js';
import { ConversationsRepository } from './conversations.repository.js';
import type { Message, SubmitMessage } from './conversations.types.js';
import { GenerationsService } from './generations.service.js';
import { AclService } from '../acl/acl.service.js';
import type { Db } from '../db/index.js';
import { chatUser, messageSources, readableTurns, redactMessage } from './acl-chat.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';

@Injectable()
export class ConversationsService implements OnModuleDestroy {
  private readonly presenceUsers = new Map<string, Map<number,{id:number;name:string;typing:boolean;expires:number}>>();
  private readonly presenceTimer = setInterval(() => this.expirePresence(),5000);
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly agent: AgentService,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly generations: GenerationsService,
    private readonly uploads: UploadsService,
    private readonly events: EventsService,
    private readonly acl: AclService,
    @Inject(DB) private readonly db: Db,
    private readonly writeJobs: WriteJobsService,
    @Optional() private readonly audit?: AuditService,
  ) { this.presenceTimer.unref(); }
  onModuleDestroy(): void { clearInterval(this.presenceTimer); }
  private access(id:string,userId:number,write=false,owner=false): void {
    const role=this.repository.role(id,userId);
    if (!role) notFound('Conversation not found');
    if ((write && role==='viewer') || (owner && role!=='owner')) throw new ApiError(403,'forbidden','Conversation permission denied');
  }
  private changed(id:string,messageId?:string): void {
    this.events.publish({type:'conversation.updated',conversationId:id,...(messageId ? {messageId} : {})},{userIds:this.repository.members(id).map(m=>m.userId)});
  }
  list(userId:number,q='') {
    const actor=chatUser(this.db,userId);
    const query=q.toLowerCase();
    return this.repository.list(userId).flatMap(conversation=>{
      const turns=readableTurns(this.db,this.acl,actor,this.repository.messages(conversation.id,userId));
      const title=turns.some(turn=>!turn.readable) ? '' : conversation.title;
      if(!q) return [{...conversation,title}];
      const match=turns.findLast(turn=>turn.readable && turn.message.content.toLowerCase().includes(query));
      if(!match && !title.toLowerCase().includes(query)) return [];
      const source=match?.message.content ?? title;
      const start=Math.max(0,source.toLowerCase().indexOf(query)-60);
      return [{...conversation,title,snippet:source.slice(start,start+240)}];
    });
  }
  create(userId:number,title?:string) { return this.repository.create(userId,title); }
  get(id:string,userId:number) {
    this.access(id,userId);
    const actor=chatUser(this.db,userId);
    const turns=readableTurns(this.db,this.acl,actor,this.repository.messages(id,userId));
    const conversation=this.repository.get(id,userId)!;
    return {conversation:{...conversation,title:turns.some(turn=>!turn.readable) ? '' : conversation.title},
      messages:turns.map(turn=>turn.readable ? {...turn.message,citations:turn.message.citations.filter(c=>this.acl.canRead(actor,c.path))} : redactMessage(this.acl,actor,turn.message))};
  }
  delete(id:string,userId:number):void {
    this.access(id,userId,false,true);
    this.idle(id);
    this.changed(id);
    this.repository.delete(id,userId);
    this.audit?.record({actorId:userId,action:'conversation.delete',target:id,outcome:'succeeded'});
  }
  rename(id:string,userId:number,title:string) {
    this.access(id,userId,true);this.repository.rename(id,title);this.changed(id);
    return {conversation:this.repository.get(id,userId)!};
  }
  private idle(id:string):void {
    if (this.generations.active(id)) throw new ApiError(409,'generation_active','Wait for the current answer or cancel it first');
  }
  async submit(id:string,userId:number,input:SubmitMessage) {
    this.access(id,userId,true);
    if(input.context) this.acl.assertRead(chatUser(this.db,userId),input.context.notePath);
    if(input.clientId) {
      const prior=this.generations.findClient(id,input.clientId);
      if(prior) return prior;
    }
    const model=this.agent.validateModel(input.model);
    const effort=this.agent.validateEffort(input.effort);
    await this.uploads.parts(userId,input.attachments ?? []);
    this.access(id,userId,true);
    if(input.clientId) {const prior=this.generations.findClient(id,input.clientId);if(prior)return prior;}
    this.idle(id);
    const user=this.repository.addMessage(id,userId,'user',input.content,[],{attachments:input.attachments,context:input.context,model,effort})!;
    this.changed(id,user.id);
    return this.begin(id,userId,user,model,effort,input.clientId);
  }
  private begin(id:string,userId:number,user:Message,model?:string,effort?:string,clientId?:string) {
    const actor=chatUser(this.db,userId);
    for(const path of messageSources(this.db,user)) this.acl.assertRead(actor,path);
    const policyKey=this.acl.policyKey(actor);
    const assertAccess=()=>{
      const current=chatUser(this.db,userId);
      if(this.acl.policyKey(current)!==policyKey) notFound('Message not found');
    };
    const assistant=this.repository.addMessage(id,userId,'assistant','',[],{status:'running',model,effort})!;
    return this.generations.start({conversationId:id,userMessageId:user.id,assistantMessageId:assistant.id,userId,clientId,model,effort},async(signal,emit)=>{
      let partial='';
      try {
        const turns=readableTurns(this.db,this.acl,actor,this.repository.messages(id,userId));
        const readable=turns.filter(turn=>turn.readable && turn.message.id!==assistant.id && (turn.message.role==='user'||turn.message.status==='completed'));
        const sources=new Set(readable.flatMap(turn=>turn.sources));
        if(sources.size) emit('sources',{paths:[...sources]});
        let history=readable.map(turn=>turn.message);
        // Stored summaries may contain another member's sources. Derive summaries only from this reader's visible turns.
        let summary='';
        const total=history.reduce((n,m)=>n+m.content.length,0);
        if(history.length>16 || total>48000) {
          let keep=history.length-1,budget=history[keep]?.content.length ?? 0;
          while(keep>0 && history.length-keep<12 && budget+history[keep-1].content.length<=32000) {keep--;budget+=history[keep].content.length;}
          if(keep>0) {
            const old=history.slice(0,keep);
            emit('status',{phase:'summarizing'});
            summary=await this.agent.summarize(old.map(m=>({role:m.role,content:m.content})),assertAccess);
            if(signal.aborted) throw new Error('Cancelled');
            history=history.slice(keep);
          }
        }
        const inputs:Array<{role:'user'|'assistant';content:string|ResponseInputContent[]}>=[];
        let attachmentBudget=25*1024*1024;
        const mapped=new Map<string,ResponseInputContent[]>();
        for(const m of [...history].reverse()) {
          const parts:ResponseInputContent[]=[];
          for(const uploadId of m.attachments) {
            const owner=this.repository.attachmentOwner(m.id,uploadId);
            if(owner===null) continue;
            const file=this.uploads.get(owner,uploadId);
            const replay=await this.uploads.parts(owner,[uploadId],attachmentBudget);
            if(replay.length) {
              const cost=file.upload.mediaType.startsWith('text/') ? Math.min(file.upload.size,32*1024) : file.upload.size;
              attachmentBudget=Math.max(0,attachmentBudget-cost);
            }
            parts.push(...replay);
          }
          mapped.set(m.id,parts);
        }
        for(const m of history) {
          const parts=mapped.get(m.id)!;
          inputs.push({role:m.role,content:parts.length ? [{type:'input_text',text:m.content},...parts] : m.content});
        }
        emit('status',{phase:'answering'});
        assertAccess();
        const answer=await this.agent.answer(inputs,text=>{
          if(signal.aborted)return;
          partial+=text;this.repository.finish(assistant.id,partial,'running');emit('delta',{text});
        },signal,{user:actor,model,effort,context:user.context ?? undefined,summary,assertAccess,
          ...(actor.role==='editor'||actor.role==='admin' ? {submitKnowledge:async(content:string)=>{
            signal.throwIfAborted();
            this.access(id,userId,true);
            assertAccess();
            const job=this.writeJobs.submit({userId,input:content,source:'chat',client:id,sourcePaths:[...sources]});
            return {jobId:job.id,status:'queued' as const};
          }} : {}),
          onSource:path=>{if(!signal.aborted){sources.add(path);emit('sources',{paths:[path]});}},
          onEvent:(event,data)=>{if(!signal.aborted)emit(event,data);}});
        if(signal.aborted)throw new Error('Cancelled');
        assertAccess();
        for(const citation of answer.citations) this.acl.assertRead(actor,citation.path);
        this.repository.finish(assistant.id,answer.text,'completed',answer.citations,answer.usage);
        this.changed(id,assistant.id);
        emit('done',{message:{...assistant,content:answer.text,status:'completed',citations:answer.citations,usage:answer.usage ?? null}});
      } catch(error) {
        const cancelled=signal.aborted;
        this.repository.finish(assistant.id,partial,cancelled?'cancelled':'failed');
        this.changed(id,assistant.id);
        if(!cancelled)this.log.error({err:error,conversationId:id},'Chat answer failed');
        emit('error',{code:cancelled?'generation_cancelled':'generation_failed',message:cancelled?'Answer generation cancelled':'Unable to generate an answer. Please retry.'});
      }
    });
  }
  retry(id:string,mid:string,userId:number) {
    this.access(id,userId,true);this.idle(id);
    const message=this.repository.message(id,mid,userId);if(!message)notFound('Message not found');
    const messages=this.repository.messages(id,userId), index=messages.findIndex(m=>m.id===mid);
    const turn=readableTurns(this.db,this.acl,chatUser(this.db,userId),messages).find(turn=>turn.message.id===mid);
    if(!turn?.readable) notFound('Message not found');
    const user=message.role==='user' ? message : messages.slice(0,index).reverse().find(m=>m.role==='user');
    if(!user)notFound('User message not found');
    for(const path of messageSources(this.db,user)) this.acl.assertRead(chatUser(this.db,userId),path);
    if(message.role==='assistant' && !['failed','cancelled','interrupted'].includes(message.status))throw new ApiError(409,'not_retryable','Only unsuccessful answers can be retried');
    const model=this.agent.validateModel(user.model ?? undefined);
    const effort=this.agent.validateEffort(user.effort ?? undefined);
    this.repository.truncate(id,user.id);
    return this.begin(id,userId,user,model,effort);
  }
  regenerate(id:string,mid:string,userId:number) {
    this.access(id,userId,true);this.idle(id);
    const messages=this.repository.messages(id,userId),index=messages.findIndex(m=>m.id===mid);
    if(index<0||messages[index].role!=='assistant')notFound('Assistant message not found');
    const user=messages.slice(0,index).reverse().find(m=>m.role==='user');if(!user)notFound('User message not found');
    const turn=readableTurns(this.db,this.acl,chatUser(this.db,userId),messages).find(turn=>turn.message.id===mid);
    if(!turn?.readable) notFound('Assistant message not found');
    const model=this.agent.validateModel(user.model ?? undefined);
    const effort=this.agent.validateEffort(user.effort ?? undefined);
    this.repository.truncate(id,user.id);
    return this.begin(id,userId,user,model,effort);
  }
  edit(id:string,mid:string,userId:number,content:string) {
    this.access(id,userId,true);this.idle(id);
    const user=this.repository.message(id,mid,userId);if(!user||user.role!=='user')notFound('User message not found');
    const turn=readableTurns(this.db,this.acl,chatUser(this.db,userId),this.repository.messages(id,userId)).find(turn=>turn.message.id===mid);
    if(!turn?.readable) notFound('User message not found');
    for(const path of messageSources(this.db,user)) this.acl.assertRead(chatUser(this.db,userId),path);
    const model=this.agent.validateModel(user.model ?? undefined);
    const effort=this.agent.validateEffort(user.effort ?? undefined);
    this.repository.truncate(id,mid);this.repository.edit(mid,content);this.changed(id,mid);
    return this.begin(id,userId,{...user,content},model,effort);
  }
  members(id:string,userId:number) {this.access(id,userId);return {members:this.repository.members(id)};}
  addMember(id:string,userId:number,email:string,role:'editor'|'viewer') {
    this.access(id,userId,false,true);if(!this.repository.addMember(id,email,role))notFound('User not found');this.changed(id);return this.members(id,userId);
  }
  removeMember(id:string,userId:number,target:number):void {
    this.access(id,userId,false,true);
    if(this.repository.role(id,target)==='owner')throw new ApiError(409,'owner_required','The owner cannot be removed');
    this.changed(id);this.repository.removeMember(id,target);
    this.audit?.record({actorId:userId,action:'conversation.member.remove',target:`${id}/${target}`,outcome:'succeeded'});
  }
  presence(id:string,userId:number,name:string,typing:boolean) {
    this.access(id,userId);
    let users=this.presenceUsers.get(id);if(!users){users=new Map();this.presenceUsers.set(id,users);}
    users.set(userId,{id:userId,name,typing,expires:Date.now()+30000});
    this.publishPresence(id,users);
    return {expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  private publishPresence(id:string,users:Map<number,{id:number;name:string;typing:boolean;expires:number}>):void {
    const members=this.repository.members(id).map(m=>m.userId);
    this.events.publish({type:'conversation.presence',conversationId:id,users:[...users.values()].filter(u=>members.includes(u.id)).map(({id,name,typing})=>({id,name,typing}))},{userIds:members});
  }
  private expirePresence():void {
    for(const [id,users] of this.presenceUsers){let changed=false;for(const [uid,user]of users)if(user.expires<=Date.now()){users.delete(uid);changed=true;}if(changed)this.publishPresence(id,users);if(!users.size)this.presenceUsers.delete(id);}
  }
  async proposal(id:string,mid:string,userId:number,mode:'new'|'edit',path?:string) {
    this.access(id,userId,true);
    const answer=this.repository.message(id,mid,userId);
    if(!answer||answer.role!=='assistant'||answer.status!=='completed')notFound('Completed answer not found');
    const actor=chatUser(this.db,userId);
    const turn=readableTurns(this.db,this.acl,actor,this.repository.messages(id,userId)).find(turn=>turn.message.id===mid);
    if(!turn?.readable) notFound('Completed answer not found');
    const policyKey=this.acl.policyKey(actor);
    try {
      const proposal=await this.agent.proposal(answer.content,mode,path,actor,()=>{
        if(this.acl.policyKey(chatUser(this.db,userId))!==policyKey) notFound('Completed answer not found');
      });
      this.access(id,userId,true);
      const current=chatUser(this.db,userId);
      const currentTurn=readableTurns(this.db,this.acl,current,this.repository.messages(id,userId)).find(turn=>turn.message.id===mid);
      if(!currentTurn?.readable) notFound('Completed answer not found');
      this.acl.assertWrite(current,proposal.path);
      if(this.acl.policyKey(current)!==policyKey) notFound('Completed answer not found');
      return proposal;
    } catch(error) {
      if(error instanceof ApiError || error instanceof HttpException) throw error;
      this.log.error({err:error},'Chat proposal failed');
      throw new ApiError(502,'proposal_failed','Unable to draft a note. Please retry.');
    }
  }
}
