/**
 * Performance Benchmark Suite for Coder Agent
 * Comprehensive performance testing and metrics
 */

import { performance } from 'perf_hooks';

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  stdDev: number;
  opsPerSecond: number;
}

export class CoderBenchmark {
  private results: BenchmarkResult[] = [];

  async runBenchmark(
    name: string,
    fn: () => Promise<any>,
    iterations: number = 100
  ): Promise<BenchmarkResult> {
    const times: number[] = [];
    
    console.log(`⏱️ Running benchmark: ${name}`);
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      const end = performance.now();
      times.push(end - start);
      
      if (i % 10 === 0) {
        process.stdout.write(`\r  Progress: ${i + 1}/${iterations}`);
      }
    }
    
    console.log('\n');

    const totalTime = times.reduce((a, b) => a + b, 0);
    const avgTime = totalTime / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    
    // Calculate standard deviation
    const variance = times.reduce((sum, time) => {
      return sum + Math.pow(time - avgTime, 2);
    }, 0) / iterations;
    const stdDev = Math.sqrt(variance);
    
    const result: BenchmarkResult = {
      name,
      iterations,
      totalTime,
      avgTime,
      minTime,
      maxTime,
      stdDev,
      opsPerSecond: 1000 / avgTime
    };
    
    this.results.push(result);
    return result;
  }

  async runSuite(): Promise<void> {
    console.log('🚀 Starting Coder Agent Performance Benchmark Suite\n');
    
    // Benchmark 1: Simple function generation
    await this.runBenchmark('Simple Function Generation', async () => {
      // Simulate coder agent generating a simple function
      const code = `function add(a: number, b: number): number {
        return a + b;
      }`;
      await this.processCode(code);
    });

    // Benchmark 2: Complex class generation
    await this.runBenchmark('Complex Class Generation', async () => {
      // Simulate generating a complex class
      const code = `class UserService {
        private users: Map<string, User> = new Map();
        
        async createUser(data: UserInput): Promise<User> {
          const user = new User(data);
          this.users.set(user.id, user);
          return user;
        }
        
        async updateUser(id: string, data: Partial<UserInput>): Promise<User> {
          const user = this.users.get(id);
          if (!user) throw new Error('User not found');
          Object.assign(user, data);
          return user;
        }
      }`;
      await this.processCode(code);
    }, 50); // Fewer iterations for complex operations

    // Benchmark 3: Parallel task processing
    await this.runBenchmark('Parallel Task Processing', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        type: 'code-gen'
      }));
      await Promise.all(tasks.map(t => this.processTask(t)));
    }, 20);

    // Benchmark 4: Code refactoring
    await this.runBenchmark('Code Refactoring', async () => {
      const messyCode = `function x(a,b,c){var d=a+b;d=d*c;if(d>100){return d;}else{return 0;}}`;
      await this.refactorCode(messyCode);
    });

    // Benchmark 5: Test generation
    await this.runBenchmark('Test Generation', async () => {
      const functionCode = `function validateInput(input: string): boolean {
        return input.length > 0 && input.length < 100;
      }`;
      await this.generateTests(functionCode);
    }, 50);

    // Benchmark 6: Memory operations
    await this.runBenchmark('Memory Store/Retrieve', async () => {
      const key = `bench-${Date.now()}`;
      const data = { code: 'sample', metrics: { lines: 100 } };
      await this.storeMemory(key, data);
      await this.retrieveMemory(key);
    }, 200);

    // Benchmark 7: Code analysis
    await this.runBenchmark('Code Analysis', async () => {
      const code = `
        class ComplexClass {
          private data: any[];
          constructor() { this.data = []; }
          process() { return this.data.map(x => x * 2); }
        }
      `;
      await this.analyzeCode(code);
    });

    // Print results
    this.printResults();
  }

  private async processCode(_code: string): Promise<void> {
    // Simulate code processing
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
  }

  private async processTask(_task: any): Promise<void> {
    // Simulate task processing
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
  }

  private async refactorCode(code: string): Promise<string> {
    // Simulate refactoring
    await new Promise(resolve => setTimeout(resolve, Math.random() * 15));
    return code.replace('var', 'const').replace('function', 'const');
  }

  private async generateTests(_code: string): Promise<string[]> {
    // Simulate test generation
    await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
    return ['test1', 'test2', 'test3'];
  }

  private async storeMemory(_key: string, _data: any): Promise<void> {
    // Simulate memory storage
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2));
  }

  private async retrieveMemory(_key: string): Promise<any> {
    // Simulate memory retrieval
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1));
    return {};
  }

  private async analyzeCode(code: string): Promise<any> {
    // Simulate code analysis
    await new Promise(resolve => setTimeout(resolve, Math.random() * 25));
    return { complexity: 'medium', lines: code.split('\n').length };
  }

  private printResults(): void {
    console.log('\n📊 Benchmark Results\n');
    console.log('═'.repeat(80));
    
    const headers = ['Benchmark', 'Iterations', 'Avg (ms)', 'Min (ms)', 'Max (ms)', 'Ops/sec'];
    const widths = [30, 12, 12, 12, 12, 12];
    
    // Print headers
    headers.forEach((header, i) => {
      process.stdout.write(header.padEnd(widths[i]));
    });
    console.log();
    console.log('─'.repeat(80));
    
    // Print results
    this.results.forEach(result => {
      const row = [
        result.name.substring(0, 28),
        result.iterations.toString(),
        result.avgTime.toFixed(2),
        result.minTime.toFixed(2),
        result.maxTime.toFixed(2),
        result.opsPerSecond.toFixed(1)
      ];
      
      row.forEach((cell, i) => {
        process.stdout.write(cell.padEnd(widths[i]));
      });
      console.log();
    });
    
    console.log('═'.repeat(80));
    
    // Print summary
    console.log('\n📈 Performance Summary:');
    const fastestOp = this.results.reduce((max, r) => 
      r.opsPerSecond > max.opsPerSecond ? r : max
    );
    const slowestOp = this.results.reduce((min, r) => 
      r.opsPerSecond < min.opsPerSecond ? r : min
    );
    
    console.log(`  ⚡ Fastest: ${fastestOp.name} (${fastestOp.opsPerSecond.toFixed(1)} ops/sec)`);
    console.log(`  🐌 Slowest: ${slowestOp.name} (${slowestOp.opsPerSecond.toFixed(1)} ops/sec)`);
    
    const totalOps = this.results.reduce((sum, r) => sum + r.iterations, 0);
    const totalTime = this.results.reduce((sum, r) => sum + r.totalTime, 0);
    console.log(`  📊 Total: ${totalOps} operations in ${(totalTime / 1000).toFixed(2)} seconds`);
  }
}

// Run benchmarks if executed directly
if (require.main === module) {
  const benchmark = new CoderBenchmark();
  benchmark.runSuite().catch(console.error);
}