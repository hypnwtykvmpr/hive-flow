/**
 * V3 Claude-Flow Event Bus Unit Tests
 *
 * London School TDD - Behavior Verification
 * Tests event publishing and subscription
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMock, type MockedInterface } from '../../helpers/create-mock';

/**
 * Event bus interface (to be implemented)
 */
interface IEventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): Subscription;
  unsubscribe(subscription: Subscription): void;
  subscribeAll(handler: EventHandler): Subscription;
}

/**
 * Event store interface (collaborator)
 */
interface IEventStore {
  append(event: DomainEvent): Promise<void>;
  getByType(eventType: string): Promise<DomainEvent[]>;
  getAll(): Promise<DomainEvent[]>;
}

/**
 * Event dispatcher interface (collaborator)
 */
interface IEventDispatcher {
  dispatch(event: DomainEvent, handlers: EventHandler[]): Promise<void>;
}

interface DomainEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp: Date;
  correlationId?: string;
}

type EventHandler = (event: DomainEvent) => Promise<void>;

interface Subscription {
  id: string;
  eventType: string | '*';
  unsubscribe: () => void;
}

/**
 * Event bus implementation for testing
 */
class EventBus implements IEventBus {
  private handlers: Map<string, Set<{ id: string; handler: EventHandler }>> = new Map();
  private wildcardHandlers: Set<{ id: string; handler: EventHandler }> = new Set();
  private subscriptionCounter = 0;

  constructor(
    private readonly eventStore: IEventStore,
    private readonly dispatcher: IEventDispatcher,
    private readonly idGenerator: () => string = () => `sub-${Date.now()}`
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    // Store event first (event sourcing per ADR-007)
    await this.eventStore.append(event);

    // Get type-specific handlers
    const typeHandlers = this.handlers.get(event.type) ?? new Set();

    // Combine with wildcard handlers
    const allHandlers = [
      ...Array.from(typeHandlers).map(h => h.handler),
      ...Array.from(this.wildcardHandlers).map(h => h.handler),
    ];

    // Dispatch to all handlers
    if (allHandlers.length > 0) {
      await this.dispatcher.dispatch(event, allHandlers);
    }
  }

  subscribe(eventType: string, handler: EventHandler): Subscription {
    const id = this.idGenerator();

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }

    const handlerEntry = { id, handler };
    this.handlers.get(eventType)!.add(handlerEntry);

    return {
      id,
      eventType,
      unsubscribe: () => {
        this.handlers.get(eventType)?.delete(handlerEntry);
      },
    };
  }

  subscribeAll(handler: EventHandler): Subscription {
    const id = this.idGenerator();
    const handlerEntry = { id, handler };

    this.wildcardHandlers.add(handlerEntry);

    return {
      id,
      eventType: '*',
      unsubscribe: () => {
        this.wildcardHandlers.delete(handlerEntry);
      },
    };
  }

  unsubscribe(subscription: Subscription): void {
    subscription.unsubscribe();
  }
}

describe('EventBus', () => {
  let mockEventStore: MockedInterface<IEventStore>;
  let mockDispatcher: MockedInterface<IEventDispatcher>;
  let eventBus: EventBus;
  const mockIdGenerator = vi.fn().mockReturnValue('sub-123');

  beforeEach(() => {
    mockEventStore = createMock<IEventStore>();
    mockDispatcher = createMock<IEventDispatcher>();

    // Configure default mock behavior
    mockEventStore.append.mockResolvedValue(undefined);
    mockEventStore.getByType.mockResolvedValue([]);
    mockEventStore.getAll.mockResolvedValue([]);

    mockDispatcher.dispatch.mockResolvedValue(undefined);

    eventBus = new EventBus(mockEventStore, mockDispatcher, mockIdGenerator);
  });

  describe('publish', () => {
    it('should append event to event store', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockEventStore.append).toHaveBeenCalledWith(event);
    });

    it('should store event before dispatching', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const handler = vi.fn();
      eventBus.subscribe('TaskCreated', handler);

      let storeCallOrder = 0;
      let dispatchCallOrder = 0;
      let callCounter = 0;

      mockEventStore.append.mockImplementation(async () => {
        storeCallOrder = ++callCounter;
      });

      mockDispatcher.dispatch.mockImplementation(async () => {
        dispatchCallOrder = ++callCounter;
      });

      // When
      await eventBus.publish(event);

      // Then
      expect(storeCallOrder).toBeLessThan(dispatchCallOrder);
    });

    it('should dispatch to type-specific handlers', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const handler = vi.fn();
      eventBus.subscribe('TaskCreated', handler);

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        expect.arrayContaining([handler])
      );
    });

    it('should dispatch to wildcard handlers', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const wildcardHandler = vi.fn();
      eventBus.subscribeAll(wildcardHandler);

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        expect.arrayContaining([wildcardHandler])
      );
    });

    it('should dispatch to both type-specific and wildcard handlers', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const typeHandler = vi.fn();
      const wildcardHandler = vi.fn();
      eventBus.subscribe('TaskCreated', typeHandler);
      eventBus.subscribeAll(wildcardHandler);

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        expect.arrayContaining([typeHandler, wildcardHandler])
      );
    });

    it('should not dispatch when no handlers registered', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('should only dispatch to matching event type handlers', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const taskCreatedHandler = vi.fn();
      const taskCompletedHandler = vi.fn();
      eventBus.subscribe('TaskCreated', taskCreatedHandler);
      eventBus.subscribe('TaskCompleted', taskCompletedHandler);

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        expect.arrayContaining([taskCreatedHandler])
      );
      expect(mockDispatcher.dispatch).not.toHaveBeenCalledWith(
        event,
        expect.arrayContaining([taskCompletedHandler])
      );
    });

    it('should propagate event store errors', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      mockEventStore.append.mockRejectedValue(new Error('Store failed'));

      // When/Then
      await expect(eventBus.publish(event)).rejects.toThrow('Store failed');
    });

    it('should propagate dispatcher errors', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };
      const handler = vi.fn();
      eventBus.subscribe('TaskCreated', handler);
      mockDispatcher.dispatch.mockRejectedValue(new Error('Dispatch failed'));

      // When/Then
      await expect(eventBus.publish(event)).rejects.toThrow('Dispatch failed');
    });
  });

  describe('subscribe', () => {
    it('should return subscription with id', () => {
      // Given
      const handler = vi.fn();

      // When
      const subscription = eventBus.subscribe('TaskCreated', handler);

      // Then
      expect(subscription.id).toBe('sub-123');
    });

    it('should return subscription with event type', () => {
      // Given
      const handler = vi.fn();

      // When
      const subscription = eventBus.subscribe('TaskCreated', handler);

      // Then
      expect(subscription.eventType).toBe('TaskCreated');
    });

    it('should return subscription with unsubscribe function', () => {
      // Given
      const handler = vi.fn();

      // When
      const subscription = eventBus.subscribe('TaskCreated', handler);

      // Then
      expect(typeof subscription.unsubscribe).toBe('function');
    });

    it('should register handler for event type', async () => {
      // Given
      const handler = vi.fn();
      eventBus.subscribe('TaskCreated', handler);

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalled();
    });

    it('should allow multiple handlers for same event type', async () => {
      // Given
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      eventBus.subscribe('TaskCreated', handler1);
      eventBus.subscribe('TaskCreated', handler2);

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: { taskId: '123' },
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        expect.arrayContaining([handler1, handler2])
      );
    });
  });

  describe('subscribeAll', () => {
    it('should return subscription with wildcard event type', () => {
      // Given
      const handler = vi.fn();

      // When
      const subscription = eventBus.subscribeAll(handler);

      // Then
      expect(subscription.eventType).toBe('*');
    });

    it('should receive all event types', async () => {
      // Given
      const handler = vi.fn();
      eventBus.subscribeAll(handler);

      const event1: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
      };
      const event2: DomainEvent = {
        id: 'event-2',
        type: 'TaskCompleted',
        payload: {},
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event1);
      await eventBus.publish(event2);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('unsubscribe', () => {
    it('should remove handler from subscriptions', async () => {
      // Given
      const handler = vi.fn();
      const subscription = eventBus.subscribe('TaskCreated', handler);

      // When
      eventBus.unsubscribe(subscription);

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
      };
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('should only remove specific subscription', async () => {
      // Given
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const sub1 = eventBus.subscribe('TaskCreated', handler1);
      eventBus.subscribe('TaskCreated', handler2);

      // When
      eventBus.unsubscribe(sub1);

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
      };
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        event,
        [handler2]
      );
    });

    it('should remove wildcard subscription', async () => {
      // Given
      const handler = vi.fn();
      const subscription = eventBus.subscribeAll(handler);

      // When
      eventBus.unsubscribe(subscription);

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
      };
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('should work when called via subscription object', async () => {
      // Given
      const handler = vi.fn();
      const subscription = eventBus.subscribe('TaskCreated', handler);

      // When
      subscription.unsubscribe();

      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
      };
      await eventBus.publish(event);

      // Then
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('event sourcing compliance (ADR-007)', () => {
    it('should store all events regardless of handlers', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'UnhandledEvent',
        payload: {},
        timestamp: new Date(),
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockEventStore.append).toHaveBeenCalledWith(event);
    });

    it('should include correlation id when present', async () => {
      // Given
      const event: DomainEvent = {
        id: 'event-1',
        type: 'TaskCreated',
        payload: {},
        timestamp: new Date(),
        correlationId: 'correlation-123',
      };

      // When
      await eventBus.publish(event);

      // Then
      expect(mockEventStore.append).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'correlation-123',
        })
      );
    });
  });
});
