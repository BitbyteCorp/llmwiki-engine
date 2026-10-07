import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [JobsModule],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
