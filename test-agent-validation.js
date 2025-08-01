const { isValidAgentType, getAvailableAgentTypes, getAgent } = require('./dist/agents/agent-loader.js');

async function test() {
  console.log('Testing agent validation...');
  
  // Test if analyst is now valid
  const isAnalystValid = await isValidAgentType('analyst');
  console.log('Is analyst valid?', isAnalystValid);
  
  // Test if code-analyzer is valid
  const isCodeAnalyzerValid = await isValidAgentType('code-analyzer');
  console.log('Is code-analyzer valid?', isCodeAnalyzerValid);
  
  // Get available types
  const types = await getAvailableAgentTypes();
  console.log('Available types include analyst?', types.includes('analyst'));
  console.log('Available types include code-analyzer?', types.includes('code-analyzer'));
  
  // Try to get analyst agent (should return code-analyzer)
  const analystAgent = await getAgent('analyst');
  console.log('Analyst agent found?', !!analystAgent);
  console.log('Analyst agent name:', analystAgent?.name);
}

test().catch(console.error);