/**
 * Enhanced Truth Scoring Engine
 * Provides comprehensive truth scoring with 0.95 minimum threshold
 */

import { 
  Evidence, 
  AgentClaims, 
  TruthScore, 
  Discrepancy, 
  EvidenceQuality,
  VerificationWeights,
  TestResults,
  CodeQuality,
  SystemHealth,
  AgentCoordination
} from './interfaces.js';

export class EnhancedTruthScoreCalculator {
  private config: {
    minimum_threshold: number;
    weights: VerificationWeights;
  };

  constructor(config?: any) {
    this.config = {
      minimum_threshold: config?.minimum_threshold || 0.95,
      weights: {
        tests: config?.weights?.tests || 0.30,
        integration_tests: config?.weights?.integration_tests || 0.25,
        lint: config?.weights?.lint || 0.15,
        type_check: config?.weights?.type_check || 0.15,
        build: config?.weights?.build || 0.10,
        performance: config?.weights?.performance || 0.05,
        ...config?.weights
      }
    };
  }

  /**
   * Calculate comprehensive truth score
   */
  async calculateTruthScore(evidence: Evidence, claims: AgentClaims): Promise<TruthScore> {
    const startTime = Date.now();
    const discrepancies: Discrepancy[] = [];
    const weights = this.config.weights;
    
    let totalScore = 0;

    // 1. Test Verification (30%)
    const testVerification = this.verifyTestClaims(evidence.test_results, claims.test_claims);
    totalScore += testVerification.score * weights.tests;
    discrepancies.push(...testVerification.discrepancies);

    // 2. Integration Test Verification (25%)
    const integrationVerification = this.verifyIntegrationClaims(
      evidence.test_results, 
      claims.integration_claims
    );
    totalScore += integrationVerification.score * weights.integration_tests;
    discrepancies.push(...integrationVerification.discrepancies);

    // 3. Code Quality Verification (30% total: 15% lint + 15% type)
    const qualityVerification = this.verifyQualityClaims(evidence.code_quality, claims.quality_claims);
    totalScore += qualityVerification.score * (weights.lint + weights.type_check);
    discrepancies.push(...qualityVerification.discrepancies);

    // 4. Build Verification (10%)
    const buildVerification = this.verifyBuildClaims(evidence.system_health, claims.build_claims);
    totalScore += buildVerification.score * weights.build;
    discrepancies.push(...buildVerification.discrepancies);

    // 5. Performance Verification (5%)
    const performanceVerification = this.verifyPerformanceClaims(
      evidence.system_health.performance_metrics, 
      claims.performance_claims
    );
    totalScore += performanceVerification.score * weights.performance;
    discrepancies.push(...performanceVerification.discrepancies);

    // Calculate evidence quality
    const evidenceQuality = this.assessEvidenceQuality(evidence);

    // Apply evidence quality factor
    const evidenceAdjustedScore = totalScore * evidenceQuality.overall;

    // Calculate final score with precision
    const finalScore = Math.round(evidenceAdjustedScore * 1000) / 1000;

    const truthScore: TruthScore = {
      score: finalScore,
      threshold: this.config.minimum_threshold,
      passed: finalScore >= this.config.minimum_threshold,
      discrepancies: discrepancies.sort((a, b) => b.impact_score - a.impact_score),
      evidence_quality: evidenceQuality,
      timestamp: Date.now(),
      agent_id: claims.agent_id,
      task_id: claims.task_id,
      calculation_method: 'enhanced_weighted_verification_v2'
    };

    return truthScore;
  }

  /**
   * Verify test-related claims
   */
  private verifyTestClaims(testResults: TestResults, testClaims: any): {
    score: number;
    discrepancies: Discrepancy[];
  } {
    const discrepancies: Discrepancy[] = [];
    let score = 0;
    const totalChecks = 4;

    // Check if all tests pass
    const allTestsPass = this.calculateTestPassRate(testResults) === 1.0;
    if (testClaims.all_tests_pass && !allTestsPass) {
      discrepancies.push({
        type: 'test_failure',
        description: 'Claimed all tests pass but some tests are failing',
        severity: 'high',
        claimed_value: true,
        actual_value: allTestsPass,
        impact_score: 0.8
      });
    } else if (testClaims.all_tests_pass === allTestsPass) {
      score += 1;
    }

    // Check test coverage
    const actualCoverage = this.calculateAverageCoverage(testResults);
    const coverageDiff = Math.abs(actualCoverage - (testClaims.test_coverage_percentage || 0));
    if (coverageDiff > 5) { // Allow 5% tolerance
      discrepancies.push({
        type: 'coverage_mismatch',
        description: `Test coverage mismatch: claimed ${testClaims.test_coverage_percentage}%, actual ${actualCoverage}%`,
        severity: coverageDiff > 20 ? 'high' : 'medium',
        claimed_value: testClaims.test_coverage_percentage,
        actual_value: actualCoverage,
        impact_score: Math.min(coverageDiff / 100, 0.5)
      });
    } else {
      score += 1;
    }

    // Check for no failing tests specifically
    const hasFailing = this.hasFailingTests(testResults);
    if (testClaims.no_failing_tests && hasFailing) {
      discrepancies.push({
        type: 'failing_tests_present',
        description: 'Claimed no failing tests but failures detected',
        severity: 'high',
        claimed_value: false,
        actual_value: hasFailing,
        impact_score: 0.7
      });
    } else if (testClaims.no_failing_tests === !hasFailing) {
      score += 1;
    }

    // Check performance tests
    const perfTestsPass = testResults.performance_tests.failed === 0;
    if (testClaims.performance_tests_pass && !perfTestsPass) {
      discrepancies.push({
        type: 'performance_test_failure',
        description: 'Claimed performance tests pass but they are failing',
        severity: 'medium',
        claimed_value: true,
        actual_value: perfTestsPass,
        impact_score: 0.4
      });
    } else if (testClaims.performance_tests_pass === perfTestsPass) {
      score += 1;
    }

    return {
      score: score / totalChecks,
      discrepancies
    };
  }

  /**
   * Verify integration-related claims
   */
  private verifyIntegrationClaims(testResults: TestResults, integrationClaims: any): {
    score: number;
    discrepancies: Discrepancy[];
  } {
    const discrepancies: Discrepancy[] = [];
    let score = 0;
    const totalChecks = 4;

    // API compatibility
    const integrationTestsPass = testResults.integration_tests.failed === 0;
    if (integrationClaims.api_compatibility_maintained && !integrationTestsPass) {
      discrepancies.push({
        type: 'api_compatibility_failure',
        description: 'Claimed API compatibility maintained but integration tests failing',
        severity: 'high',
        claimed_value: true,
        actual_value: integrationTestsPass,
        impact_score: 0.9
      });
    } else if (integrationClaims.api_compatibility_maintained === integrationTestsPass) {
      score += 1;
    }

    // Cross-agent communication
    const crossAgentTestsPass = testResults.cross_agent_tests.failed === 0;
    if (integrationClaims.cross_agent_communication_working && !crossAgentTestsPass) {
      discrepancies.push({
        type: 'cross_agent_failure',
        description: 'Claimed cross-agent communication working but tests failing',
        severity: 'high',
        claimed_value: true,
        actual_value: crossAgentTestsPass,
        impact_score: 0.8
      });
    } else if (integrationClaims.cross_agent_communication_working === crossAgentTestsPass) {
      score += 1;
    }

    // E2E tests for external services
    const e2eTestsPass = testResults.e2e_tests.failed === 0;
    if (integrationClaims.external_services_compatible && !e2eTestsPass) {
      discrepancies.push({
        type: 'external_service_failure',
        description: 'Claimed external services compatible but E2E tests failing',
        severity: 'medium',
        claimed_value: true,
        actual_value: e2eTestsPass,
        impact_score: 0.6
      });
    } else if (integrationClaims.external_services_compatible === e2eTestsPass) {
      score += 1;
    }

    // Database migrations (if applicable)
    // This would require additional evidence from database state
    if (integrationClaims.database_migrations_successful !== undefined) {
      // For now, assume true if no database-related test failures
      const dbTestsPass = !this.hasDatabaseTestFailures(testResults);
      if (integrationClaims.database_migrations_successful && !dbTestsPass) {
        discrepancies.push({
          type: 'database_migration_failure',
          description: 'Claimed database migrations successful but database tests failing',
          severity: 'high',
          claimed_value: true,
          actual_value: dbTestsPass,
          impact_score: 0.7
        });
      } else if (integrationClaims.database_migrations_successful === dbTestsPass) {
        score += 1;
      }
    } else {
      score += 1; // No database claims, so no issues
    }

    return {
      score: score / totalChecks,
      discrepancies
    };
  }

  /**
   * Verify code quality claims
   */
  private verifyQualityClaims(codeQuality: CodeQuality, qualityClaims: any): {
    score: number;
    discrepancies: Discrepancy[];
  } {
    const discrepancies: Discrepancy[] = [];
    let score = 0;
    const totalChecks = 4;

    // Lint errors
    const hasLintErrors = codeQuality.lint_results.errors > 0;
    if (qualityClaims.no_lint_errors && hasLintErrors) {
      discrepancies.push({
        type: 'lint_errors_present',
        description: `Claimed no lint errors but found ${codeQuality.lint_results.errors}`,
        severity: 'medium',
        claimed_value: 0,
        actual_value: codeQuality.lint_results.errors,
        impact_score: Math.min(codeQuality.lint_results.errors / 10, 0.5)
      });
    } else if (qualityClaims.no_lint_errors === !hasLintErrors) {
      score += 1;
    }

    // Type errors
    const hasTypeErrors = codeQuality.type_results.errors > 0;
    if (qualityClaims.no_type_errors && hasTypeErrors) {
      discrepancies.push({
        type: 'type_errors_present',
        description: `Claimed no type errors but found ${codeQuality.type_results.errors}`,
        severity: 'medium',
        claimed_value: 0,
        actual_value: codeQuality.type_results.errors,
        impact_score: Math.min(codeQuality.type_results.errors / 5, 0.6)
      });
    } else if (qualityClaims.no_type_errors === !hasTypeErrors) {
      score += 1;
    }

    // Code complexity
    const complexityAcceptable = codeQuality.complexity_metrics.cyclomatic_complexity <= 10;
    if (qualityClaims.code_complexity_acceptable && !complexityAcceptable) {
      discrepancies.push({
        type: 'high_complexity',
        description: `Claimed acceptable complexity but cyclomatic complexity is ${codeQuality.complexity_metrics.cyclomatic_complexity}`,
        severity: 'low',
        claimed_value: 'acceptable',
        actual_value: codeQuality.complexity_metrics.cyclomatic_complexity,
        impact_score: 0.2
      });
    } else if (qualityClaims.code_complexity_acceptable === complexityAcceptable) {
      score += 1;
    }

    // Security scan
    const securityClean = codeQuality.security_scan.vulnerabilities_found === 0;
    if (qualityClaims.security_scan_clean && !securityClean) {
      const criticalVulns = codeQuality.security_scan.severity_breakdown.critical;
      const highVulns = codeQuality.security_scan.severity_breakdown.high;
      const severity = criticalVulns > 0 ? 'critical' : highVulns > 0 ? 'high' : 'medium';
      
      discrepancies.push({
        type: 'security_vulnerabilities',
        description: `Claimed security scan clean but found ${codeQuality.security_scan.vulnerabilities_found} vulnerabilities`,
        severity,
        claimed_value: 0,
        actual_value: codeQuality.security_scan.vulnerabilities_found,
        impact_score: criticalVulns * 0.9 + highVulns * 0.6 + 
                     codeQuality.security_scan.severity_breakdown.medium * 0.3 +
                     codeQuality.security_scan.severity_breakdown.low * 0.1
      });
    } else if (qualityClaims.security_scan_clean === securityClean) {
      score += 1;
    }

    return {
      score: score / totalChecks,
      discrepancies
    };
  }

  /**
   * Verify build and deployment claims
   */
  private verifyBuildClaims(systemHealth: SystemHealth, buildClaims: any): {
    score: number;
    discrepancies: Discrepancy[];
  } {
    const discrepancies: Discrepancy[] = [];
    let score = 0;
    const totalChecks = 4;

    // Build success
    const buildSuccess = systemHealth.build_results.success;
    if (buildClaims.builds_successfully && !buildSuccess) {
      discrepancies.push({
        type: 'build_failure',
        description: 'Claimed successful build but build failed',
        severity: 'critical',
        claimed_value: true,
        actual_value: buildSuccess,
        impact_score: 1.0
      });
    } else if (buildClaims.builds_successfully === buildSuccess) {
      score += 1;
    }

    // Build warnings
    const hasWarnings = systemHealth.build_results.warnings > 0;
    if (buildClaims.no_build_warnings && hasWarnings) {
      discrepancies.push({
        type: 'build_warnings_present',
        description: `Claimed no build warnings but found ${systemHealth.build_results.warnings}`,
        severity: 'low',
        claimed_value: 0,
        actual_value: systemHealth.build_results.warnings,
        impact_score: Math.min(systemHealth.build_results.warnings / 20, 0.3)
      });
    } else if (buildClaims.no_build_warnings === !hasWarnings) {
      score += 1;
    }

    // Deployment readiness
    const deploymentReady = systemHealth.deployment_status.deployable;
    if (buildClaims.deployment_ready && !deploymentReady) {
      discrepancies.push({
        type: 'deployment_not_ready',
        description: 'Claimed deployment ready but deployment validation failed',
        severity: 'high',
        claimed_value: true,
        actual_value: deploymentReady,
        impact_score: 0.8
      });
    } else if (buildClaims.deployment_ready === deploymentReady) {
      score += 1;
    }

    // Dependencies resolved
    const dependenciesResolved = systemHealth.deployment_status.dependencies_satisfied;
    if (buildClaims.dependencies_resolved && !dependenciesResolved) {
      discrepancies.push({
        type: 'dependency_issues',
        description: 'Claimed dependencies resolved but dependency validation failed',
        severity: 'high',
        claimed_value: true,
        actual_value: dependenciesResolved,
        impact_score: 0.7
      });
    } else if (buildClaims.dependencies_resolved === dependenciesResolved) {
      score += 1;
    }

    return {
      score: score / totalChecks,
      discrepancies
    };
  }

  /**
   * Verify performance claims
   */
  private verifyPerformanceClaims(performanceMetrics: any, performanceClaims: any): {
    score: number;
    discrepancies: Discrepancy[];
  } {
    const discrepancies: Discrepancy[] = [];
    let score = 0;
    const totalChecks = 4;

    // Response time
    const responseTimeAcceptable = performanceMetrics.response_time_p95_ms <= 1000; // 1 second threshold
    if (performanceClaims.response_time_acceptable && !responseTimeAcceptable) {
      discrepancies.push({
        type: 'poor_response_time',
        description: `Claimed acceptable response time but P95 is ${performanceMetrics.response_time_p95_ms}ms`,
        severity: 'medium',
        claimed_value: 'acceptable',
        actual_value: performanceMetrics.response_time_p95_ms,
        impact_score: Math.min((performanceMetrics.response_time_p95_ms - 1000) / 5000, 0.5)
      });
    } else if (performanceClaims.response_time_acceptable === responseTimeAcceptable) {
      score += 1;
    }

    // Memory usage
    const memoryUsageAcceptable = performanceMetrics.memory_usage_mb <= 512; // 512MB threshold
    if (performanceClaims.memory_usage_acceptable && !memoryUsageAcceptable) {
      discrepancies.push({
        type: 'high_memory_usage',
        description: `Claimed acceptable memory usage but using ${performanceMetrics.memory_usage_mb}MB`,
        severity: 'medium',
        claimed_value: 'acceptable',
        actual_value: performanceMetrics.memory_usage_mb,
        impact_score: Math.min((performanceMetrics.memory_usage_mb - 512) / 1024, 0.4)
      });
    } else if (performanceClaims.memory_usage_acceptable === memoryUsageAcceptable) {
      score += 1;
    }

    // Throughput
    const throughputAcceptable = performanceMetrics.throughput_requests_per_second >= 10; // 10 RPS threshold
    if (performanceClaims.throughput_acceptable && !throughputAcceptable) {
      discrepancies.push({
        type: 'low_throughput',
        description: `Claimed acceptable throughput but only ${performanceMetrics.throughput_requests_per_second} RPS`,
        severity: 'medium',
        claimed_value: 'acceptable',
        actual_value: performanceMetrics.throughput_requests_per_second,
        impact_score: Math.min((10 - performanceMetrics.throughput_requests_per_second) / 10, 0.4)
      });
    } else if (performanceClaims.throughput_acceptable === throughputAcceptable) {
      score += 1;
    }

    // Error rate
    const errorRateAcceptable = performanceMetrics.error_rate_percentage <= 1; // 1% threshold
    if (performanceClaims.meets_performance_targets && !errorRateAcceptable) {
      discrepancies.push({
        type: 'high_error_rate',
        description: `Claimed performance targets met but error rate is ${performanceMetrics.error_rate_percentage}%`,
        severity: 'high',
        claimed_value: 'acceptable',
        actual_value: performanceMetrics.error_rate_percentage,
        impact_score: Math.min(performanceMetrics.error_rate_percentage / 10, 0.6)
      });
    } else if (performanceClaims.meets_performance_targets === errorRateAcceptable) {
      score += 1;
    }

    return {
      score: score / totalChecks,
      discrepancies
    };
  }

  /**
   * Assess the quality of provided evidence
   */
  private assessEvidenceQuality(evidence: Evidence): EvidenceQuality {
    const now = Date.now();
    const evidenceAge = now - evidence.collection_timestamp;
    const maxAge = 30 * 60 * 1000; // 30 minutes

    // Freshness (0-1): How recent is the evidence
    const freshness = Math.max(0, 1 - (evidenceAge / maxAge));

    // Completeness (0-1): How complete is the evidence
    let completeness = 0;
    const components = 5; // test_results, code_quality, system_health, agent_coordination, timing
    
    if (evidence.test_results) completeness += 0.2;
    if (evidence.code_quality) completeness += 0.2;
    if (evidence.system_health) completeness += 0.2;
    if (evidence.agent_coordination) completeness += 0.2;
    if (evidence.collection_duration_ms > 0) completeness += 0.2;

    // Reliability (0-1): How reliable is the evidence source
    const reliability = this.calculateEvidenceReliability(evidence);

    // Coverage (0-1): How comprehensive is the evidence
    const coverage = this.calculateEvidenceCoverage(evidence);

    // Overall quality (weighted average)
    const overall = (freshness * 0.2 + completeness * 0.3 + reliability * 0.3 + coverage * 0.2);

    return {
      completeness: Math.round(completeness * 1000) / 1000,
      freshness: Math.round(freshness * 1000) / 1000,
      reliability: Math.round(reliability * 1000) / 1000,
      coverage: Math.round(coverage * 1000) / 1000,
      overall: Math.round(overall * 1000) / 1000
    };
  }

  /**
   * Calculate evidence reliability based on source consistency
   */
  private calculateEvidenceReliability(evidence: Evidence): number {
    let reliability = 1.0;

    // Check for inconsistencies in the evidence
    if (evidence.test_results && evidence.system_health) {
      // If tests pass but build fails, reduce reliability
      const testsPass = this.calculateTestPassRate(evidence.test_results) > 0.9;
      const buildSuccess = evidence.system_health.build_results.success;
      
      if (testsPass && !buildSuccess) {
        reliability -= 0.3;
      }
    }

    // Check collection duration (very fast or very slow collection might be unreliable)
    if (evidence.collection_duration_ms < 1000 || evidence.collection_duration_ms > 300000) {
      reliability -= 0.1;
    }

    return Math.max(0, reliability);
  }

  /**
   * Calculate evidence coverage
   */
  private calculateEvidenceCoverage(evidence: Evidence): number {
    let coverage = 0;
    const maxCoverage = 10;

    // Test coverage
    if (evidence.test_results) {
      coverage += evidence.test_results.unit_tests ? 1 : 0;
      coverage += evidence.test_results.integration_tests ? 1 : 0;
      coverage += evidence.test_results.e2e_tests ? 1 : 0;
      coverage += evidence.test_results.cross_agent_tests ? 1 : 0;
    }

    // Code quality coverage
    if (evidence.code_quality) {
      coverage += evidence.code_quality.lint_results ? 1 : 0;
      coverage += evidence.code_quality.type_results ? 1 : 0;
      coverage += evidence.code_quality.security_scan ? 1 : 0;
    }

    // System health coverage
    if (evidence.system_health) {
      coverage += evidence.system_health.build_results ? 1 : 0;
      coverage += evidence.system_health.performance_metrics ? 1 : 0;
      coverage += evidence.system_health.deployment_status ? 1 : 0;
    }

    return coverage / maxCoverage;
  }

  // Helper methods
  private calculateTestPassRate(testResults: TestResults): number {
    const allTests = Object.values(testResults);
    let totalTests = 0;
    let passedTests = 0;

    for (const testSuite of allTests) {
      totalTests += testSuite.total;
      passedTests += testSuite.passed;
    }

    return totalTests > 0 ? passedTests / totalTests : 0;
  }

  private calculateAverageCoverage(testResults: TestResults): number {
    const allTests = Object.values(testResults);
    let totalCoverage = 0;
    let suiteCount = 0;

    for (const testSuite of allTests) {
      if (testSuite.coverage_percentage > 0) {
        totalCoverage += testSuite.coverage_percentage;
        suiteCount++;
      }
    }

    return suiteCount > 0 ? totalCoverage / suiteCount : 0;
  }

  private hasFailingTests(testResults: TestResults): boolean {
    return Object.values(testResults).some(suite => suite.failed > 0);
  }

  private hasDatabaseTestFailures(testResults: TestResults): boolean {
    // Check for database-related test failures in failure messages
    const allFailures = Object.values(testResults).flatMap(suite => suite.failures || []);
    return allFailures.some(failure => 
      failure.error_message.toLowerCase().includes('database') ||
      failure.error_message.toLowerCase().includes('migration') ||
      failure.test_name.toLowerCase().includes('db')
    );
  }

  /**
   * Store truth score with persistence
   */
  async storeTruthScore(truthScore: TruthScore): Promise<string> {
    // This would integrate with the existing memory system
    const timestamp = Date.now();
    const filename = `truth_score_${truthScore.agent_id}_${truthScore.task_id}_${timestamp}.json`;
    
    // In actual implementation, this would use the memory manager
    console.log(`Storing truth score: ${filename}`, truthScore);
    
    return filename;
  }

  /**
   * Compare claims with reality for discrepancy analysis
   */
  async compareClaimToReality(claims: AgentClaims, evidence: Evidence): Promise<{
    truth_score: TruthScore;
    detailed_analysis: any;
  }> {
    const truthScore = await this.calculateTruthScore(evidence, claims);
    
    const detailedAnalysis = {
      claim_accuracy: this.analyzeClaimAccuracy(claims, evidence),
      evidence_gaps: this.identifyEvidenceGaps(evidence),
      risk_assessment: this.assessRisks(truthScore),
      recommendations: this.generateRecommendations(truthScore)
    };

    return {
      truth_score: truthScore,
      detailed_analysis: detailedAnalysis
    };
  }

  private analyzeClaimAccuracy(claims: AgentClaims, evidence: Evidence): any {
    // Detailed claim-by-claim accuracy analysis
    return {
      test_claims_accuracy: this.verifyTestClaims(evidence.test_results, claims.test_claims),
      quality_claims_accuracy: this.verifyQualityClaims(evidence.code_quality, claims.quality_claims),
      // ... other claim types
    };
  }

  private identifyEvidenceGaps(evidence: Evidence): string[] {
    const gaps: string[] = [];
    
    if (!evidence.test_results) gaps.push('Missing test results');
    if (!evidence.code_quality) gaps.push('Missing code quality metrics');
    if (!evidence.system_health) gaps.push('Missing system health data');
    if (!evidence.agent_coordination) gaps.push('Missing agent coordination data');
    
    return gaps;
  }

  private assessRisks(truthScore: TruthScore): any {
    const risks: any[] = [];
    
    if (truthScore.score < 0.8) {
      risks.push({
        type: 'reliability_risk',
        description: 'Low truth score indicates unreliable agent claims',
        severity: 'high'
      });
    }

    if (truthScore.discrepancies.some(d => d.severity === 'critical')) {
      risks.push({
        type: 'critical_failure_risk',
        description: 'Critical discrepancies detected',
        severity: 'critical'
      });
    }

    return risks;
  }

  private generateRecommendations(truthScore: TruthScore): string[] {
    const recommendations: string[] = [];
    
    if (truthScore.score < this.config.minimum_threshold) {
      recommendations.push('Implement additional verification steps');
      recommendations.push('Review agent claim generation logic');
    }

    if (truthScore.evidence_quality.overall < 0.8) {
      recommendations.push('Improve evidence collection processes');
      recommendations.push('Increase evidence collection frequency');
    }

    return recommendations;
  }
}