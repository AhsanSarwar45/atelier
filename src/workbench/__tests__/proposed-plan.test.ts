import { describe, expect, it } from 'vitest';

import { proposedPlanSpecs, withoutProposedPlans } from '@/workbench/proposed-plan';

describe('proposed plan envelopes', () => {
  it('materializes a complete plan and removes only its valid envelope', () => {
    const text = 'Before\n\n<proposed_plan>\n# Build it\n\n- Safely\n</proposed_plan>\n\nAfter';
    expect(proposedPlanSpecs(text).map((plan) => plan.markdown)).toEqual(['# Build it\n\n- Safely']);
    expect(withoutProposedPlans(text)).toBe('Before\n\n\n\nAfter');
  });

  it('keeps a malformed plan readable instead of letting Markdown swallow it', () => {
    expect(withoutProposedPlans('<proposed_plan>\n# Still visible')).toBe('`<proposed_plan>`\n# Still visible');
  });
});
