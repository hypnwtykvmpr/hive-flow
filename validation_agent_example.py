#!/usr/bin/env python3
"""
Practical Example: Validating a Credit Risk Model
================================================
Demonstrates comprehensive validation workflow
"""

import numpy as np
import pandas as pd
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
import json
from datetime import datetime
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib import Path

# Import validation framework
import sys
sys.path.append('/workspaces/claude-code-flow')
from validation_agent_main import (
    ModelValidator, DataLeakageDetector, 
    ProductionReadinessChecker
)


def create_synthetic_credit_data(n_samples=10000):
    """Create synthetic credit risk dataset"""
    # Generate base features
    X, y = make_classification(
        n_samples=n_samples,
        n_features=15,
        n_informative=10,
        n_redundant=3,
        n_clusters_per_class=2,
        weights=[0.7, 0.3],  # Imbalanced classes (good/bad credit)
        random_state=42
    )
    
    # Create meaningful feature names
    feature_names = [
        'age', 'annual_income', 'credit_score', 'debt_to_income',
        'employment_years', 'num_credit_lines', 'num_late_payments',
        'credit_utilization', 'loan_amount', 'monthly_payment',
        'account_age_months', 'num_inquiries', 'public_records',
        'total_debt', 'payment_history_score'
    ]
    
    # Convert to DataFrame
    df = pd.DataFrame(X, columns=feature_names)
    df['default'] = y  # Target: 0 = no default, 1 = default
    
    # Add some realistic constraints
    df['age'] = 18 + (df['age'] - df['age'].min()) / (df['age'].max() - df['age'].min()) * 62
    df['annual_income'] = 20000 + (df['annual_income'] - df['annual_income'].min()) / \
                         (df['annual_income'].max() - df['annual_income'].min()) * 180000
    df['credit_score'] = 300 + (df['credit_score'] - df['credit_score'].min()) / \
                        (df['credit_score'].max() - df['credit_score'].min()) * 550
    
    # Add temporal component for time series validation
    df['application_date'] = pd.date_range(
        start='2022-01-01', 
        periods=n_samples, 
        freq='H'
    )
    
    return df


def perform_comprehensive_validation(df):
    """Perform comprehensive model validation"""
    print("=" * 80)
    print("CREDIT RISK MODEL VALIDATION WORKFLOW")
    print("=" * 80)
    
    # Initialize validation components
    validator = ModelValidator()
    leakage_detector = DataLeakageDetector()
    prod_checker = ProductionReadinessChecker(
        thresholds={
            'accuracy': 0.75,
            'precision': 0.70,
            'recall': 0.65,
            'f1_score': 0.68
        }
    )
    
    # Step 1: Data Validation
    print("\n1. DATA VALIDATION")
    print("-" * 40)
    
    # Check for feature leakage
    feature_cols = [col for col in df.columns if col not in ['default', 'application_date']]
    leakage_check = leakage_detector.check_feature_leakage(feature_cols)
    print(f"✓ Feature leakage check: {'PASSED' if leakage_check else 'FAILED'}")
    
    # Check temporal leakage
    temporal_check = leakage_detector.check_temporal_leakage(df, 'application_date')
    print(f"✓ Temporal leakage check: {'PASSED' if temporal_check else 'FAILED'}")
    
    # Step 2: Prepare data
    print("\n2. DATA PREPARATION")
    print("-" * 40)
    
    # Temporal split to avoid leakage
    df_sorted = df.sort_values('application_date')
    train_size = int(0.7 * len(df_sorted))
    
    train_df = df_sorted[:train_size]
    test_df = df_sorted[train_size:]
    
    X_train = train_df[feature_cols].values
    y_train = train_df['default'].values
    X_test = test_df[feature_cols].values
    y_test = test_df['default'].values
    
    print(f"✓ Training samples: {len(X_train)}")
    print(f"✓ Test samples: {len(X_test)}")
    print(f"✓ Class distribution (train): {np.bincount(y_train)}")
    print(f"✓ Class distribution (test): {np.bincount(y_test)}")
    
    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)
    
    # Step 3: Model Training and Validation
    print("\n3. MODEL VALIDATION")
    print("-" * 40)
    
    models = {
        'Logistic Regression': LogisticRegression(random_state=42, max_iter=1000),
        'Random Forest': RandomForestClassifier(n_estimators=100, random_state=42),
        'Gradient Boosting': GradientBoostingClassifier(n_estimators=100, random_state=42)
    }
    
    validation_results = {}
    
    for model_name, model in models.items():
        print(f"\nValidating {model_name}...")
        
        # Cross-validation
        cv_scores = validator.validate_model(
            model, X_train_scaled, y_train,
            cv_strategy='stratified_kfold',
            n_splits=5
        )
        
        # Train final model
        model.fit(X_train_scaled, y_train)
        
        # Generate validation report
        report = validator.generate_validation_report(
            model, X_test_scaled, y_test,
            model_name=model_name
        )
        
        # Debug predictions
        error_analysis = validator.debug_predictions(
            model, X_test_scaled, y_test
        )
        
        # Production readiness checks
        metrics = report['metrics']
        threshold_pass, failures = prod_checker.check_performance_thresholds(metrics)
        robustness_pass, message = prod_checker.check_model_robustness(cv_scores)
        
        # Store results
        validation_results[model_name] = {
            'cv_scores': cv_scores,
            'cv_mean': np.mean(cv_scores),
            'cv_std': np.std(cv_scores),
            'test_metrics': metrics,
            'error_rate': error_analysis['error_rate'],
            'production_ready': threshold_pass and robustness_pass,
            'threshold_failures': failures,
            'robustness_message': message
        }
        
        # Print summary
        print(f"  - CV Score: {np.mean(cv_scores):.4f} (+/- {np.std(cv_scores):.4f})")
        print(f"  - Test Accuracy: {metrics['accuracy']:.4f}")
        print(f"  - Test F1 Score: {metrics['f1_score']:.4f}")
        print(f"  - Error Rate: {error_analysis['error_rate']:.4f}")
        print(f"  - Production Ready: {'YES' if threshold_pass and robustness_pass else 'NO'}")
        
        if not threshold_pass:
            print(f"    Threshold failures: {', '.join(failures)}")
    
    # Step 4: Model Comparison
    print("\n4. MODEL COMPARISON")
    print("-" * 40)
    
    best_model = max(validation_results.items(), 
                    key=lambda x: x[1]['test_metrics']['f1_score'])
    
    print(f"\nBest Model: {best_model[0]}")
    print(f"F1 Score: {best_model[1]['test_metrics']['f1_score']:.4f}")
    
    # Step 5: Generate Production Checklist
    print("\n5. PRODUCTION READINESS CHECKLIST")
    print("-" * 40)
    
    checklist = prod_checker.generate_checklist()
    for item, status in checklist.items():
        status_icon = "✓" if status else "✗"
        print(f"{status_icon} {item.replace('_', ' ').title()}")
    
    # Save comprehensive results
    final_results = {
        'timestamp': datetime.now().isoformat(),
        'dataset_info': {
            'total_samples': len(df),
            'train_samples': len(X_train),
            'test_samples': len(X_test),
            'features': feature_cols,
            'class_balance': {
                'train': np.bincount(y_train).tolist(),
                'test': np.bincount(y_test).tolist()
            }
        },
        'validation_results': validation_results,
        'best_model': {
            'name': best_model[0],
            'metrics': best_model[1]
        },
        'production_checklist': checklist
    }
    
    # Save results
    output_path = Path('/workspaces/claude-code-flow/validation_example_results.json')
    with open(output_path, 'w') as f:
        json.dump(final_results, f, indent=2)
    
    print(f"\n✓ Results saved to: {output_path}")
    
    return final_results


def visualize_validation_results(results):
    """Create visualization of validation results"""
    # Extract model comparison data
    model_names = []
    cv_means = []
    cv_stds = []
    test_f1s = []
    
    for model_name, metrics in results['validation_results'].items():
        model_names.append(model_name)
        cv_means.append(metrics['cv_mean'])
        cv_stds.append(metrics['cv_std'])
        test_f1s.append(metrics['test_metrics']['f1_score'])
    
    # Create comparison plot
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    
    # CV scores with error bars
    x = np.arange(len(model_names))
    ax1.bar(x, cv_means, yerr=cv_stds, capsize=10, color='skyblue', edgecolor='navy')
    ax1.set_xlabel('Model')
    ax1.set_ylabel('Cross-Validation Score')
    ax1.set_title('Model Performance (CV)')
    ax1.set_xticks(x)
    ax1.set_xticklabels(model_names, rotation=45, ha='right')
    ax1.grid(axis='y', alpha=0.3)
    
    # Test F1 scores
    ax2.bar(x, test_f1s, color='lightcoral', edgecolor='darkred')
    ax2.set_xlabel('Model')
    ax2.set_ylabel('Test F1 Score')
    ax2.set_title('Model Performance (Test)')
    ax2.set_xticks(x)
    ax2.set_xticklabels(model_names, rotation=45, ha='right')
    ax2.grid(axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig('/workspaces/claude-code-flow/validation_comparison.png', dpi=150)
    print("\n✓ Visualization saved to: validation_comparison.png")


def main():
    """Run the complete validation example"""
    print("Starting Credit Risk Model Validation Example...")
    
    # Create synthetic dataset
    df = create_synthetic_credit_data(n_samples=5000)
    
    # Perform validation
    results = perform_comprehensive_validation(df)
    
    # Create visualizations
    try:
        visualize_validation_results(results)
    except Exception as e:
        print(f"Visualization skipped: {e}")
    
    print("\n" + "=" * 80)
    print("VALIDATION COMPLETE!")
    print("=" * 80)
    
    return results


if __name__ == "__main__":
    results = main()