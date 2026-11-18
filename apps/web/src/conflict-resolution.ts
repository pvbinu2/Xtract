import type { ExtractedValue } from './types';

export function selectReviewCandidate(
  field: ExtractedValue,
  candidate: NonNullable<ExtractedValue['reviewCandidates']>[number],
): ExtractedValue {
  return {
    ...field,
    value: candidate.value,
    confidence: candidate.confidence,
    needsReview: false,
    reviewCandidates: [],
    sourceEvidence: [candidate.evidence],
    boundingBoxes: [],
    cellReferences: [],
  };
}
