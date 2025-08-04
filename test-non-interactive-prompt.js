// Test script to verify non-interactive prompt includes detailed guidance
import { WorkflowExecutor } from './src/cli/simple-commands/automation-executor.js';

const executor = new WorkflowExecutor({
  enableClaude: true,
  nonInteractive: true,
  outputFormat: 'stream-json'
});

// Mock MLE-STAR workflow data
const workflow = {
  name: "MLE-STAR Machine Learning Engineering Workflow",
  agents: [{
    id: "search_agent",
    name: "Web Search & Foundation Agent", 
    type: "researcher",
    config: { 
      capabilities: ["neural_architecture_search", "hyperparameter_optimization", "model_discovery"] 
    }
  }]
};

const task = {
  id: "search_task",
  name: "Architecture Search",
  description: "Search for optimal ML architectures",
  assignTo: "search_agent",
  claudePrompt: "Search for state-of-the-art neural architectures for the given problem domain."
};

const agent = workflow.agents[0];

// Generate prompt for non-interactive mode
console.log("=== NON-INTERACTIVE ENHANCED PROMPT ===");
const prompt = executor.createTaskPrompt(task, agent, workflow);
console.log(prompt);
console.log("=== END PROMPT ===");

console.log("\n=== KEY SECTIONS INCLUDED ===");
console.log("✅ MLE-STAR Methodology Focus:", prompt.includes("MLE-STAR METHODOLOGY FOCUS"));
console.log("✅ Detailed Coordination Requirements:", prompt.includes("COORDINATION REQUIREMENTS"));
console.log("✅ Pipeline Awareness:", prompt.includes("WORKFLOW PIPELINE AWARENESS"));
console.log("✅ Execution Instructions:", prompt.includes("EXECUTION INSTRUCTIONS"));
console.log("✅ Success Criteria:", prompt.includes("SUCCESS CRITERIA"));
console.log("✅ Hooks Integration:", prompt.includes("HOOKS INTEGRATION"));
console.log("✅ Memory Storage:", prompt.includes("MEMORY STORAGE"));