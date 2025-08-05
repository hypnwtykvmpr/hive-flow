import { createOptimizedSparcClaudeMd } from './src/cli/simple-commands/init/templates/claude-md.js';

const template = createOptimizedSparcClaudeMd();
console.log('✅ Optimized template size:', template.length, 'characters');
console.log('🎯 Target: <40,000 characters');
console.log('📊 Result:', template.length < 40000 ? 'SUCCESS! ✅' : 'FAILED ❌');
console.log('💾 Original size: 45,948 characters');
console.log('💾 Optimized size:', template.length, 'characters');
console.log('💾 Size reduction:', 45948 - template.length, 'characters');
console.log('💾 Reduction percentage:', Math.round((1 - template.length/45948) * 100) + '%');