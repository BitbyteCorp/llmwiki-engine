import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AclController } from './acl.controller.js';
import { AclService } from './acl.service.js';

@Global()
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AclController],
  providers: [AclService],
  exports: [AclService],
})
export class AclModule {}
