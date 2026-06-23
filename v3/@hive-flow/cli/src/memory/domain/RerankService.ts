import { SearchResult } from '../types.js';

/**
 * Reranking Weights Configuration
 */
export interface RerankWeights {
  vectorWeight: number;    // Weight for initial semantic similarity (0-1)
  domainWeight: number;    // Weight for domain-specific heuristics (0-1)
  pathBoost: number;       // Boost for file path matches
  symbolBoost: number;     // Boost for exact symbol (class/method) matches
  inheritanceBoost: number; // Boost for parent classes of matched methods
  typePriority: Record<string, number>; // Priority for different memory types
}

const DEFAULT_WEIGHTS: RerankWeights = {
  vectorWeight: 0.7,
  domainWeight: 0.3,
  pathBoost: 0.5,
  symbolBoost: 0.8,
  inheritanceBoost: 0.4,
  typePriority: {
    'guide': 1.2,
    'api': 1.1,
    'semantic': 1.0,
    'episodic': 0.8,
    'test': 0.5,
    'internal': 0.3
  }
};

/**
 * Domain-Specific Reranking Service
 * 
 * Ported from Neo-mjs research. Enhances vector search relevance by 
 * applying deterministic domain-aware boosts.
 */
export class RerankService {
  private weights: RerankWeights;

  constructor(weights: Partial<RerankWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Reranks search results based on domain heuristics
   * 
   * @param query - The original search query string
   * @param results - Initial ANN search results
   * @returns Reranked and sorted search results
   */
  public rerank(query: string, results: SearchResult[]): SearchResult[] {
    const queryLower = query.toLowerCase();
    
    // 1. Calculate Rerank Scores
    const reranked = results.map(result => {
      let domainScore = 0;
      const metadata = result.entry.metadata || {};
      const type = result.entry.type;

      // Path Match Boost
      const sourcePath = metadata.sourcePath as string;
      if (sourcePath && queryLower.includes(sourcePath.toLowerCase())) {
        domainScore += this.weights.pathBoost;
      }

      // Symbol Match Boost
      const symbol = (metadata.symbol || result.entry.key) as string;
      if (symbol && queryLower.includes(symbol.toLowerCase())) {
        domainScore += this.weights.symbolBoost;
      }

      // Type Priority Boost
      const typeBoost = this.weights.typePriority[type] || 1.0;
      
      // Inheritance Boost (Simplified: check if query mentions parent)
      const extendsList = metadata.extends as string[];
      if (extendsList && Array.isArray(extendsList)) {
        for (const parent of extendsList) {
          if (queryLower.includes(parent.toLowerCase())) {
            domainScore += this.weights.inheritanceBoost;
            break;
          }
        }
      }

      // Fusion: (W_vec * Similarity) + (W_domain * DomainScore)
      // We also multiply by typeBoost as a global factor
      const finalScore = (
        (this.weights.vectorWeight * result.score) + 
        (this.weights.domainWeight * Math.min(domainScore, 1.0))
      ) * typeBoost;

      return {
        ...result,
        score: finalScore
      };
    });

    // 2. Sort by final score
    return reranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Applies inheritance-aware boosting across multiple results
   * 
   * If a method is a high-scoring candidate, its parent class 
   * should also be boosted if present in the results.
   */
  public applyGraphBoost(results: SearchResult[]): SearchResult[] {
    const classMap = new Map<string, SearchResult>();
    
    // Identify classes in results
    for (const res of results) {
      if (res.entry.metadata?.type === 'class' && res.entry.metadata.className) {
        classMap.set(res.entry.metadata.className as string, res);
      }
    }

    // Boost classes based on their methods' scores
    for (const res of results) {
      if (res.entry.metadata?.type === 'method' && res.entry.metadata.className) {
        const parentClass = classMap.get(res.entry.metadata.className as string);
        if (parentClass) {
          // Boost parent class by a fraction of the method's score
          parentClass.score += res.score * this.weights.inheritanceBoost * 0.5;
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
}
