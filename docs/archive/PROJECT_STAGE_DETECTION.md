# Project Stage Detection for PM Prioritization

## Overview

The PM needs to determine the project stage to make intelligent prioritization decisions. This document outlines multiple approaches with varying levels of sophistication.

## Available Data Points

### 1. Milestone Metadata
```typescript
milestone: {
  name: "local-log-ingestion",
  slug: "local-log-ingestion",
  description: string,
  status: "in_progress" | "completed" | "planned" | etc,
  tags: string[],  // If available from dashboard
  metadata: object  // Custom fields if available
}
```

### 2. Milestone Completion Percentage
```typescript
milestone_completion_percentage: number  // 0-100
```

### 3. Project Metadata
```typescript
project: {
  id: string,
  name: string,
  created_at: date,
  metadata: object  // Custom fields
}
```

### 4. Task History
- Number of completed tasks
- Number of remaining tasks
- Types of milestones completed

## Approach 1: Convention-Based Stage Detection (Simplest)

Use naming conventions in milestone names/descriptions to infer stage:

### Stage Keywords:

```typescript
const STAGE_KEYWORDS = {
  mvp: ["mvp", "minimum viable", "proof of concept", "poc", "prototype", "initial", "foundation", "basic"],
  alpha: ["alpha", "internal testing", "early access", "development", "feature complete"],
  beta: ["beta", "user testing", "pilot", "preview", "early release"],
  production: ["production", "live", "release", "launch", "deployment", "general availability", "ga"],
  hardening: ["hardening", "security", "performance", "optimization", "polish", "refinement"],
  maintenance: ["maintenance", "bugfix", "patch", "update", "support"]
};
```

### Detection Logic:

```typescript
function detectStageFromMilestone(milestone_name: string, milestone_description: string): string {
  const text = (milestone_name + " " + milestone_description).toLowerCase();
  
  for (const [stage, keywords] of Object.entries(STAGE_KEYWORDS)) {
    if (keywords.some(keyword => text.includes(keyword))) {
      return stage;
    }
  }
  
  return "unknown";  // Default to cautious approach
}
```

### Usage in Workflow:

Update workflow YAML to include stage detection guidance:

```yaml
context_for_pm: |
  STAGE DETECTION:
  Analyze the milestone_name ("${milestone_name}") to determine project stage:
  - If contains "mvp", "poc", "prototype", "initial", "foundation" → EARLY STAGE
  - If contains "beta", "pilot", "preview" → BETA STAGE
  - If contains "production", "launch", "release" → PRODUCTION STAGE
  - If contains "hardening", "security", "polish" → HARDENING STAGE
  
  PROJECT STAGE PRIORITIES:
  
  EARLY STAGE (MVP/POC):
  - Focus: Functionality over perfection
  - Immediate fixes: Blocking bugs, critical security (RCE, SQL injection)
  - Can defer: Auth hardening, license policy, documentation, optimization
  
  BETA STAGE:
  - Focus: Stability and user experience
  - Immediate fixes: User-facing bugs, moderate security issues
  - Can defer: Performance optimization, advanced features
  
  PRODUCTION STAGE:
  - Focus: Reliability and security
  - Immediate fixes: All security issues, data integrity, compliance
  - Can defer: Nice-to-have features, minor optimizations
```

## Approach 2: Milestone Completion Based (Simple)

Use completion percentage as a proxy for maturity:

```typescript
function detectStageFromCompletion(completion_percentage: number): string {
  if (completion_percentage < 30) return "early";
  if (completion_percentage < 70) return "development";
  if (completion_percentage < 90) return "stabilization";
  return "completion";
}
```

## Approach 3: Explicit Milestone Tags (Recommended)

Add stage tags to milestones in the dashboard:

```typescript
milestone: {
  tags: ["stage:mvp", "security:low-priority", "environment:development"]
}
```

Parse tags in workflow:

```yaml
context_for_pm: |
  Milestone tags: ${milestone_tags}
  
  If milestone has tag "stage:mvp" or "stage:early" → Use EARLY STAGE priorities
  If milestone has tag "stage:beta" → Use BETA STAGE priorities
  If milestone has tag "stage:production" → Use PRODUCTION STAGE priorities
```

## Approach 4: Project-Level Configuration (Most Robust)

Add project metadata fields in dashboard:

```typescript
project: {
  metadata: {
    stage: "mvp" | "alpha" | "beta" | "production",
    security_priority: "low" | "medium" | "high",
    external_users: boolean,
    compliance_required: boolean
  }
}
```

## Recommended Implementation (Hybrid)

Combine multiple signals with fallback logic:

### 1. Update Workflow Context

```yaml
pm_prioritize_security_failures:
  payload:
    # Existing fields...
    milestone: "${milestone}"
    milestone_name: "${milestone_name}"
    milestone_description: "${milestone_description}"
    milestone_completion_percentage: "${milestone_completion_percentage}"
    
    # NEW: Stage detection guidance
    context_for_pm: |
      PROJECT STAGE ANALYSIS:
      
      Milestone: "${milestone_name}"
      Description: "${milestone_description}"
      Completion: ${milestone_completion_percentage}%
      
      DETERMINE PROJECT STAGE using these signals:
      
      1. MILESTONE NAME ANALYSIS:
         Check if milestone_name contains stage indicators:
         - MVP/POC keywords: "mvp", "poc", "prototype", "initial", "foundation", "basic" → EARLY STAGE
         - Development: "development", "feature", "implementation" → DEVELOPMENT STAGE
         - Beta/Testing: "beta", "pilot", "testing", "preview" → BETA STAGE
         - Production: "production", "launch", "release", "live" → PRODUCTION STAGE
         - Hardening: "hardening", "security", "optimization", "polish" → HARDENING STAGE
      
      2. COMPLETION PERCENTAGE:
         - <30% → Likely EARLY STAGE
         - 30-70% → Likely DEVELOPMENT STAGE
         - 70-90% → Likely STABILIZATION STAGE
         - >90% → Likely COMPLETION STAGE
      
      3. EXTERNAL USERS:
         - "This is an early-stage project not yet exposed to external users" → EARLY STAGE
         - If mention of users, beta testers → BETA STAGE
         - If production deployment → PRODUCTION STAGE
      
      PRIORITIZATION BY STAGE:
      
      EARLY STAGE (MVP, POC, Initial):
      ✓ IMMEDIATE: Critical vulnerabilities only (SQL injection, RCE, data leaks)
      ✗ DEFER: Auth hardening, license policy, secrets scanning, threat models, documentation
      
      DEVELOPMENT STAGE (30-70% complete):
      ✓ IMMEDIATE: Security vulnerabilities (medium+), blocking bugs
      ✗ DEFER: Auth hardening, advanced security, optimization
      
      BETA STAGE (User testing):
      ✓ IMMEDIATE: User-facing security, data integrity, stability
      ✗ DEFER: Advanced hardening, optimization
      
      PRODUCTION STAGE (Live users):
      ✓ IMMEDIATE: ALL security issues, compliance, data protection
      ✗ DEFER: Performance optimization (if not user-impacting)
      
      HARDENING STAGE (Pre-production prep):
      ✓ IMMEDIATE: All security issues, performance bottlenecks
      ✗ DEFER: Minor optimizations, cosmetic improvements
```

### 2. PM Response Format

The PM should include stage detection in response:

```json
{
  "detected_stage": "early",
  "stage_reasoning": "Milestone name contains 'initial' and completion is 25%. No external users mentioned.",
  "decision": "defer",
  "reasoning": "Early stage project (MVP phase). Security issues identified are important but not critical. Focus on functionality first, security hardening in later milestone.",
  "immediate_issues": [],
  "deferred_issues": [...]
}
```

## Implementation Plan

### Phase 1: Immediate (Convention-Based)
1. ✅ Update workflow YAML with stage detection guidance
2. ✅ Add milestone name/description/completion to PM payload
3. ✅ Document stage-based prioritization rules
4. Test with actual workflow runs

### Phase 2: Enhanced (Tag-Based)
1. Add stage tags to milestones in dashboard
2. Parse and expose tags in workflow context
3. PM uses explicit tags when available

### Phase 3: Robust (Project Metadata)
1. Add project-level stage configuration in dashboard
2. Add security_priority and external_users fields
3. Workflow reads project metadata
4. PM uses authoritative project configuration

## Testing Strategy

Test PM decisions across different scenarios:

```typescript
const TEST_SCENARIOS = [
  {
    milestone_name: "MVP - Local Log Ingestion",
    completion: 25,
    security_issues: ["file_traversal", "missing_license", "secrets_scanning"],
    expected_decision: "defer",
    expected_stage: "early"
  },
  {
    milestone_name: "Beta Testing Phase",
    completion: 75,
    security_issues: ["sql_injection", "auth_bypass"],
    expected_decision: "immediate_fix",
    expected_stage: "beta"
  },
  {
    milestone_name: "Production Release",
    completion: 95,
    security_issues: ["weak_crypto", "missing_csrf"],
    expected_decision: "immediate_fix",
    expected_stage: "production"
  }
];
```

## Example PM Decision Logic

```typescript
// Pseudo-code for PM's internal reasoning

function prioritize_security_failures(context) {
  // 1. Detect stage
  const stage = detectStage(
    context.milestone_name,
    context.milestone_description,
    context.milestone_completion_percentage
  );
  
  // 2. Classify issues by severity
  const issues = classifySecurityIssues(context.security_result);
  
  // 3. Apply stage-appropriate rules
  if (stage === "early") {
    return {
      immediate_issues: issues.filter(i => i.severity === "critical"),
      deferred_issues: issues.filter(i => i.severity !== "critical")
    };
  } else if (stage === "production") {
    return {
      immediate_issues: issues,  // All issues immediate in production
      deferred_issues: []
    };
  }
  
  // ... etc
}
```

## Benefits

1. **Adaptive Prioritization**: PM adjusts decisions based on actual project stage
2. **No Manual Config Required**: Works with existing milestone names
3. **Upgradeable**: Can add explicit tags/metadata later
4. **Transparent**: PM explains stage detection in response
5. **Flexible**: Multiple detection methods with fallbacks

## Next Steps

1. ✅ Implement Phase 1 (convention-based) in workflow YAML
2. Test with actual workflow runs to validate PM decisions
3. Collect feedback on stage detection accuracy
4. Consider Phase 2 (tags) if convention-based detection is insufficient
5. Add project-level metadata (Phase 3) for enterprise customers needing strict control
