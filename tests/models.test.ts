import { describe, expect, it } from 'vitest';
import { defaultModels, suggestedModels, type ModelCapability } from '../src/shared/models';
import type { ProviderId } from '../src/shared/types';

describe('model catalog', () => {
  it('lists a suggested model with the matching capability for each default', () => {
    for (const provider of ['openai', 'gemini'] as ProviderId[]) {
      for (const capability of ['live', 'file', 'translation', 'minutes'] as ModelCapability[]) {
        expect(
          suggestedModels[provider].some(
            (model) =>
              model.id === defaultModels[provider][capability] &&
              model.capabilities.includes(capability),
          ),
        ).toBe(true);
      }
    }
  });
});
