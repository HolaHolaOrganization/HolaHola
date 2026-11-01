import type { Application, Response } from 'express';

export function registerLucaObserverRoute({
  app, storage, getSharedDb, loadAuthenticatedUser, requireFounderOrCoordinationCapability, requireFounder,
}: {
  app: Application; storage: any; getSharedDb: typeof import('../db').getSharedDb; loadAuthenticatedUser: any; requireFounderOrCoordinationCapability: any; requireFounder: any;
}): void {
  // Observation bench — Luca reads the live session state from the Replit chat window.
  // Returns in-memory GL state + last N DB messages for the active conversation.
  // Auth: x-coordination-token header OR authenticated founder browser session.
  app.get("/api/admin/luca/observe", loadAuthenticatedUser(storage), requireFounderOrCoordinationCapability(
    requireFounder,
    'observation:read',
    [
      'luca-replit', 'luca-claude-code', 'luca-gemini', 'luca-antigravity', 'luca-holahola',
      'luca-cursor', 'luca-openai-agents', 'luca-codex',
    ],
  ), async (req: any, res: Response) => {
    try {
      const {
        getAllActiveObservations,
        getObservation,
        getContextLineageObservationAvailability,
      } = await import('../services/session-observation-store');
      const conversationId = req.query.conversationId as string | undefined;

      // If no conversationId provided, find the most recently active session
      let observation = conversationId
        ? getObservation(conversationId)
        : getAllActiveObservations().sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs)[0] ?? null;

      const { sql: rawSql } = await import('drizzle-orm');
      const obsDb = getSharedDb();
      const { deriveGuardianObserverEvidence } = await import('../services/guardian-observer-evidence');
      const projectGuardianEvidence = (rows: any[], sessionRow: any | null) =>
        deriveGuardianObserverEvidence(
          rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            eventData: row.event_data,
            createdAt: row.created_at,
          })),
          sessionRow ? {
            guardianFires: sessionRow.guardian_fires,
            guardianHardWalls: sessionRow.guardian_hard_walls,
            guardianHeard: sessionRow.guardian_heard,
            guardianMissed: sessionRow.guardian_missed,
            guardianCarryForward: sessionRow.guardian_carry_forward,
          } : null,
        );

      if (!observation) {
        // Fall back to DB — find the most recent active voice session
        const activeRow = conversationId
          ? await obsDb.execute(
            rawSql`SELECT id, conversation_id, language, exchange_count, started_at, ended_at, user_id,
                        guardian_fires, guardian_hard_walls, guardian_heard,
                        guardian_missed, guardian_carry_forward
                 FROM voice_sessions
                 WHERE status = 'active' AND conversation_id = ${conversationId}
                 ORDER BY started_at DESC
                 LIMIT 1`
          )
          : await obsDb.execute(
            rawSql`SELECT id, conversation_id, language, exchange_count, started_at, ended_at, user_id,
                          guardian_fires, guardian_hard_walls, guardian_heard,
                          guardian_missed, guardian_carry_forward
                   FROM voice_sessions
                   WHERE status = 'active'
                   ORDER BY started_at DESC
                   LIMIT 1`
          );
        const row = (activeRow as any).rows?.[0] ?? (activeRow as any)[0] ?? null;
        if (!row) {
          return res.json({ status: 'no_active_session', message: 'No active GL session found.' });
        }
        const persistedEvents = await obsDb.execute(rawSql`
          SELECT event.id, event.session_id, event.event_data, event.created_at
          FROM voice_pipeline_events event
          WHERE event.event_type = 'gl_guardian_fire'
            AND (
              event.session_id = ${row.id}
              OR (
                event.event_data->>'conversationId' = ${row.conversation_id}
                AND event.created_at >= ${row.started_at}
                AND (${row.ended_at}::timestamp IS NULL OR event.created_at <= ${row.ended_at})
                AND NOT EXISTS (
                  SELECT 1 FROM voice_sessions known
                  WHERE known.id = event.session_id
                )
              )
            )
          ORDER BY event.created_at ASC
        `);
        return res.json({
          status: 'db_only',
          message: 'Session active in DB but not yet in observation store (started before server restart, or store expired).',
          session: {
            conversationId: row.conversation_id,
            language: row.language,
            exchangeCount: row.exchange_count,
            startedAt: row.started_at,
            userId: row.user_id,
          },
          guardianEvidence: projectGuardianEvidence(
            ((persistedEvents as any).rows ?? []) as any[],
            row,
          ),
        });
      }

      // Pull the last 10 messages from this conversation
      const convId = observation.conversationId;
      const recentMessages = await obsDb.execute(
        rawSql`SELECT role, content, created_at
               FROM messages
               WHERE conversation_id = ${convId}
               ORDER BY created_at DESC
               LIMIT 10`
      );
      const msgs = ((recentMessages.rows ?? []) as any[]).reverse().map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 500) : '[non-text]',
        at: m.created_at,
      }));

      // Vision cache lookup — pull Daniela's visual description of the current scene
      let sceneVisionDescription: string | null = null;
      if (observation.sceneImageUrl) {
        try {
          const visionRow = await obsDb.execute(
            rawSql`SELECT description FROM image_vision_cache WHERE image_url = ${observation.sceneImageUrl} LIMIT 1`
          );
          const vRow = (visionRow as any).rows?.[0] ?? (visionRow as any)[0] ?? null;
          sceneVisionDescription = vRow?.description ?? null;
        } catch {
          // non-fatal — vision cache miss is fine
        }
      }

      // Elapsed time
      const elapsedMs = Date.now() - observation.sessionStartedMs;
      const elapsedMin = Math.round(elapsedMs / 60000);
      const lineage = observation.contextLineage;
      const lineageAvailability = getContextLineageObservationAvailability(lineage);
      const guardianSessionResult = observation.dbSessionId
        ? await obsDb.execute(rawSql`
          SELECT id, guardian_fires, guardian_hard_walls, guardian_heard,
                 guardian_missed, guardian_carry_forward, started_at
          FROM voice_sessions
          WHERE id = ${observation.dbSessionId}
          LIMIT 1
        `)
        : await obsDb.execute(rawSql`
          SELECT id, guardian_fires, guardian_hard_walls, guardian_heard,
                 guardian_missed, guardian_carry_forward, started_at
          FROM voice_sessions
          WHERE conversation_id = ${convId}
            AND user_id = ${observation.userId}
          ORDER BY started_at DESC
          LIMIT 1
        `);
      const guardianSession = ((guardianSessionResult as any).rows ?? [])[0] ?? null;
      const guardianEventResult = await obsDb.execute(rawSql`
          SELECT id, session_id, event_data, created_at
          FROM voice_pipeline_events
          WHERE event_type = 'gl_guardian_fire'
            AND (
              session_id = ${observation.dbSessionId ?? '__no_db_session__'}
              OR session_id = ${observation.transientSessionId ?? '__no_transient_session__'}
            )
          ORDER BY created_at ASC
        `);
      let guardianRows = ((guardianEventResult as any).rows ?? []) as any[];
      if (guardianSession && !observation.dbSessionId) {
        const bySessionResult = await obsDb.execute(rawSql`
          SELECT id, session_id, event_data, created_at
          FROM voice_pipeline_events
          WHERE event_type = 'gl_guardian_fire'
            AND session_id = ${guardianSession.id}
          ORDER BY created_at ASC
        `);
        guardianRows = [...guardianRows, ...(((bySessionResult as any).rows ?? []) as any[])];
      }
      const guardianEvidence = projectGuardianEvidence(guardianRows, guardianSession);

      res.json({
        status: 'active',
        elapsedMin,
        conversationId: observation.conversationId,
        language: observation.language,
        actflLevel: observation.actflLevel,
        exchangeCount: observation.exchangeCount,
        scenarioSlug: observation.scenarioSlug,
        sceneEnvironment: observation.sceneEnvironment,
        sceneVisionDescription,
        sceneProps: observation.sceneProps,
        recentToolCalls: observation.recentToolCalls.slice(0, 8).map(t => ({
          name: t.name,
          secsAgo: Math.round((Date.now() - t.ts) / 1000),
          note: t.note,
        })),
        lastUpdatedSecsAgo: Math.round((Date.now() - observation.lastUpdatedMs) / 1000),
        recentMessages: msgs,
        // Archive Guardian — live state + fire log for this session (all four protocols)
        guardianAB: {
          globalChannel: observation.guardianChannel,
          recentFires: observation.guardianFireLog.slice(-10).map(f => ({
            ts: f.ts,
            path: f.path,
            phrase: f.phrase.slice(0, 60),
            channel: f.channel,
            // Compatibility-only heuristic, never an authoritative delivery outcome.
            legacyHeuristicOutcome: f.outcome,
            traceAttemptId: f.attemptId ?? null,
            charsInjected: f.charsInjected,
            groundingPreview: f.groundingPreview,
          })),
          // Summary counts
          pendingCount:          observation.guardianFireLog.filter(f => f.outcome === null).length,
          legacyHeuristicOutcomeCount: observation.guardianFireLog.filter(f => f.outcome !== null).length,
          unknownDeliveryCount: (observation.guardianAttempts ?? []).filter(
            attempt => attempt.terminalOutcome === 'injected_delivery_unknown' || attempt.terminalOutcome === 'delivery_unknown',
          ).length,
          universalPreTurnCount: observation.guardianFireLog.filter(f => f.path === 'pre-turn' && f.phrase.startsWith('universal')).length,
          riskPhraseCount:       observation.guardianFireLog.filter(f => f.path === 'pre-turn' && f.phrase.startsWith('phrase')).length,
          hardWallCount:         observation.guardianFireLog.filter(f => f.path === 'hard-wall').length,
          totalPreTurnCount:     observation.guardianFireLog.filter(f => f.path === 'pre-turn').length,
          carryForwardBufferedCount: observation.guardianFireLog.filter(f => f.path === 'carry-forward-buffered').length,
          carryForwardInjectedCount: observation.guardianFireLog.filter(f => f.path === 'carry-forward-injected').length,
        },
        guardianEvidence,
        // Exact evidence chain for grounding interventions. These are not inferred
        // "heard/missed" labels: each timeline names what the system observed.
        guardianAttemptTimeline: (observation.guardianAttempts ?? []).slice(-10).map(attempt => ({
          attemptId: attempt.attemptId,
          path: attempt.path,
          studentTurnEpoch: attempt.studentTurnEpoch,
          studentUtterance: attempt.studentUtterance.slice(0, 240),
          candidateAssertion: attempt.candidateAssertion.slice(0, 180),
          terminalOutcome: attempt.terminalOutcome,
          events: attempt.events.map(event => ({
            type: event.type,
            ts: event.ts,
            channel: event.channel ?? null,
            modelTurnId: event.modelTurnId ?? null,
            toolBatchSequence: event.toolBatchSequence ?? null,
            archiveTool: event.archiveTool ?? null,
            detail: event.detail ?? null,
          })),
        })),
        // Neural-net memory searches — real-time feed from searchTeachingKnowledge calls
        recentMemorySearches: (observation.recentMemorySearches ?? []).slice(0, 10).map(s => ({
          secsAgo:       Math.round((Date.now() - s.ts) / 1000),
          tool:          s.tool,
          query:         s.query.slice(0, 80),
          resultCount:   s.resultCount,
          durationMs:    s.durationMs,
          domainsHit:    s.domainsSearched,
          formattedChars: s.formattedChars,
        })),
        // Per-turn tool-call summaries (last 5, oldest-first so [length-1] = latest)
        turnSummaries: (observation.turnSummaries ?? []).slice(0, 5).reverse().map(t => ({
          turn:           t.turn,
          tools:          t.tools,
          hasArchiveCall: t.hasArchiveCall,
          secsAgo:        Math.round((Date.now() - t.ts) / 1000),
        })),
        // Friction history from analyzeFriction (last 5, oldest-first so [length-1] = latest)
        frictionHistory: (observation.frictionHistory ?? []).slice(0, 5).reverse().map(f => ({
          turnId:                   String(f.turn),
          label:                    f.label,
          score:                    f.totalScore,
          archiveAccess:            f.archiveAccess,
          smoothSlide:              f.smoothSlide,
          unverifiedAssertionCount: f.unverifiedAssertionCount,
          firstUnverifiedAssertion: f.firstUnverifiedAssertion,
          secsAgo:                  Math.round((Date.now() - f.ts) / 1000),
        })),
        // Canonical context-lineage evidence is opt-in today. Keep the capture
        // state explicit so an empty projection is never mistaken for proof that
        // nothing was sent or that Daniela did not receive it.
        contextLineage: {
          availability: lineageAvailability,
          activeTraceId: lineage?.activeTraceId ?? null,
          events: (lineage?.events ?? []).map(event => ({
            id: event.id,
            traceId: event.traceId,
            sequenceNumber: event.sequenceNumber,
            sourceRoute: event.sourceRoute,
            eventType: event.eventType,
            deliveryChannel: event.deliveryChannel,
            deliveryStatus: event.deliveryStatus,
            studentTurnEpoch: event.studentTurnEpoch,
            payloadSha256: event.payloadSha256,
            observedAt: event.observedAt,
          })),
          links: (lineage?.links ?? []).map(link => ({
            id: link.id,
            traceId: link.traceId,
            fromEventId: link.fromEventId,
            toEventId: link.toEventId,
            linkType: link.linkType,
            observedAt: link.observedAt,
          })),
          health: lineage?.health ?? {
            state: "healthy",
            pendingWrites: 0,
            failedWrites: 0,
            firstUnrecordedSequenceNumber: null,
            lastError: null,
          },
        },
      });
    } catch (err: any) {
      console.error('[Luca Observe] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
