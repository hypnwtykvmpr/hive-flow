#!/usr/bin/env python3
"""
Enhanced Report Viewer for Hive Flow Benchmarks
Shows detailed metrics with file references and analysis.
"""

import json
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import subprocess
from dataclasses import dataclass
from collections import defaultdict

@dataclass
class BenchmarkReport:
    """Structured benchmark report with detailed metrics."""
    benchmark_id: str
    status: str
    duration: float
    metrics: Dict
    results: List[Dict]
    file_path: Path
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate from results."""
        if not self.results:
            return 0.0
        successful = sum(1 for r in self.results if r.get('status') == 'success')
        return successful / len(self.results)
    
    @property
    def total_tokens(self) -> int:
        """Calculate total tokens used."""
        total = 0
        for result in self.results:
            output = result.get('output', {})
            if isinstance(output, dict):
                total += output.get('token_count', 0)
        return total
    
    @property
    def average_execution_time(self) -> float:
        """Calculate average execution time."""
        times = [r.get('execution_time', 0) for r in self.results]
        return sum(times) / len(times) if times else 0

class EnhancedReportViewer:
    """View and analyze benchmark reports with detailed metrics."""
    
    def __init__(self, report_dir: Path = Path("reports")):
        self.report_dir = report_dir
        self.reports: List[BenchmarkReport] = []
    
    def load_reports(self, pattern: str = "benchmark_*.json") -> None:
        """Load all benchmark reports matching pattern."""
        if not self.report_dir.exists():
            print(f"❌ Report directory not found: {self.report_dir}")
            return
        
        json_files = list(self.report_dir.glob(pattern))
        print(f"📂 Found {len(json_files)} benchmark reports in {self.report_dir}")
        
        for file_path in json_files:
            try:
                with open(file_path) as f:
                    data = json.load(f)
                report = BenchmarkReport(
                    benchmark_id=data.get('benchmark_id', 'unknown'),
                    status=data.get('status', 'unknown'),
                    duration=data.get('duration', 0),
                    metrics=data.get('metrics', {}),
                    results=data.get('results', []),
                    file_path=file_path
                )
                self.reports.append(report)
            except Exception as e:
                print(f"⚠️  Failed to load {file_path}: {e}")
    
    def display_summary(self) -> None:
        """Display summary of all reports."""
        if not self.reports:
            print("No reports loaded")
            return
        
        print("\n" + "="*80)
        print("📊 BENCHMARK REPORTS SUMMARY")
        print("="*80)
        
        for i, report in enumerate(self.reports, 1):
            print(f"\n📋 Report {i}/{len(self.reports)}")
            print(f"  📄 File: {report.file_path}")
            print(f"  🆔 ID: {report.benchmark_id}")
            print(f"  ✅ Status: {report.status}")
            print(f"  ⏱️  Duration: {report.duration:.2f}s")
            print(f"  📈 Success Rate: {report.success_rate:.1%}")
            print(f"  🎯 Tasks: {len(report.results)}")
            
            # Display key metrics
            if report.metrics:
                print(f"\n  📊 Performance Metrics:")
                print(f"    • Wall Clock Time: {report.metrics.get('wall_clock_time', 'N/A'):.2f}s")
                print(f"    • Tasks/Second: {report.metrics.get('tasks_per_second', 'N/A'):.2f}")
                print(f"    • Peak Memory: {report.metrics.get('peak_memory_mb', 'N/A'):.1f} MB")
                print(f"    • Avg CPU: {report.metrics.get('average_cpu_percent', 'N/A'):.1f}%")
    
    def display_detailed_report(self, benchmark_id: Optional[str] = None) -> None:
        """Display detailed report for specific benchmark or latest."""
        if not self.reports:
            print("No reports loaded")
            return
        
        # Find report
        if benchmark_id:
            report = next((r for r in self.reports if r.benchmark_id == benchmark_id), None)
        else:
            # Get latest report
            report = max(self.reports, key=lambda r: r.file_path.stat().st_mtime)
        
        if not report:
            print(f"Report not found: {benchmark_id}")
            return
        
        print("\n" + "="*80)
        print("📊 DETAILED BENCHMARK REPORT")
        print("="*80)
        
        # File references
        print("\n📁 FILE REFERENCES:")
        print(f"  • Report: {report.file_path}")
        print(f"  • Metrics: {report.file_path.parent / f'metrics_{report.benchmark_id}.json'}")
        print(f"  • Process: {report.file_path.parent / f'process_report_{report.benchmark_id}.json'}")
        
        # Overview
        print(f"\n📋 OVERVIEW:")
        print(f"  • Benchmark ID: {report.benchmark_id}")
        print(f"  • Status: {report.status}")
        print(f"  • Total Duration: {report.duration:.3f}s")
        print(f"  • Success Rate: {report.success_rate:.1%}")
        
        # Performance metrics
        print(f"\n⚡ PERFORMANCE:")
        if report.metrics:
            print(f"  • Wall Clock Time: {report.metrics.get('wall_clock_time', 0):.3f}s")
            print(f"  • Tasks/Second: {report.metrics.get('tasks_per_second', 0):.2f}")
            print(f"  • Total Output Lines: {report.metrics.get('total_output_lines', 0)}")
        
        # Resource usage
        print(f"\n💾 RESOURCE USAGE:")
        if report.metrics:
            print(f"  • Peak Memory: {report.metrics.get('peak_memory_mb', 0):.1f} MB")
            print(f"  • Average CPU: {report.metrics.get('average_cpu_percent', 0):.1f}%")
        
        # Task details
        print(f"\n📝 TASK DETAILS:")
        for i, result in enumerate(report.results, 1):
            print(f"\n  Task {i}/{len(report.results)}:")
            print(f"    • ID: {result.get('task_id', 'N/A')}")
            print(f"    • Agent: {result.get('agent_id', 'N/A')}")
            print(f"    • Status: {result.get('status', 'N/A')}")
            print(f"    • Execution Time: {result.get('execution_time', 0):.3f}s")
            
            # Resource usage for this task
            usage = result.get('resource_usage', {})
            if usage:
                print(f"    • CPU: {usage.get('cpu_percent', 0):.1f}%")
                print(f"    • Memory: {usage.get('memory_mb', 0):.1f} MB")
            
            # Output preview
            output = result.get('output', {})
            if isinstance(output, dict) and 'lines' in output:
                lines = output['lines']
                if lines:
                    print(f"    • Output: {len(lines)} lines")
                    if len(lines) > 0:
                        preview = lines[0][:100] + "..." if len(lines[0]) > 100 else lines[0]
                        print(f"      Preview: {preview}")
            
            # Errors
            errors = result.get('errors', [])
            if errors:
                print(f"    • ⚠️  Errors: {len(errors)}")
                for error in errors[:2]:  # Show first 2 errors
                    print(f"      - {error[:80]}...")
    
    def analyze_trends(self) -> None:
        """Analyze trends across multiple benchmarks."""
        if len(self.reports) < 2:
            print("Need at least 2 reports for trend analysis")
            return
        
        print("\n" + "="*80)
        print("📈 TREND ANALYSIS")
        print("="*80)
        
        # Sort by file modification time
        sorted_reports = sorted(self.reports, key=lambda r: r.file_path.stat().st_mtime)
        
        # Calculate trends
        durations = [r.duration for r in sorted_reports]
        success_rates = [r.success_rate for r in sorted_reports]
        memory_usage = [r.metrics.get('peak_memory_mb', 0) for r in sorted_reports]
        
        print(f"\n📊 Performance Trends (last {len(sorted_reports)} runs):")
        
        # Duration trend
        if len(durations) >= 2:
            duration_change = ((durations[-1] - durations[0]) / durations[0]) * 100
            print(f"  • Duration: {durations[0]:.2f}s → {durations[-1]:.2f}s ({duration_change:+.1f}%)")
        
        # Success rate trend
        if len(success_rates) >= 2:
            sr_change = (success_rates[-1] - success_rates[0]) * 100
            print(f"  • Success Rate: {success_rates[0]:.1%} → {success_rates[-1]:.1%} ({sr_change:+.1f}pp)")
        
        # Memory trend
        if len(memory_usage) >= 2 and memory_usage[0] > 0:
            mem_change = ((memory_usage[-1] - memory_usage[0]) / memory_usage[0]) * 100
            print(f"  • Peak Memory: {memory_usage[0]:.1f}MB → {memory_usage[-1]:.1f}MB ({mem_change:+.1f}%)")
        
        # Best/worst performances
        print(f"\n🏆 Best & Worst:")
        best_duration = min(sorted_reports, key=lambda r: r.duration)
        worst_duration = max(sorted_reports, key=lambda r: r.duration)
        print(f"  • Fastest: {best_duration.duration:.2f}s ({best_duration.benchmark_id[:8]}...)")
        print(f"  • Slowest: {worst_duration.duration:.2f}s ({worst_duration.benchmark_id[:8]}...)")
        
        best_success = max(sorted_reports, key=lambda r: r.success_rate)
        print(f"  • Best Success: {best_success.success_rate:.1%} ({best_success.benchmark_id[:8]}...)")

def main():
    """Main entry point for enhanced report viewer."""
    import argparse
    
    parser = argparse.ArgumentParser(description="View and analyze Hive Flow benchmark reports")
    parser.add_argument("--dir", default="reports", help="Directory containing reports")
    parser.add_argument("--id", help="Specific benchmark ID to view")
    parser.add_argument("--summary", action="store_true", help="Show summary of all reports")
    parser.add_argument("--trends", action="store_true", help="Analyze trends across reports")
    parser.add_argument("--latest", action="store_true", help="Show latest report in detail")
    
    args = parser.parse_args()
    
    viewer = EnhancedReportViewer(Path(args.dir))
    viewer.load_reports()
    
    if args.summary or (not args.id and not args.trends and not args.latest):
        viewer.display_summary()
    
    if args.id or args.latest:
        viewer.display_detailed_report(args.id)
    
    if args.trends:
        viewer.analyze_trends()

if __name__ == "__main__":
    main()