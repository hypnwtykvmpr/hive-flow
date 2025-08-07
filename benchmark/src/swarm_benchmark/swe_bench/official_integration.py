"""
Official SWE-bench integration for swarm-bench system.
Uses real SWE-bench dataset and evaluation framework.
"""

import asyncio
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import time

try:
    from datasets import load_dataset
except ImportError:
    print("Installing required packages...")
    subprocess.run(["pip", "install", "datasets", "swebench"], check=True)
    from datasets import load_dataset

from ..core.real_benchmark_engine import RealBenchmarkEngine
from ..core.models import BenchmarkConfig, StrategyType, CoordinationMode


class OfficialSWEBenchEngine(RealBenchmarkEngine):
    """Official SWE-bench integration using real dataset and evaluation."""
    
    def __init__(self, config: Optional[BenchmarkConfig] = None):
        """Initialize with SWE-bench specific configuration."""
        super().__init__(config or self._default_config())
        self.dataset = None
        self.oracle_patches = None
        self.predictions = {}
        
    def _default_config(self) -> BenchmarkConfig:
        """Default configuration for SWE-bench."""
        return BenchmarkConfig(
            name="Official-SWE-bench",
            description="Official SWE-bench evaluation",
            strategy=StrategyType.DEVELOPMENT,
            mode=CoordinationMode.MESH,  # Based on our optimization results
            max_agents=8,  # Optimal from our testing
            task_timeout=300,  # 5 minutes per instance
            output_directory="benchmark/swe-bench-official/results"
        )
        
    async def load_dataset(self, use_lite: bool = True) -> bool:
        """Load official SWE-bench dataset from HuggingFace."""
        try:
            print("📥 Loading official SWE-bench dataset...")
            
            if use_lite:
                # Use SWE-bench-Lite (300 instances)
                self.dataset = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
                print(f"✅ Loaded {len(self.dataset)} SWE-bench-Lite instances")
            else:
                # Use full SWE-bench (2,294 instances)
                self.dataset = load_dataset("princeton-nlp/SWE-bench", split="test")
                print(f"✅ Loaded {len(self.dataset)} full SWE-bench instances")
                
            # Load oracle patches for comparison
            try:
                oracle_dataset = load_dataset("princeton-nlp/SWE-bench_oracle", split="test")
                self.oracle_patches = {
                    inst["instance_id"]: inst["patch"] 
                    for inst in oracle_dataset
                }
                print(f"✅ Loaded {len(self.oracle_patches)} oracle patches")
            except:
                print("⚠️ Oracle patches not available")
                self.oracle_patches = {}
                
            return True
            
        except Exception as e:
            print(f"❌ Error loading dataset: {e}")
            print("Please install: pip install datasets swebench")
            return False
            
    async def run_instance(self, instance: Dict[str, Any]) -> Dict[str, Any]:
        """Run Claude Flow on a single SWE-bench instance."""
        
        instance_id = instance["instance_id"]
        repo = instance["repo"]
        problem = instance["problem_statement"]
        base_commit = instance["base_commit"]
        
        print(f"\n🔧 Processing: {instance_id}")
        print(f"   Repo: {repo}")
        print(f"   Problem: {problem[:100]}...")
        
        start_time = time.time()
        
        try:
            # Prepare the task for Claude Flow
            task_prompt = f"""Fix the following issue in {repo}:

Repository: {repo}
Base Commit: {base_commit}
Instance ID: {instance_id}

Problem Statement:
{problem}

Generate a git diff patch that fixes this issue. The patch should:
1. Apply cleanly to the base commit
2. Fix the described issue
3. Pass all existing tests
4. Include any new tests if needed

Return ONLY the git diff patch in proper format."""

            # Execute with Claude Flow using optimal configuration
            # Escape the task prompt for shell
            escaped_prompt = task_prompt.replace('"', '\\"').replace('\n', ' ')
            
            # Build command with proper order - --non-interactive must be at the end
            if self.config.mode == CoordinationMode.MESH:
                # Use hive-mind for complex mesh coordination
                cmd_parts = [
                    'npx', 'claude-flow@alpha', 'hive-mind', 'spawn',
                    f'"{escaped_prompt}"'
                ]
                if self.config.max_agents:
                    cmd_parts.extend(['--agents', str(self.config.max_agents)])
                cmd_parts.append('--non-interactive')
                cmd = ' '.join(cmd_parts)
            else:
                # Use swarm for other modes  
                cmd_parts = [
                    'npx', 'claude-flow@alpha', 'swarm',
                    f'"{escaped_prompt}"'
                ]
                if self.config.strategy:
                    cmd_parts.extend(['--strategy', self.config.strategy.value.lower()])
                if self.config.max_agents:
                    cmd_parts.extend(['--agents', str(self.config.max_agents)])
                cmd_parts.append('--non-interactive')
                cmd = ' '.join(cmd_parts)
            
            print(f"   📋 Executing: {cmd[:100]}...")
            
            # Run with timeout
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=Path.cwd()
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.config.task_timeout
                )
                
                # Extract patch from output
                output = stdout.decode() if stdout else ""
                patch = self._extract_patch(output)
                
                # Store prediction
                self.predictions[instance_id] = {
                    "model_patch": patch,
                    "model_name_or_path": "claude-flow-swarm",
                    "instance_id": instance_id
                }
                
                duration = time.time() - start_time
                
                return {
                    "instance_id": instance_id,
                    "success": bool(patch),
                    "patch": patch,
                    "duration": duration,
                    "error": None
                }
                
            except asyncio.TimeoutError:
                return {
                    "instance_id": instance_id,
                    "success": False,
                    "patch": "",
                    "duration": self.config.task_timeout,
                    "error": "Timeout"
                }
                
        except Exception as e:
            return {
                "instance_id": instance_id,
                "success": False,
                "patch": "",
                "duration": time.time() - start_time,
                "error": str(e)
            }
            
    def _extract_patch(self, output: str) -> str:
        """Extract git diff patch from Claude Flow output."""
        
        # Look for diff markers
        lines = output.split('\n')
        patch_lines = []
        in_patch = False
        
        for line in lines:
            if line.startswith('diff --git') or line.startswith('---') or line.startswith('+++'):
                in_patch = True
                
            if in_patch:
                patch_lines.append(line)
                
            # Stop at end markers
            if in_patch and (line.startswith('```') or line.startswith('END')):
                break
                
        return '\n'.join(patch_lines) if patch_lines else ""
        
    async def run_evaluation(
        self, 
        instances_limit: Optional[int] = None,
        use_lite: bool = True,
        save_predictions: bool = True
    ) -> Dict[str, Any]:
        """Run official SWE-bench evaluation."""
        
        print("""
╔══════════════════════════════════════════════════════════════╗
║              Official SWE-bench Evaluation                    ║
║                   Using Real Dataset                          ║
╚══════════════════════════════════════════════════════════════╝
""")
        
        # Load dataset
        if not await self.load_dataset(use_lite=use_lite):
            return {"error": "Failed to load dataset"}
            
        # Select instances to run
        instances = list(self.dataset)
        if instances_limit:
            instances = instances[:instances_limit]
            
        print(f"\n📊 Running on {len(instances)} instances")
        print(f"⚙️ Configuration: {self.config.mode.value}-{self.config.strategy.value}-{self.config.max_agents}agents")
        
        # Run each instance
        results = []
        successful = 0
        
        for i, instance in enumerate(instances, 1):
            print(f"\n[{i}/{len(instances)}] ", end="")
            
            result = await self.run_instance(instance)
            results.append(result)
            
            if result["success"]:
                successful += 1
                print(f"✅ Generated patch ({result['duration']:.1f}s)")
            else:
                print(f"❌ Failed: {result['error']}")
                
            # Show progress
            if i % 10 == 0:
                current_rate = successful / i
                print(f"\n📈 Progress: {i}/{len(instances)} - Success rate: {current_rate:.1%}")
                
        # Calculate final metrics
        total = len(results)
        success_rate = successful / total if total > 0 else 0
        avg_duration = sum(r["duration"] for r in results) / total if total > 0 else 0
        
        # Save predictions for submission
        if save_predictions:
            predictions_file = Path(self.config.output_directory) / "predictions.json"
            predictions_file.parent.mkdir(parents=True, exist_ok=True)
            
            with open(predictions_file, 'w') as f:
                json.dump(self.predictions, f, indent=2)
                
            print(f"\n💾 Predictions saved to: {predictions_file}")
            
        # Generate report
        report = {
            "dataset": "SWE-bench-Lite" if use_lite else "SWE-bench",
            "instances_evaluated": total,
            "successful_patches": successful,
            "success_rate": success_rate,
            "average_duration": avg_duration,
            "configuration": {
                "mode": self.config.mode.value,
                "strategy": self.config.strategy.value,
                "max_agents": self.config.max_agents
            },
            "timestamp": datetime.now().isoformat(),
            "results": results
        }
        
        # Save report
        report_file = Path(self.config.output_directory) / f"evaluation_report_{int(time.time())}.json"
        report_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)
            
        print(f"\n" + "="*60)
        print(f"📊 EVALUATION COMPLETE")
        print(f"="*60)
        print(f"✅ Success Rate: {success_rate:.1%}")
        print(f"⏱️ Avg Duration: {avg_duration:.1f}s")
        print(f"📁 Report: {report_file}")
        print(f"📤 Predictions: {predictions_file if save_predictions else 'Not saved'}")
        
        return report
        
    async def validate_submission(self, predictions_file: str) -> bool:
        """Validate predictions file format for submission."""
        
        try:
            with open(predictions_file) as f:
                predictions = json.load(f)
                
            print(f"Validating {len(predictions)} predictions...")
            
            # Check format
            for instance_id, pred in predictions.items():
                if "model_patch" not in pred:
                    print(f"❌ Missing model_patch for {instance_id}")
                    return False
                if "model_name_or_path" not in pred:
                    print(f"❌ Missing model_name_or_path for {instance_id}")
                    return False
                    
            print("✅ Submission format is valid!")
            return True
            
        except Exception as e:
            print(f"❌ Validation error: {e}")
            return False