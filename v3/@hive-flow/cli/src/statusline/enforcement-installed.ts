import { isEnforcementEngineInstalled } from '../install/enforcement-marker.js';

export function collectEnforcementInstalled(): boolean {
  return isEnforcementEngineInstalled();
}
