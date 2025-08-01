import { isValidAgentType, getAvailableAgentTypes, getAgent } from './src/agents/agent-loader.js';

async function test() {
  console.log('Testing agent validation...');
  
  try {
    const isAnalystValid = await isValidAgentType('analyst');
    console.log('Is analyst valid?', isAnalystValid);
    
    const isCodeAnalyzerValid = await isValidAgentType('code-analyzer');
    console.log('Is code-analyzer valid?', isCodeAnalyzerValid);
    
    const types = await getAvailableAgentTypes();
    console.log('Available types include analyst?', types.includes('analyst'));
    console.log('Available types include code-analyzer?', types.includes('code-analyzer'));
    console.log('Total types:', types.length);
    
    const analystAgent = await getAgent('analyst');
    console.log('Analyst agent found?', Boolean(analystAgent));
    if (analystAgent) {
      console.log('Analyst agent name:', analystAgent.name);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();