import type { 
  WorkflowDefinition, 
  WorkflowModule, 
  WorkflowModuleRef 
} from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateWorkflowDefinition(
  def: WorkflowDefinition,
  registry: Record<string, WorkflowModule> | Map<string, WorkflowModule>
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const getModuleFromRegistry = (key: string): WorkflowModule | undefined => {
    if (registry instanceof Map) {
      return registry.get(key);
    }
    return registry[key];
  };

  // 1. Duplicate step names
  const stepNames = new Set<string>();
  for (const modRef of def.modules) {
    if (stepNames.has(modRef.name)) {
      errors.push(`Duplicate workflow step name "${modRef.name}".`);
    }
    stepNames.add(modRef.name);
  }

  // 2. Missing module refs in registry and missing dependency refs
  const resolvedModules = new Map<string, WorkflowModule>();
  const allStepNames = new Set(def.modules.map(m => m.name));

  for (const modRef of def.modules) {
    // Check dependency references point to existing steps
    for (const dep of modRef.dependsOn ?? []) {
      if (!allStepNames.has(dep)) {
        errors.push(`Workflow step "${modRef.name}" references missing dependency "${dep}".`);
      }
    }

    // Check registry references
    const registryKey = modRef.registryModule || modRef.name;
    const moduleDef = getModuleFromRegistry(registryKey);
    if (!moduleDef) {
      errors.push(`Workflow step "${modRef.name}" references unregistered module "${registryKey}".`);
    } else {
      resolvedModules.set(modRef.name, moduleDef);
    }
  }

  // 3. DFS cycle detection on dependsOn
  const adjList = new Map<string, string[]>();
  for (const modRef of def.modules) {
    adjList.set(modRef.name, modRef.dependsOn || []);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycle = (node: string, path: string[]): boolean => {
    visited.add(node);
    recursionStack.add(node);

    const neighbors = adjList.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, [...path, node])) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        errors.push(`Dependency cycle detected: ${[...path, node, neighbor].join(' -> ')}.`);
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  };

  for (const node of adjList.keys()) {
    if (!visited.has(node)) {
      hasCycle(node, []);
    }
  }

  // 4. Contract compat — DAG traversal: for each step, collect the union of
  // all declared dependencies' outputs and verify they satisfy every required
  // input of that step.  Steps with no dependsOn have zero upstream outputs,
  // so any required input they declare is an error (they must either have no
  // required inputs or explicitly declare a dependency that provides them).
  for (const modRef of def.modules) {
    const stepModule = resolvedModules.get(modRef.name);
    if (!stepModule) continue;

    // Skip steps whose module has no required inputs — nothing to check.
    const requiredInputs = Object.entries(stepModule.contract.inputs.fields).filter(
      ([, f]) => (f as { required?: boolean }).required,
    );
    if (requiredInputs.length === 0) continue;

    const deps = adjList.get(modRef.name) || [];

    // Union of all outputs provided by every declared dependency.
    const availableOutputs = new Set<string>();
    for (const depName of deps) {
      const depModule = resolvedModules.get(depName);
      if (depModule) {
        for (const key of Object.keys(depModule.contract.outputs.fields)) {
          availableOutputs.add(key);
        }
      }
    }

    const missingInputs: string[] = [];
    for (const [input] of requiredInputs) {
      if (!availableOutputs.has(input)) {
        missingInputs.push(input);
      }
    }

    if (missingInputs.length > 0) {
      errors.push(
        `Workflow step "${modRef.name}" requires inputs [${missingInputs.join(', ')}] but upstream outputs provide [${[...availableOutputs].join(', ')}].`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
