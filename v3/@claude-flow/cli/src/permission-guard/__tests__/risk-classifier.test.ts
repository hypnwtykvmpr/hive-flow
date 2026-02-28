import { describe, it, expect } from 'vitest';
import { classifyCommand, classifyTool, getTimeoutBehavior, isNeverAutoAllow } from '../risk-classifier.js';

describe('classifyCommand', () => {
  it('classifies safe commands as low', () => {
    expect(classifyCommand('ls -la').level).toBe('low');
    expect(classifyCommand('git status').level).toBe('low');
    expect(classifyCommand('npm run build').level).toBe('low');
    expect(classifyCommand('cat README.md').level).toBe('low');
  });
  it('classifies state-changing as medium', () => {
    expect(classifyCommand('npm install express').level).toBe('medium');
    expect(classifyCommand('git commit -m "test"').level).toBe('medium');
    expect(classifyCommand('mkdir newdir').level).toBe('medium');
  });
  it('classifies destructive as high', () => {
    expect(classifyCommand('rm -rf node_modules').level).toBe('high');
    expect(classifyCommand('git push --force origin main').level).toBe('high');
    expect(classifyCommand('chmod 777 /tmp').level).toBe('high');
  });
  it('classifies system-destruction as critical', () => {
    expect(classifyCommand('sudo rm -rf /').level).toBe('critical');
    expect(classifyCommand('mkfs /dev/sda1').level).toBe('critical');
    expect(classifyCommand('dd if=/dev/zero of=/dev/sda').level).toBe('critical');
  });
  it('defaults unknown to medium', () => {
    expect(classifyCommand('some_unknown_command').level).toBe('medium');
  });
});

describe('classifyTool', () => {
  it('classifies read-only tools as none', () => {
    expect(classifyTool('Read').level).toBe('none');
    expect(classifyTool('Glob').level).toBe('none');
    expect(classifyTool('Grep').level).toBe('none');
  });
  it('classifies write tools as medium', () => {
    expect(classifyTool('Write').level).toBe('medium');
    expect(classifyTool('Edit').level).toBe('medium');
  });
  it('bumps Write to high for sensitive paths', () => {
    expect(classifyTool('Write', { file_path: '/etc/passwd' }).level).toBe('high');
    expect(classifyTool('Edit', { file_path: '~/.ssh/config' }).level).toBe('high');
  });
});

describe('getTimeoutBehavior', () => {
  it('allows none and low', () => {
    expect(getTimeoutBehavior('none')).toBe('allow');
    expect(getTimeoutBehavior('low')).toBe('allow');
  });
  it('denies medium and above', () => {
    expect(getTimeoutBehavior('medium')).toBe('deny');
    expect(getTimeoutBehavior('high')).toBe('deny');
    expect(getTimeoutBehavior('critical')).toBe('deny');
  });
});

describe('isNeverAutoAllow', () => {
  it('blocks critical commands', () => {
    expect(isNeverAutoAllow('sudo rm -rf /')).toBe(true);
    expect(isNeverAutoAllow('mkfs /dev/sda')).toBe(true);
  });
  it('allows non-critical commands', () => {
    expect(isNeverAutoAllow('ls -la')).toBe(false);
    expect(isNeverAutoAllow('npm install')).toBe(false);
  });
});
