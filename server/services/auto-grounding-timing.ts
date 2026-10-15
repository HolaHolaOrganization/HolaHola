/** Content-free timing only: no queries, user IDs, retrieved text, or errors. */
export type GroundingLookupStage =
  | 'orm_module' | 'schema_module' | 'semantic_search' | 'semantic_records'
  | 'felt_history' | 'north_star' | 'keyword_records';

export interface GroundingLookupTiming {
  attemptId?: string;
  totalMs: number;
  stages: Array<{ stage: GroundingLookupStage; elapsedMs: number; outcome: 'completed' | 'failed' }>;
}

export function createGroundingTiming(
  attemptId?: string,
  now: () => number = () => performance.now(),
) {
  const start = now();
  const stages: GroundingLookupTiming['stages'] = [];
  return {
    async measure<T>(stage: GroundingLookupStage, work: () => PromiseLike<T>): Promise<T> {
      const began = now();
      let outcome: 'completed' | 'failed' = 'completed';
      try {
        return await work();
      } catch (error) {
        outcome = 'failed';
        throw error; // preserve existing fallback/error semantics and identity
      } finally {
        stages.push({ stage, elapsedMs: Math.max(0, Math.round(now() - began)), outcome });
      }
    },
    snapshot(): GroundingLookupTiming {
      return {
        ...(attemptId ? { attemptId } : {}),
        totalMs: Math.max(0, Math.round(now() - start)),
        stages: stages.map(stage => ({ ...stage })),
      };
    },
  };
}
