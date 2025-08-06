"""
Automation module for non-interactive batch processing and workflow management.

This module provides comprehensive automation capabilities for the benchmark system,
including batch processing, pipeline management, autonomous workflow execution,
resource pooling, and intelligent decision-making.

Key Components:
- BatchProcessor: Process multiple tasks in parallel batches
- PipelineManager: Manage complex multi-stage workflows
- WorkflowExecutor: Execute autonomous workflows without human intervention
- ResourcePool: Manage and allocate computational resources
- DecisionEngine: Make autonomous decisions based on context and performance
"""

from .decision_engine import DecisionEngine, DecisionContext, DecisionResult

# Import from existing implementation files - other agents will enhance these
try:
    from .batch_processor import BatchProcessor, BatchConfig, BatchResult
except ImportError:
    # Placeholder if not yet implemented
    class BatchProcessor: pass
    class BatchConfig: pass 
    class BatchResult: pass

try:
    from .pipeline_manager import PipelineManager, Pipeline, PipelineStage
except ImportError:
    # Placeholder if not yet implemented
    class PipelineManager: pass
    class Pipeline: pass
    class PipelineStage: pass

try:
    from .workflow_executor import WorkflowExecutor, WorkflowConfig, WorkflowResult
except ImportError:
    # Placeholder if not yet implemented  
    class WorkflowExecutor: pass
    class WorkflowConfig: pass
    class WorkflowResult: pass

try:
    from .resource_pool import ResourcePool
except ImportError:
    # Placeholder if not yet implemented
    class ResourcePool: pass

__all__ = [
    "BatchProcessor",
    "BatchConfig", 
    "BatchResult",
    "PipelineManager",
    "Pipeline",
    "PipelineStage",
    "WorkflowExecutor",
    "WorkflowConfig",
    "WorkflowResult",
    "ResourcePool",
    "DecisionEngine",
    "DecisionContext",
    "DecisionResult"
]