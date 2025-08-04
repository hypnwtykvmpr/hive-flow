// Test script to verify enhanced prompt generation
import { WorkflowExecutor } from './src/cli/simple-commands/automation-executor.js';

const executor = new WorkflowExecutor({
  enableClaude: true,
  nonInteractive: false
});

// Mock workflow data
const workflow = {
  name: "Test Workflow",
  agents: [{
    id: "test_agent",
    name: "Test Agent", 
    type: "researcher",
    config: { capabilities: ["web-search", "analysis"] }
  }]
};

const task = {
  id: "task1",
  name: "Research Task",
  description: "Research ML approaches",
  assignTo: "test_agent",
  claudePrompt: "Research the latest machine learning approaches for the given problem."
};

const agent = workflow.agents[0];

// Generate and display the enhanced prompt
console.log("=== ENHANCED TASK PROMPT ===");
const prompt = executor.createTaskPrompt(task, agent, workflow);
console.log(prompt);
console.log("=== END PROMPT ===");