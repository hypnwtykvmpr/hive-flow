export interface ProhibitedPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const legacyPrefix = ['r', 'u', 'v'].join('');
const legacyOrg = `${legacyPrefix}net`;
const legacyVectorBrand = ['R', 'u', 'V', 'e', 'c', 't', 'o', 'r'].join('');
const legacyAuthorBrand = ['r', 'U', 'v'].join('');

export const CORE_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'old GitHub org', pattern: new RegExp(`${legacyOrg}/hive-flow`, 'i') },
  { label: 'old container registry org', pattern: new RegExp(`ghcr\\.io/${legacyOrg}/hive-flow`, 'i') },
  { label: 'stale removed memory backend version', pattern: /2\.0\.0-alpha\.3\.4/ },
  { label: 'old vector brand', pattern: new RegExp(`\\b${legacyVectorBrand}\\b`) },
  { label: 'old public org', pattern: new RegExp(legacyOrg, 'i') },
  { label: 'old public domain', pattern: new RegExp(`${legacyPrefix}\\.io`, 'i') },
  { label: 'old public email domain', pattern: new RegExp(`${legacyPrefix}\\.net`, 'i') },
  { label: 'old author brand', pattern: new RegExp(legacyAuthorBrand) },
];

export const URL_AND_INSTALL_PROHIBITED: readonly ProhibitedPattern[] = [
  {
    label: 'cosmetic URL',
    pattern:
      /https?:\/\/(?![^\s)"'<>]*\$)(?!(?:localhost|127\.0\.0\.1|YOUR_NODE|test-server|registry\.npmjs\.org|(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|gateway\.pinata\.cloud|api\.pinata\.cloud|api\.web3\.storage|web3\.storage|w3s\.link|dweb\.link|ipfs\.io|cloudflare-ipfs\.com|storage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|api\.cohere\.ai|generativelanguage\.googleapis\.com|api\.deepseek\.com|openrouter\.ai|dashscope-intl\.aliyuncs\.com|accounts\.google\.com|oauth2\.googleapis\.com|github\.com\/login\/oauth)[/:?#]|(?:localhost|127\.0\.0\.1|YOUR_NODE|test-server|registry\.npmjs\.org|(?:[a-z0-9-]+\.)*example\.(?:com|org|net))\b)[^\s)"'<>]+/i,
  },
  {
    label: 'GitHub URL',
    pattern: /https?:\/\/github\.com\/(?!login\/oauth\/)(?![^\s)"'<>]*\$)[^\s)"'<>]+/i,
  },
  { label: 'npm registry or package URL', pattern: /https?:\/\/(?:www\.)?npmjs\.com\/[^\s)"'<>]+/i },
  { label: 'npm shield badge', pattern: /https?:\/\/img\.shields\.io\/npm\/[^\s)"'<>]+/i },
  { label: 'npm install guidance', pattern: /\bnpm\s+install\b/i },
  {
    label: 'npx install guidance',
    pattern: /\bnpx[ \t]+(?:-y[ \t]+)?(?:@hive-flow\/cli|hive-flow(?:@[\w.-]+)?|flow-nexus(?:@[\w.-]+)?|tsx|ts-node|copilot-api)(?:[ \t]|$)/i,
  },
];

export const PERF_CLAIM_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'fictional HNSW speed multiplier', pattern: /\b(?:150\s*x|12,?500\s*x|150\s*x\s*(?:-|–|to|and)\s*12,?500\s*x)\b/i },
  { label: 'fictional Flash Attention speed range', pattern: /\b2\.49\s*x\s*(?:-|–|to)\s*7\.47\s*x\b/i },
  { label: 'fictional SWE-Bench solve rate', pattern: /\b84\.8\s*%/ },
  { label: 'fictional SONA adaptation latency', pattern: /(?:<\s*)?0\.05\s*ms/i },
  { label: 'old vector intelligence label', pattern: new RegExp(`${legacyVectorBrand} Intelligence System`) },
];

const droppedIntegrationPattern = new RegExp(`${legacyPrefix}[-_]swarm|${legacyPrefix}${'Swarm'}`, 'i');
const suspectLegacyRuPrefixPattern = new RegExp(`\\bru${'v'}[a-z0-9_.:@/-]*`, 'i');
const droppedUmbrellaPattern = new RegExp(
  [
    ['ru', 'flo'].join(''),
    ['Ru', 'flo'].join(''),
    ['Ru', 'Flo'].join(''),
    ['RU', 'FLO'].join(''),
  ].join('|'),
);

export const DROPPED_INTEGRATION_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'dropped legacy swarm integration', pattern: droppedIntegrationPattern },
];

export const DROPPED_UMBRELLA_PROHIBITED: readonly ProhibitedPattern[] = [
  { label: 'dropped legacy umbrella brand', pattern: droppedUmbrellaPattern },
];

export const SUSPECT_LEGACY_RU_PREFIX: readonly ProhibitedPattern[] = [
  { label: 'suspect legacy ru-prefixed token', pattern: suspectLegacyRuPrefixPattern },
];

export const DEBRAND_ASSERT_ZERO_PROHIBITED: readonly ProhibitedPattern[] = [
  ...CORE_PROHIBITED,
  ...URL_AND_INSTALL_PROHIBITED,
  ...PERF_CLAIM_PROHIBITED,
  ...DROPPED_INTEGRATION_PROHIBITED,
  ...DROPPED_UMBRELLA_PROHIBITED,
];
