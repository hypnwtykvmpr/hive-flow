"""SWE-Bench CLI command integration."""

import click
import asyncio
import json
from pathlib import Path
from typing import Optional

from ..swe_bench import SWEBenchEngine
from ..core.models import BenchmarkConfig, StrategyType, CoordinationMode


@click.group()
@click.pass_context
def swe_bench(ctx):
    """Run SWE-Bench software engineering benchmarks."""
    ctx.ensure_object(dict)


@swe_bench.command()
@click.option('--categories', '-c', multiple=True, help='Categories to test')
@click.option('--difficulty', '-d', type=click.Choice(['easy', 'medium', 'hard']), help='Difficulty level')
@click.option('--strategy', '-s', type=click.Choice(['development', 'optimization', 'testing', 'analysis']), 
              default='development', help='Execution strategy')
@click.option('--mode', '-m', type=click.Choice(['hierarchical', 'mesh', 'distributed', 'centralized']),
              default='hierarchical', help='Coordination mode')
@click.option('--agents', '-a', type=int, default=5, help='Maximum number of agents')
@click.option('--optimize', '-o', is_flag=True, help='Enable optimization iterations')
@click.option('--iterations', '-i', type=int, default=1, help='Number of iterations')
@click.option('--output', '-o', type=click.Path(), help='Output directory for reports')
@click.pass_context
def run(ctx, categories, difficulty, strategy, mode, agents, optimize, iterations, output):
    """Run SWE-Bench benchmark suite."""
    
    # Create configuration
    config = BenchmarkConfig(
        name="SWE-Bench",
        description="Software Engineering Benchmark",
        strategy=StrategyType[strategy.upper()],
        mode=CoordinationMode[mode.upper()],
        max_agents=agents,
        output_directory=output or "benchmark/swe-bench/reports"
    )
    
    # Initialize engine
    engine = SWEBenchEngine(config)
    
    # Convert categories tuple to list
    category_list = list(categories) if categories else None
    
    # Run benchmark
    click.echo(f"\n🚀 Starting SWE-Bench with {iterations} iteration(s)")
    click.echo(f"   Strategy: {strategy}, Mode: {mode}, Agents: {agents}")
    
    if category_list:
        click.echo(f"   Categories: {', '.join(category_list)}")
    if difficulty:
        click.echo(f"   Difficulty: {difficulty}")
        
    results = asyncio.run(engine.run_swe_benchmark(
        categories=category_list,
        difficulty=difficulty,
        optimize=optimize,
        iterations=iterations
    ))
    
    # Display summary
    summary = results.get('summary', {})
    final_perf = summary.get('final_performance', {})
    
    click.echo("\n📊 SWE-Bench Results:")
    click.echo(f"   Success Rate: {final_perf.get('success_rate', 0):.1%}")
    click.echo(f"   Average Duration: {final_perf.get('average_duration', 0):.2f}s")
    click.echo(f"   Total Tasks: {final_perf.get('total_tasks', 0)}")
    
    if optimize and summary.get('improvement'):
        imp = summary['improvement']
        click.echo(f"\n📈 Optimization Impact:")
        click.echo(f"   Success Rate Change: {imp.get('success_rate_change', 0):+.1%}")
        click.echo(f"   Duration Change: {imp.get('duration_change', 0):+.2f}s")
        
    click.echo(f"\n✅ Report saved to {config.output_directory}")


@swe_bench.command()
@click.option('--output', '-o', type=click.Path(), help='Output directory')
@click.pass_context
def status(ctx, output):
    """Show current SWE-Bench status and recent results."""
    
    output_dir = Path(output or "benchmark/swe-bench/reports")
    
    if not output_dir.exists():
        click.echo("No SWE-Bench results found.")
        return
        
    # Find most recent report
    reports = list(output_dir.glob("swe_bench_report_*.json"))
    
    if not reports:
        click.echo("No SWE-Bench reports found.")
        return
        
    latest = max(reports, key=lambda p: p.stat().st_mtime)
    
    with open(latest) as f:
        data = json.load(f)
        
    click.echo(f"\n📊 Latest SWE-Bench Results ({latest.name}):")
    click.echo(f"   Timestamp: {data.get('timestamp', 'Unknown')}")
    
    summary = data.get('summary', {})
    final_perf = summary.get('final_performance', {})
    
    click.echo(f"\n   Performance:")
    click.echo(f"   - Success Rate: {final_perf.get('success_rate', 0):.1%}")
    click.echo(f"   - Tasks Completed: {final_perf.get('successful_tasks', 0)}/{final_perf.get('total_tasks', 0)}")
    click.echo(f"   - Average Duration: {final_perf.get('average_duration', 0):.2f}s")
    
    if summary.get('improvement'):
        imp = summary['improvement']
        click.echo(f"\n   Optimization Results:")
        click.echo(f"   - Success Rate Improved: {imp.get('success_rate_change', 0):+.1%}")
        click.echo(f"   - Speed Change: {imp.get('duration_change', 0):+.2f}s")
        click.echo(f"   - Optimization Effective: {'✅' if imp.get('optimization_effective') else '❌'}")


@swe_bench.command()
@click.option('--target-success', '-s', type=float, default=0.8, help='Target success rate')
@click.option('--target-duration', '-d', type=float, default=15.0, help='Target average duration')
@click.option('--max-iterations', '-i', type=int, default=10, help='Maximum optimization iterations')
@click.option('--output', '-o', type=click.Path(), help='Output directory')
@click.pass_context
def optimize(ctx, target_success, target_duration, max_iterations, output):
    """Run automated optimization to achieve target metrics."""
    
    from ..swe_bench.optimizer import SWEBenchOptimizer
    
    click.echo(f"\n🔧 Starting SWE-Bench Optimization")
    click.echo(f"   Target Success Rate: {target_success:.1%}")
    click.echo(f"   Target Duration: {target_duration}s")
    click.echo(f"   Max Iterations: {max_iterations}")
    
    # Initialize optimizer
    optimizer = SWEBenchOptimizer()
    
    # Run auto-tuning
    config = optimizer.auto_tune(
        target_metrics={
            'success_rate': target_success,
            'average_duration': target_duration
        },
        max_iterations=max_iterations
    )
    
    click.echo(f"\n✅ Optimization Complete!")
    click.echo(f"   Optimal Configuration:")
    click.echo(f"   - Strategy: {config.strategy.value}")
    click.echo(f"   - Mode: {config.mode.value}")
    click.echo(f"   - Max Agents: {config.max_agents}")
    click.echo(f"   - Task Timeout: {config.task_timeout}s")
    
    # Save configuration
    output_dir = Path(output or "benchmark/swe-bench/configs")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    config_path = output_dir / "optimized_config.json"
    with open(config_path, 'w') as f:
        json.dump({
            'strategy': config.strategy.value,
            'mode': config.mode.value,
            'max_agents': config.max_agents,
            'task_timeout': config.task_timeout,
            'max_retries': config.max_retries
        }, f, indent=2)
        
    click.echo(f"\n💾 Configuration saved to {config_path}")