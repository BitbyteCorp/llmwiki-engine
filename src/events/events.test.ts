import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../auth/users.types.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

const user = (id: number, role: User['role'] = 'viewer'): User => ({ id, role, name: null, email: `${id}@example.com`, createdAt: '', lastLoginAt: null });
function connection(controller: EventsController, viewer: User) {
  const response = new EventEmitter();
  const frames: string[] = [];
  Object.assign(response, { setHeader: vi.fn(), flushHeaders: vi.fn(), write: (frame: string) => { frames.push(frame); return true; },
    end: () => response.emit('close') });
  controller.stream(viewer, response as Response);
  return { response, frames };
}

let db: Db;
let users: UsersService;
let acl: AclService;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  users = new UsersService(new UsersRepository(db));
  for (const id of [1, 2, 3]) users.create({ email: user(id).email, role: id === 3 ? 'admin' : 'viewer' });
  acl = new AclService(db, users, new AuditService(db));
});
afterEach(() => { vi.useRealTimers(); db.close(); });
describe('live event audience and transport', () => {
  it('hides private jobs from other viewers and delivers to owner/admin', () => {
    const bus = new EventsService();
    const controller = new EventsController(bus, acl, users);
    const owner = connection(controller, user(1));
    const other = connection(controller, user(2));
    const admin = connection(controller, user(3, 'admin'));
    bus.publish({ type: 'job.updated', jobId: 'secret', userId: 1, status: 'queued' }, { userIds: [1], admins: true });
    expect(owner.frames.join('')).toContain('id: 1\nevent: job.updated');
    expect(admin.frames.join('')).toContain('secret');
    expect(other.frames.join('')).not.toContain('secret');
    bus.publish({ type: 'main.updated', sha: 'abc', paths: ['index.md'] }, 'all');
    expect(other.frames.join('')).toContain('id: 2\nevent: main.updated');
    for (const client of [owner, other, admin]) client.response.emit('close');
  });

  it('sends 25-second heartbeats, continues sequence after reconnect and cleans listeners', () => {
    vi.useFakeTimers();
    const bus = new EventsService();
    const controller = new EventsController(bus, acl, users);
    const first = connection(controller, user(1));
    vi.advanceTimersByTime(25_000);
    expect(first.frames.at(-1)).toBe(': ping\n\n');
    bus.publish({ type: 'dream.updated', runId: 'one', status: 'succeeded' }, 'all');
    first.response.emit('close');
    const disconnectedFrames = first.frames.length;
    const second = connection(controller, user(1));
    bus.publish({ type: 'dream.updated', runId: 'two', status: 'succeeded' }, 'all');
    expect(second.frames.at(-1)).toBe('id: 2\nevent: dream.updated\ndata: {"type":"dream.updated","runId":"two","status":"succeeded"}\n\n');
    vi.advanceTimersByTime(25_000);
    expect(first.frames).toHaveLength(disconnectedFrames);
    second.response.emit('close');
  });

  it('closes live streams and stops their heartbeat when the application shuts down', () => {
    vi.useFakeTimers();
    const bus = new EventsService();
    const controller = new EventsController(bus, acl, users);
    const client = connection(controller, user(1));
    const closed = vi.fn();
    client.response.once('close', closed);
    controller.onModuleDestroy();
    expect(closed).toHaveBeenCalledOnce();
    bus.publish({ type: 'dream.updated', runId: 'after-shutdown', status: 'succeeded' }, 'all');
    vi.advanceTimersByTime(25_000);
    expect(client.frames).toEqual([': connected\n\n']);
  });
});
