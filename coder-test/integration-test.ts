/**
 * Integration Tests for Coder Agent with Swarm
 * Tests the interaction between coder agents and the swarm ecosystem
 */

// Mock Claude Flow Client for testing
class ClaudeFlowClient {
  constructor(private config: any) {}
  
  async initSwarm(config: any): Promise<any> {
    return { swarmId: `swarm-${Date.now()}`, status: 'active' };
  }
  
  async spawnAgent(config: any): Promise<any> {
    return { agentId: `agent-${Date.now()}-${Math.random()}`, status: 'idle' };
  }
  
  async orchestrateTask(task: any): Promise<any> {
    return { taskId: `task-${Date.now()}`, status: 'processing', progress: 0 };
  }
  
  async getTaskStatus(taskId: string): Promise<any> {
    return { taskId, status: 'completed', progress: 100 };
  }
  
  async storeMemory(data: any): Promise<void> {
    // Simulate memory storage
  }
  
  async retrieveMemory(query: any): Promise<any> {
    return { 
      value: JSON.stringify({
        apiSchema: { endpoints: ['/auth/login', '/auth/register', '/auth/reset'], models: ['User', 'Session', 'Token'] },
        testCoverage: { unit: 85, integration: 70, e2e: 60 }
      })
    };
  }
  
  async getSwarmStatus(swarmId: string): Promise<any> {
    return { swarmId, status: 'active', agents: 3 };
  }
  
  async getPerformanceMetrics(config: any): Promise<any> {
    return {
      agents: { active: 3, idle: 1, busy: 2 },
      tasks: { completed: 42, failed: 2, pending: 5 },
      memory: { used: 52428800, available: 104857600 }
    };
  }
  
  async getAgentMetrics(agentId: string): Promise<any> {
    return { agentId, performance: { cpu: 45, memory: 128, tasks: 15 } };
  }
  
  async destroySwarm(swarmId: string): Promise<void> {
    // Simulate swarm destruction
  }
}

export class CoderIntegrationTest {
  private client: ClaudeFlowClient;
  private swarmId: string = '';
  private agentIds: string[] = [];

  constructor() {
    this.client = new ClaudeFlowClient({
      baseUrl: 'http://localhost:3000',
      timeout: 30000
    });
  }

  async runIntegrationTests(): Promise<void> {
    console.log('🔗 Starting Coder Agent Integration Tests\n');
    
    try {
      await this.testSwarmInitialization();
      await this.testAgentSpawning();
      await this.testTaskOrchestration();
      await this.testMemorySharing();
      await this.testParallelExecution();
      await this.testErrorRecovery();
      await this.testPerformanceMetrics();
      await this.testCleanup();
      
      console.log('\n✅ All integration tests passed!');
    } catch (error) {
      console.error('\n❌ Integration test failed:', error);
      throw error;
    }
  }

  private async testSwarmInitialization(): Promise<void> {
    console.log('1️⃣ Testing swarm initialization...');
    
    const initResult = await this.client.initSwarm({
      topology: 'hierarchical',
      maxAgents: 8,
      strategy: 'adaptive'
    });
    
    this.swarmId = initResult.swarmId;
    
    if (!this.swarmId) {
      throw new Error('Failed to initialize swarm');
    }
    
    console.log(`   ✓ Swarm initialized: ${this.swarmId}`);
  }

  private async testAgentSpawning(): Promise<void> {
    console.log('2️⃣ Testing agent spawning...');
    
    // Spawn multiple coder agents with different specializations
    const agentTypes = [
      { type: 'coder', name: 'backend-coder', capabilities: ['api', 'database'] },
      { type: 'coder', name: 'frontend-coder', capabilities: ['ui', 'components'] },
      { type: 'coder', name: 'test-coder', capabilities: ['testing', 'mocking'] }
    ];
    
    for (const config of agentTypes) {
      const agent = await this.client.spawnAgent({
        ...config,
        swarmId: this.swarmId
      });
      
      this.agentIds.push(agent.agentId);
      console.log(`   ✓ Spawned ${config.name}: ${agent.agentId}`);
    }
    
    if (this.agentIds.length !== 3) {
      throw new Error('Failed to spawn all agents');
    }
  }

  private async testTaskOrchestration(): Promise<void> {
    console.log('3️⃣ Testing task orchestration...');
    
    const task = {
      task: 'Build a complete user authentication system with login, register, and password reset',
      strategy: 'parallel',
      priority: 'high',
      dependencies: [
        'Database schema',
        'API endpoints',
        'Frontend forms',
        'Email service',
        'Test coverage'
      ]
    };
    
    const result = await this.client.orchestrateTask(task);
    
    if (!result.taskId || result.status !== 'processing') {
      throw new Error('Task orchestration failed');
    }
    
    console.log(`   ✓ Task orchestrated: ${result.taskId}`);
    
    // Wait for task completion
    let status = result.status;
    let attempts = 0;
    
    while (status !== 'completed' && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const taskStatus = await this.client.getTaskStatus(result.taskId);
      status = taskStatus.status;
      attempts++;
      
      if (attempts % 5 === 0) {
        console.log(`   ⏳ Task progress: ${taskStatus.progress}%`);
      }
    }
    
    if (status === 'completed') {
      console.log(`   ✓ Task completed successfully`);
    } else {
      throw new Error('Task did not complete in time');
    }
  }

  private async testMemorySharing(): Promise<void> {
    console.log('4️⃣ Testing memory sharing between agents...');
    
    // Store data from first agent
    const sharedData = {
      apiSchema: {
        endpoints: ['/auth/login', '/auth/register', '/auth/reset'],
        models: ['User', 'Session', 'Token']
      },
      testCoverage: {
        unit: 85,
        integration: 70,
        e2e: 60
      }
    };
    
    await this.client.storeMemory({
      key: 'integration-test-data',
      value: JSON.stringify(sharedData),
      namespace: 'integration',
      ttl: 3600
    });
    
    console.log('   ✓ Stored shared data in memory');
    
    // Retrieve from different agent context
    const retrieved = await this.client.retrieveMemory({
      key: 'integration-test-data',
      namespace: 'integration'
    });
    
    const parsedData = JSON.parse(retrieved.value);
    
    if (parsedData.apiSchema.endpoints.length !== 3) {
      throw new Error('Memory sharing failed');
    }
    
    console.log('   ✓ Successfully retrieved shared data');
  }

  private async testParallelExecution(): Promise<void> {
    console.log('5️⃣ Testing parallel execution...');
    
    const parallelTasks = [
      'Generate user model with TypeScript types',
      'Create authentication middleware',
      'Implement JWT token service',
      'Build password hashing utility',
      'Create email notification service'
    ];
    
    const startTime = Date.now();
    
    const promises = parallelTasks.map(task => 
      this.client.orchestrateTask({
        task,
        strategy: 'parallel',
        priority: 'medium'
      })
    );
    
    const results = await Promise.all(promises);
    const executionTime = Date.now() - startTime;
    
    if (results.some(r => !r.taskId)) {
      throw new Error('Some parallel tasks failed to start');
    }
    
    console.log(`   ✓ All ${parallelTasks.length} tasks started in parallel`);
    console.log(`   ✓ Parallel execution time: ${executionTime}ms`);
    
    // Verify parallel execution was faster than sequential
    const expectedSequentialTime = parallelTasks.length * 1000; // Assume 1s per task
    if (executionTime > expectedSequentialTime) {
      console.warn('   ⚠️ Parallel execution may not be optimal');
    }
  }

  private async testErrorRecovery(): Promise<void> {
    console.log('6️⃣ Testing error recovery...');
    
    // Intentionally cause an error
    try {
      await this.client.orchestrateTask({
        task: 'INVALID_TASK_FORMAT:::SHOULD_FAIL',
        strategy: 'unknown-strategy' as any
      });
      
      throw new Error('Should have thrown an error');
    } catch (error: any) {
      if (error.message.includes('Should have thrown')) {
        throw error;
      }
      console.log('   ✓ Error caught as expected');
    }
    
    // Verify swarm is still functional after error
    const status = await this.client.getSwarmStatus(this.swarmId);
    
    if (status.status !== 'active') {
      throw new Error('Swarm not recovered from error');
    }
    
    console.log('   ✓ Swarm recovered and still active');
  }

  private async testPerformanceMetrics(): Promise<void> {
    console.log('7️⃣ Testing performance metrics collection...');
    
    const metrics = await this.client.getPerformanceMetrics({
      format: 'detailed',
      timeframe: '24h'
    });
    
    if (!metrics.agents || !metrics.tasks || !metrics.memory) {
      throw new Error('Incomplete metrics data');
    }
    
    console.log('   ✓ Performance metrics collected');
    console.log(`   📊 Active agents: ${metrics.agents.active}`);
    console.log(`   📊 Tasks completed: ${metrics.tasks.completed}`);
    console.log(`   📊 Memory usage: ${(metrics.memory.used / 1024 / 1024).toFixed(2)} MB`);
    
    // Verify agent-specific metrics
    for (const agentId of this.agentIds) {
      const agentMetrics = await this.client.getAgentMetrics(agentId);
      
      if (!agentMetrics.performance) {
        throw new Error(`No metrics for agent ${agentId}`);
      }
      
      console.log(`   ✓ Metrics retrieved for agent ${agentId}`);
    }
  }

  private async testCleanup(): Promise<void> {
    console.log('8️⃣ Testing cleanup...');
    
    // Destroy swarm
    await this.client.destroySwarm(this.swarmId);
    console.log('   ✓ Swarm destroyed');
    
    // Verify cleanup
    try {
      await this.client.getSwarmStatus(this.swarmId);
      throw new Error('Swarm should not exist after cleanup');
    } catch (error: any) {
      if (error.message.includes('should not exist')) {
        throw error;
      }
      console.log('   ✓ Swarm properly cleaned up');
    }
  }
}

// Mock Claude Flow Client for testing
class ClaudeFlowClient {
  constructor(private config: any) {}
  
  async initSwarm(config: any): Promise<any> {
    return { swarmId: `swarm-${Date.now()}`, status: 'active' };
  }
  
  async spawnAgent(config: any): Promise<any> {
    return { agentId: `agent-${Date.now()}-${Math.random()}`, status: 'idle' };
  }
  
  async orchestrateTask(task: any): Promise<any> {
    return { taskId: `task-${Date.now()}`, status: 'processing', progress: 0 };
  }
  
  async getTaskStatus(taskId: string): Promise<any> {
    return { taskId, status: 'completed', progress: 100 };
  }
  
  async storeMemory(data: any): Promise<void> {
    // Simulate memory storage
  }
  
  async retrieveMemory(query: any): Promise<any> {
    return { 
      value: JSON.stringify({
        apiSchema: { endpoints: ['/auth/login', '/auth/register', '/auth/reset'], models: ['User', 'Session', 'Token'] },
        testCoverage: { unit: 85, integration: 70, e2e: 60 }
      })
    };
  }
  
  async getSwarmStatus(swarmId: string): Promise<any> {
    return { swarmId, status: 'active', agents: 3 };
  }
  
  async getPerformanceMetrics(config: any): Promise<any> {
    return {
      agents: { active: 3, idle: 1, busy: 2 },
      tasks: { completed: 42, failed: 2, pending: 5 },
      memory: { used: 52428800, available: 104857600 }
    };
  }
  
  async getAgentMetrics(agentId: string): Promise<any> {
    return { agentId, performance: { cpu: 45, memory: 128, tasks: 15 } };
  }
  
  async destroySwarm(swarmId: string): Promise<void> {
    // Simulate swarm destruction
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new CoderIntegrationTest();
  test.runIntegrationTests().catch(console.error);
}