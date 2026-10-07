import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

@Module({ imports: [AuthModule], controllers: [ExportController], providers: [ExportService], exports: [ExportService] })
export class ExportModule {}
