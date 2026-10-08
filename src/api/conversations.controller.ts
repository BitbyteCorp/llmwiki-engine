import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { conversationMemberSchema, conversationQuerySchema, createConversationSchema, editMessageSchema, messageSchema, presenceSchema, proposalSchema, renameConversationSchema, userIdSchema } from './api.dto.js';
import { ConversationsService } from './conversations.service.js';
import { GenerationsService } from './generations.service.js';

@Controller('api/conversations')
@UseGuards(SessionGuard, RolesGuard)
export class ConversationsController {
  constructor(private readonly service: ConversationsService,private readonly generations:GenerationsService) {}
  @Get()
  list(@CurrentUser() user:User,@Query(new ZodValidationPipe(conversationQuerySchema)) query:z.infer<typeof conversationQuerySchema>) {
    return {conversations:this.service.list(user.id,query.q)};
  }
  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(createConversationSchema)) input:z.infer<typeof createConversationSchema>,@CurrentUser() user:User) {
    return {conversation:this.service.create(user.id,input.title)};
  }
  @Get(':id')
  get(@Param('id') id:string,@CurrentUser() user:User) {return this.service.get(id,user.id);}
  @Patch(':id')
  rename(@Param('id') id:string,@Body(new ZodValidationPipe(renameConversationSchema)) input:z.infer<typeof renameConversationSchema>,@CurrentUser() user:User) {return this.service.rename(id,user.id,input.title);}
  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id:string,@CurrentUser() user:User):void {this.service.delete(id,user.id);}
  @Post(':id/messages')
  @HttpCode(200)
  async sendMessage(@Param('id') id:string,@Body(new ZodValidationPipe(messageSchema)) input:z.infer<typeof messageSchema>,@CurrentUser() user:User,@Req() req:Request,@Res() res:Response):Promise<void> {
    const generation=await this.service.submit(id,user.id,input);
    this.generations.stream(generation.id,user.id,res,req.get('Last-Event-ID'));
  }
  @Patch(':id/messages/:mid')
  @HttpCode(200)
  edit(@Param('id') id:string,@Param('mid') mid:string,@Body(new ZodValidationPipe(editMessageSchema)) input:z.infer<typeof editMessageSchema>,@CurrentUser() user:User,@Req() req:Request,@Res() res:Response):void {
    const generation=this.service.edit(id,mid,user.id,input.content);
    this.generations.stream(generation.id,user.id,res,req.get('Last-Event-ID'));
  }
  @Post(':id/messages/:mid/regenerate')
  @HttpCode(200)
  regenerate(@Param('id') id:string,@Param('mid') mid:string,@CurrentUser() user:User,@Req() req:Request,@Res() res:Response):void {
    const generation=this.service.regenerate(id,mid,user.id);
    this.generations.stream(generation.id,user.id,res,req.get('Last-Event-ID'));
  }
  @Post(':id/messages/:mid/retry')
  @HttpCode(200)
  retry(@Param('id') id:string,@Param('mid') mid:string,@CurrentUser() user:User,@Req() req:Request,@Res() res:Response):void {
    const generation=this.service.retry(id,mid,user.id);
    this.generations.stream(generation.id,user.id,res,req.get('Last-Event-ID'));
  }
  @Get(':id/members')
  members(@Param('id') id:string,@CurrentUser() user:User) {return this.service.members(id,user.id);}
  @Post(':id/members')
  addMember(@Param('id') id:string,@Body(new ZodValidationPipe(conversationMemberSchema)) input:z.infer<typeof conversationMemberSchema>,@CurrentUser() user:User) {return this.service.addMember(id,user.id,input.email,input.role);}
  @Delete(':id/members/:userId')
  @HttpCode(204)
  removeMember(@Param('id') id:string,@Param('userId',new ZodValidationPipe(userIdSchema)) target:number,@CurrentUser() user:User):void {this.service.removeMember(id,user.id,target);}
  @Post(':id/presence')
  presence(@Param('id') id:string,@Body(new ZodValidationPipe(presenceSchema)) input:z.infer<typeof presenceSchema>,@CurrentUser() user:User) {return this.service.presence(id,user.id,user.name ?? user.email,input.typing);}
  @Post(':id/messages/:mid/proposal')
  @HttpCode(200)
  proposal(@Param('id') id:string,@Param('mid') mid:string,@Body(new ZodValidationPipe(proposalSchema)) input:z.infer<typeof proposalSchema>,@CurrentUser() user:User) {return this.service.proposal(id,mid,user.id,input.mode,input.path);}
}
