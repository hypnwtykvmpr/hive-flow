import { readFileSync } from 'fs';

const content = readFileSync('/workspaces/claude-code-flow/src/cli/simple-commands/init/templates/claude-md.js', 'utf8');
const lines = content.split('\n');

console.log('Total lines:', lines.length);
console.log('Last line:', lines[lines.length - 1]);
console.log('Second to last line:', lines[lines.length - 2]);

// Check for unclosed template literals
let templateCount = 0;
let inTemplate = false;
for (let i = 0; i < lines.length; i++) {
  const matches = lines[i].match(/`/g);
  if (matches) {
    templateCount += matches.length;
  }
}

console.log('Total backticks:', templateCount);
console.log('Is even?', templateCount % 2 === 0);

// Try to find unclosed braces
let braceCount = 0;
for (let i = 0; i < content.length; i++) {
  if (content[i] === '{') braceCount++;
  if (content[i] === '}') braceCount--;
}

console.log('Brace balance:', braceCount);