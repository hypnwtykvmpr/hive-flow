import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  parseToolCallPayload,
  parseToolCallsFromContent,
  formatToolInstructions,
  flushToolCallsFromBuffer,
} from '../tool-call-utils.js';
import type { LLMTool } from '../types.js';

// ============================================================
// escapeXml
// ============================================================

describe('escapeXml', () => {
  it('escapes ampersand first, then other chars', () => {
    expect(escapeXml('&<>\"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('returns empty string unchanged', () => {
    expect(escapeXml('')).toBe('');
  });

  it('returns string with no special chars unchanged', () => {
    expect(escapeXml('hello world 123')).toBe('hello world 123');
  });

  it('escapes all 5 special chars in mixed text', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
  });
});

// ============================================================
// parseToolCallPayload
// ============================================================

describe('parseToolCallPayload', () => {
  it('parses JSON payload with object arguments', () => {
    const result = parseToolCallPayload('{"name":"foo","arguments":{"bar":1}}');
    expect(result).toEqual({ name: 'foo', arguments: '{"bar":1}' });
  });

  it('returns null for empty string', () => {
    expect(parseToolCallPayload('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseToolCallPayload('   ')).toBeNull();
  });

  it('returns null when name is missing from JSON', () => {
    expect(parseToolCallPayload('{"arguments":{"a":1}}')).toBeNull();
  });

  it('defaults arguments to {} when missing from JSON', () => {
    const result = parseToolCallPayload('{"name":"foo"}');
    expect(result).toEqual({ name: 'foo', arguments: '{}' });
  });

  it('preserves arguments when given as string', () => {
    const result = parseToolCallPayload('{"name":"foo","arguments":"some string"}');
    expect(result).toEqual({ name: 'foo', arguments: 'some string' });
  });

  it('parses XML fallback format', () => {
    const xml = '<name>foo</name><arguments>{"bar":1}</arguments>';
    const result = parseToolCallPayload(xml);
    expect(result).toEqual({ name: 'foo', arguments: '{"bar":1}' });
  });

  it('defaults arguments to {} when missing from XML', () => {
    const xml = '<name>foo</name>';
    const result = parseToolCallPayload(xml);
    expect(result).toEqual({ name: 'foo', arguments: '{}' });
  });

  it('falls back to XML when JSON is malformed', () => {
    const input = '{bad json<name>bar</name><arguments>{"x":2}</arguments>';
    const result = parseToolCallPayload(input);
    expect(result).toEqual({ name: 'bar', arguments: '{"x":2}' });
  });

  it('returns null for completely unparseable input', () => {
    expect(parseToolCallPayload('random text')).toBeNull();
  });
});

// ============================================================
// parseToolCallsFromContent
// ============================================================

describe('parseToolCallsFromContent', () => {
  it('extracts a single tool call and cleans content', () => {
    const content = 'before <tool_call>{"name":"test","arguments":{}}</tool_call> after';
    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'pfx');

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function).toEqual({ name: 'test', arguments: '{}' });
    expect(contentWithoutToolCalls).toBe('before  after');
  });

  it('extracts multiple tool calls', () => {
    const content =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{"k":"v"}}</tool_call>';
    const { toolCalls } = parseToolCallsFromContent(content, 'pfx');

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].function.name).toBe('a');
    expect(toolCalls[1].function.name).toBe('b');
  });

  it('returns original content and empty array when no tool calls', () => {
    const content = 'just some text';
    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'pfx');

    expect(toolCalls).toHaveLength(0);
    expect(contentWithoutToolCalls).toBe('just some text');
  });

  it('generates IDs matching expected format', () => {
    const content = '<tool_call>{"name":"x","arguments":{}}</tool_call>';
    const { toolCalls } = parseToolCallsFromContent(content, 'myprefix');

    expect(toolCalls[0].id).toMatch(/^myprefix-tool-\d+-1$/);
    expect(toolCalls[0].type).toBe('function');
  });

  it('skips malformed tool call payloads', () => {
    const content =
      '<tool_call>not valid</tool_call>' +
      '<tool_call>{"name":"good","arguments":{}}</tool_call>';
    const { toolCalls } = parseToolCallsFromContent(content, 'pfx');

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('good');
  });

  it('joins content before, between, and after tool calls', () => {
    const content = 'A<tool_call>{"name":"x","arguments":{}}</tool_call>B<tool_call>{"name":"y","arguments":{}}</tool_call>C';
    const { contentWithoutToolCalls } = parseToolCallsFromContent(content, 'pfx');

    expect(contentWithoutToolCalls).toBe('ABC');
  });
});

// ============================================================
// formatToolInstructions
// ============================================================

describe('formatToolInstructions', () => {
  const makeTool = (name: string, description: string, parameters: object = {}): LLMTool => ({
    type: 'function',
    function: { name, description, parameters },
  });

  it('formats a single tool into available_tools XML', () => {
    const lines = formatToolInstructions([makeTool('greet', 'Say hello')]);
    const output = lines.join('\n');

    expect(output).toContain('<available_tools>');
    expect(output).toContain('</available_tools>');
    expect(output).toContain('<name>greet</name>');
    expect(output).toContain('<description>Say hello</description>');
  });

  it('includes multiple tools in output', () => {
    const lines = formatToolInstructions([
      makeTool('a', 'Tool A'),
      makeTool('b', 'Tool B'),
    ]);
    const output = lines.join('\n');

    expect(output).toContain('<name>a</name>');
    expect(output).toContain('<name>b</name>');
  });

  it('returns array with empty tools XML for empty array', () => {
    const lines = formatToolInstructions([]);
    // With no tools, toolsXml is '' so array is ['<available_tools>', '', '</available_tools>', ...]
    expect(lines[0]).toBe('<available_tools>');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('</available_tools>');
  });

  it('XML-escapes special chars in description', () => {
    const lines = formatToolInstructions([makeTool('t', 'a & b < c')]);
    const output = lines.join('\n');

    expect(output).toContain('a &amp; b &lt; c');
    expect(output).not.toContain('a & b');
  });
});

// ============================================================
// flushToolCallsFromBuffer
// ============================================================

describe('flushToolCallsFromBuffer', () => {
  it('emits content + tool_call events for a complete tool call', () => {
    const buffer = 'hello <tool_call>{"name":"x","arguments":{}}</tool_call>';
    const { events, remainingBuffer, count } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    const contentEvents = events.filter(e => e.type === 'content');
    const toolEvents = events.filter(e => e.type === 'tool_call');

    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0].delta!.content).toBe('hello ');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].delta!.toolCall!.function!.name).toBe('x');
    expect(remainingBuffer).toBe('');
    expect(count).toBe(1);
  });

  it('returns buffer as remaining when tool_call tag is incomplete', () => {
    const buffer = 'text <tool_call>{"name":"x"';
    const { events, remainingBuffer } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    expect(events).toHaveLength(0);
    expect(remainingBuffer).toBe(buffer);
  });

  it('emits content event for text-only buffer', () => {
    const buffer = 'just text';
    const { events, remainingBuffer } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    // No complete tool_call found, so no events emitted; entire buffer remains
    expect(events).toHaveLength(0);
    expect(remainingBuffer).toBe('just text');
  });

  it('returns empty events for empty buffer', () => {
    const { events, remainingBuffer, count } = flushToolCallsFromBuffer('', 'pfx', 0);

    expect(events).toHaveLength(0);
    expect(remainingBuffer).toBe('');
    expect(count).toBe(0);
  });

  it('emits multiple tool_call events for multiple complete calls', () => {
    const buffer =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>';
    const { events, remainingBuffer, count } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    const toolEvents = events.filter(e => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].delta!.toolCall!.function!.name).toBe('a');
    expect(toolEvents[1].delta!.toolCall!.function!.name).toBe('b');
    expect(remainingBuffer).toBe('');
    expect(count).toBe(2);
  });

  it('increments count from input value', () => {
    const buffer = '<tool_call>{"name":"z","arguments":{}}</tool_call><tool_call>{"name":"w","arguments":{}}</tool_call>';
    const { count } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    expect(count).toBe(2);
  });

  it('preserves unparseable tool_call payload as content', () => {
    const buffer = '<tool_call>garbage</tool_call>';
    const { events, remainingBuffer } = flushToolCallsFromBuffer(buffer, 'pfx', 0);

    const contentEvents = events.filter(e => e.type === 'content');
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0].delta!.content).toBe('<tool_call>garbage</tool_call>');
    expect(remainingBuffer).toBe('');
  });
});
