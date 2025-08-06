"""
Non-Interactive Automation Module.

This module provides batch processing, pipeline management, and autonomous workflow
execution capabilities for running benchmarks without human intervention.
"""

from .batch_processor import BatchProcessor, BatchConfig, BatchResult
from .pipeline_manager import PipelineManager, Pipeline, PipelineStage
from .workflow_executor import WorkflowExecutor, WorkflowConfig, WorkflowResult
from .resource_pool import ResourcePool, ResourceManager
from .decision_engine import DecisionEngine, AutomationDecision

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
    "ResourceManager",
    "DecisionEngine",
    "AutomationDecision",
]