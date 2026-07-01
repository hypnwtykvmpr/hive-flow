/**
 * Shared tool-call XML formatting and parsing helpers for CLI providers.
 */
import type { LLMTool, LLMToolCall, LLMStreamEvent } from './types.js';
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
export function parseToolCallPayload(raw: string): { name: string; arguments: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Preferred format: JSON payload inside <tool_call>.
  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    if (!name) return null;
    const args = parsed.arguments === undefined
      ? '{}'
      : (typeof parsed.arguments === 'object' && parsed.arguments !== null
        ? JSON.stringify(parsed.arguments)
        : String(parsed.arguments));
    return { name, arguments: args };
  } catch {
    // Fall through to XML field extraction.
  }
  // Fallback format: nested XML tags inside <tool_call>.
  const nameMatch = trimmed.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;
  const argsMatch = trimmed.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/i);
  if (!argsMatch) return { name, arguments: '{}' };
  const rawArgs = argsMatch[1].trim();
  if (!rawArgs) return { name, arguments: '{}' };
  try {
    const parsedArgs = JSON.parse(rawArgs) as unknown;
    return {
      name,
      arguments: typeof parsedArgs === 'object' && parsedArgs !== null
        ? JSON.stringify(parsedArgs)
        : String(parsedArgs),
    };
  } catch {
    return { name, arguments: rawArgs };
  }
}
export function parseToolCallsFromContent(content: string, idPrefix: string): { contentWithoutToolCalls: string; toolCalls: LLMToolCall[] } {
  const toolCalls: LLMToolCall[] = [];
  const blockRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const textParts: string[] = [];
  while ((match = blockRe.exec(content)) !== null) {
    textParts.push(content.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const parsedCall = parseToolCallPayload(match[1].trim());
    if (!parsedCall) continue;
    toolCalls.push({
      id: `${idPrefix}-tool-${Date.now()}-${toolCalls.length + 1}`,
      type: 'function',
      function: parsedCall,
    });
  }
  textParts.push(content.slice(lastIndex));
  const contentWithoutToolCalls = textParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { contentWithoutToolCalls, toolCalls };
}
export function formatToolInstructions(tools: LLMTool[]): string[] {
  const toolsXml = tools.map((tool) => {
    const name = escapeXml(tool.function.name);
    const description = escapeXml(tool.function.description || '');
    const parameters = escapeXml(JSON.stringify(tool.function.parameters));
    return ['<tool>', `  <name>${name}</name>`, `  <description>${description}</description>`, `  <parameters>${parameters}</parameters>`, '</tool>'].join('\n');
  }).join('\n');
  return [
    '<available_tools>',
    toolsXml,
    '</available_tools>',
    '',
    'If you decide to call a tool, respond with one or more <tool_call> XML blocks using this exact JSON payload format:',
    '<tool_call>',
    '{"name":"tool_name","arguments":{"param":"value"}}',
    '</tool_call>',
    'Do not wrap tool calls in markdown fences.',
  ];
}
export function flushToolCallsFromBuffer(contentBuffer: string, idPrefix: string, streamToolCallCount: number): { events: LLMStreamEvent[]; remainingBuffer: string; count: number } {
  const events: LLMStreamEvent[] = [];
  const toolCallBlockRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = toolCallBlockRe.exec(contentBuffer)) !== null) {
    const before = contentBuffer.slice(lastEnd, match.index);
    if (before.length > 0) events.push({ type: 'content', delta: { content: before } });
    const parsedCall = parseToolCallPayload(match[1].trim());
    if (parsedCall) {
      streamToolCallCount += 1;
      events.push({ type: 'tool_call', delta: { toolCall: { id: `${idPrefix}-tool-${Date.now()}-${streamToolCallCount}`, type: 'function', function: parsedCall } } });
    } else {
      // Unparseable tool payload: preserve model output as plain content.
      events.push({ type: 'content', delta: { content: match[0] } });
    }
    lastEnd = match.index + match[0].length;
  }
  return { events, remainingBuffer: contentBuffer.slice(lastEnd), count: streamToolCallCount };
}
