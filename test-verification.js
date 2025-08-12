import { VerificationTrainingIntegration } from './src/cli/simple-commands/verification-training-integration.js';

async function simulateLearning() {
  const integration = new VerificationTrainingIntegration();
  await integration.initialize();
  
  // Simulate some successful verifications
  for (let i = 0; i < 10; i++) {
    const verification = {
      taskId: 'test-task-' + i,
      agentType: 'coder',
      score: 0.85 + Math.random() * 0.15, // 0.85-1.0 range
      passed: true,
      threshold: 0.85,
      timestamp: new Date().toISOString(),
      results: [
        { name: 'compile', passed: true, score: 0.95 },
        { name: 'test', passed: true, score: 0.90 },
        { name: 'lint', passed: true, score: 0.85 }
      ]
    };
    
    await integration.feedVerificationToTraining(verification);
  }
  
  console.log('\n✅ Simulated 10 successful verifications');
  
  // Show updated prediction
  const prediction = await integration.predictVerificationOutcome('default', 'coder');
  console.log('\n🔮 Updated Prediction:');
  console.log('   Predicted Score: ' + prediction.predictedScore.toFixed(3));
  console.log('   Confidence: ' + (prediction.confidence * 100).toFixed(1) + '%');
  console.log('   Recommendation: ' + prediction.recommendation);
  
  // Show status
  const status = await integration.getTrainingStatus();
  console.log('\n📊 Updated Agent Reliability:');
  for (const [agent, reliability] of Object.entries(status.agentReliability)) {
    console.log('   ' + agent + ': ' + (reliability * 100).toFixed(1) + '%');
  }
}

simulateLearning().catch(console.error);