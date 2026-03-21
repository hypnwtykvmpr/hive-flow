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

  // 4. Contract compat — pairwise check: for each adjacent pair of steps,
  // verify that all required inputs of the next step are provided by the
  // immediate predecessor's outputs.
  for (let i = 0; i < def.modules.length - 1; i++) {
    const currentStep = def.modules[i];
    const nextStep = def.modules[i + 1];

    const currentModule = resolvedModules.get(currentStep.name);
    const nextModule = resolvedModules.get(nextStep.name);

    if (currentModule && nextModule) {
      const currentOutputs = Object.keys(currentModule.contract.outputs.fields);
      const nextInputs = Object.keys(nextModule.contract.inputs.fields);

      const missingInputs: string[] = [];
      for (const input of nextInputs) {
        const inputField = nextModule.contract.inputs.fields[input];
        if (inputField.required && !currentOutputs.includes(input)) {
          missingInputs.push(input);
        }
      }

      if (missingInputs.length > 0) {
        errors.push(
          `Workflow step "${nextStep.name}" requires inputs [${missingInputs.join(', ')}] but upstream outputs provide [${currentOutputs.join(', ')}].`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
