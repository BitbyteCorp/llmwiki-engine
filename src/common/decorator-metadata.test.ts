import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class GreetingDependency {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

@Injectable()
class GreetingConsumer {
  constructor(readonly dependency: GreetingDependency) {}

  greet(name: string): string {
    return this.dependency.greet(name);
  }
}

describe('constructor type injection', () => {
  it('resolves a dependency using emitted decorator metadata without an explicit token', async () => {
    expect(Reflect.getMetadata('design:paramtypes', GreetingConsumer)).toEqual([GreetingDependency]);
    const module = await Test.createTestingModule({
      providers: [GreetingDependency, GreetingConsumer],
    }).compile();
    try {
      const consumer = module.get(GreetingConsumer);
      expect(consumer.dependency).toBe(module.get(GreetingDependency));
      expect(consumer.greet('Wiki reader')).toBe('Hello, Wiki reader!');
    } finally {
      await module.close();
    }
  });
});
