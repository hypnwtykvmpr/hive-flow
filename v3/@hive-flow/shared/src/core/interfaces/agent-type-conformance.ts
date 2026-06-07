import type { AgentType } from './agent.interface.js';

type Assert<T extends true> = T;

type CanonicalAgentType =
  | 'investigator'
  | 'researcher'
  | 'verifier'
  | 'architect'
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'auditor'
  | 'bug-hunter'
  | 'debugger'
  | 'security-architect'
  | 'security-reviewer'
  | 'red-team'
  | 'blue-team'
  | 'performance-engineer'
  | 'memory-specialist'
  | 'documenter'
  | 'coordinator';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type AgentTypeIsCanonical18 = Assert<Equal<AgentType, CanonicalAgentType>>;
export type AgentTypeRejectsRemovedCoder = Assert<'coder' extends AgentType ? false : true>;
export type AgentTypeRejectsArbitraryString = Assert<string extends AgentType ? false : true>;
