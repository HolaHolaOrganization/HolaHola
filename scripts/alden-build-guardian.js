#!/usr/bin/env node
/**
 * Alden Build Guardian — CAP-008 Verification
 *
 * Runs as a DETACHED process, fully independent of the tsx-managed server.
 * Survives the tsx hot reload that kills the main server process after file writes.
 *
 * Supports two modes (set via manifest.mode):
 *   'team-room' (default) — reports to /api/team-room/internal/guardian-complete
 *   'chat'                — reports to /api/alden/internal/guardian-complete
 *
 * Flow:
 *   1. Read manifest (written by alden-build-service or alden-functions before applying changes)
 *   2. Wait 14 seconds for tsx to detect changes and restart the server
 *   3. Poll /api/health until the server responds or timeout (30s)
 *   4. SUCCESS → sync to GitHub, POST success to server, clean up manifest
 *   5. FAILURE → restore all backup files, wait for tsx to re-detect, POST failure
 */

'use strict';

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MANIFEST_PATH = '/tmp/alden-guardian-manifest.json';
const INITIAL_WAIT_MS = 14000;   // tsx typically restarts within 8-12 seconds
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_MS = 35000;       // Total post-initial polling window
const GUARDIAN_TOKEN = process.env.GUARDIAN_TOKEN;
const SOURCE_CONTROL_RESULT_PREFIX = 'SOURCE_CONTROL_RESULT_JSON:';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkHealth(port) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/api/health`, res => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function pollUntilHealthy(port) {
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    const ok = await checkHealth(port);
    if (ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function restoreBackups(backups) {
  const restored = [];
  const errors = [];
  for (const [filePath, content] of Object.entries(backups)) {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      restored.push(filePath);
      console.log(`[Guardian] Restored: ${filePath}`);
    } catch (err) {
      errors.push(`${filePath}: ${err.message}`);
      console.error(`[Guardian] Restore failed for ${filePath}:`, err.message);
    }
  }
  return { restored, errors };
}

function requestSourceControlSync(cwd) {
  try {
    const cliPath = path.join(cwd, 'server/scripts/source-control-cli.ts');
    const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'sync', '--actor', 'alden-build-guardian', '--machine-readable'], {
      cwd,
      timeout: 60000,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    const resultLine = output
      .split(/\r?\n/)
      .findLast((line) => line.startsWith(SOURCE_CONTROL_RESULT_PREFIX));
    if (!resultLine) {
      throw new Error('Source-control CLI did not emit a machine-readable result.');
    }
    const result = JSON.parse(resultLine.slice(SOURCE_CONTROL_RESULT_PREFIX.length));
    console.log(`[Guardian] Source-control state: ${result.state}`);
    return { synced: result.ok === true, error: result.error || null };
  } catch (err) {
    const msg = err.message?.substring(0, 300) || 'Unknown error';
    console.error('[Guardian] Source-control request failed:', msg);
    return { synced: false, error: msg };
  }
}

function postToServer(port, endpointPath, payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Guardian-Token': GUARDIAN_TOKEN,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, data: 'timeout' }); });
    req.on('error', err => resolve({ status: 0, data: err.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!GUARDIAN_TOKEN || !GUARDIAN_TOKEN.trim()) {
    throw new Error('GUARDIAN_TOKEN must be configured; refusing unauthenticated Guardian callbacks.');
  }
  console.log('[Guardian] Starting up');

  // Read manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (err) {
    console.error('[Guardian] Cannot read manifest:', err.message);
    process.exit(1);
  }

  const {
    mode = 'team-room',
    roomId,
    conversationId,
    featureName,
    backups,
    port = 5000,
    cwd = process.cwd(),
  } = manifest;

  // Determine which endpoint to report to based on mode
  const reportEndpoint = mode === 'chat'
    ? '/api/alden/internal/guardian-complete'
    : mode === 'auto-repair'
    ? '/api/alden/internal/auto-repair-complete'
    : '/api/team-room/internal/guardian-complete';

  // The identifier used in the payload (roomId for team-room, conversationId for chat)
  const contextId = mode === 'chat' ? conversationId : roomId;

  console.log(`[Guardian] Mode: ${mode} | Build: "${featureName}" | Context: ${contextId || manifest.repairId || 'n/a'}`);

  // Phase 1: Wait for tsx to detect changes and restart
  console.log(`[Guardian] Waiting ${INITIAL_WAIT_MS / 1000}s for tsx hot reload...`);
  await sleep(INITIAL_WAIT_MS);

  // Phase 2: Poll for server health
  console.log('[Guardian] Polling server health...');
  const healthy = await pollUntilHealthy(port);

  if (healthy) {
    console.log('[Guardian] Server healthy — proceeding');

    // Give the server another moment to fully settle
    await sleep(3000);

    // GitHub sync (skip for auto-repair — changes are unreviewed)
    let synced = false;
    let githubError = null;
    if (mode !== 'auto-repair') {
      const syncResult = requestSourceControlSync(cwd);
      synced = syncResult.synced;
      githubError = syncResult.error || null;
    }

    // Report success to server
    const successPayload = mode === 'auto-repair'
      ? {
          repairId: manifest.repairId,
          featureName,
          issueDescription: manifest.issueDescription,
          explanation: manifest.explanation,
          changeDescriptions: manifest.changeDescriptions || [],
          success: true,
          filesRestored: [],
        }
      : {
          roomId,
          conversationId,
          featureName,
          success: true,
          githubSynced: synced,
          githubError,
          filesRestored: [],
        };

    const postResult = await postToServer(port, reportEndpoint, successPayload);
    console.log(`[Guardian] Posted success to ${reportEndpoint}: HTTP ${postResult.status}`);

  } else {
    console.error('[Guardian] Server did not come back — rolling back');

    // Restore backups
    const { restored, errors: restoreErrors } = restoreBackups(backups);

    // Wait for tsx to pick up the restored files and restart again
    console.log('[Guardian] Waiting for tsx to re-load restored files...');
    await sleep(INITIAL_WAIT_MS);

    // Poll again — server should come back with original code
    const recoveredHealthy = await pollUntilHealthy(port);

    if (recoveredHealthy) {
      await sleep(2000);

      const failPayload = mode === 'auto-repair'
        ? {
            repairId: manifest.repairId,
            featureName,
            issueDescription: manifest.issueDescription,
            explanation: manifest.explanation,
            changeDescriptions: manifest.changeDescriptions || [],
            success: false,
            filesRestored: restored,
            error: 'Server crashed after applying auto-repair — original files restored.',
          }
        : {
            roomId,
            conversationId,
            featureName,
            success: false,
            githubSynced: false,
            filesRestored: restored,
            restoreErrors,
            error: `Server crashed after applying changes — original files restored. Server is back online.`,
          };

      const postResult = await postToServer(port, reportEndpoint, failPayload);
      console.log(`[Guardian] Posted rollback to ${reportEndpoint}: HTTP ${postResult.status}`);
    } else {
      console.error('[Guardian] Server did not recover after rollback — manual intervention needed');
      // Write a result file as last resort
      try {
        fs.writeFileSync('/tmp/alden-guardian-failed.json', JSON.stringify({
          mode, roomId, conversationId, featureName, filesRestored: restored, restoreErrors,
          error: 'Server did not recover after rollback',
          timestamp: new Date().toISOString(),
        }));
      } catch {}
    }
  }

  // Clean up manifest
  try { fs.unlinkSync(MANIFEST_PATH); } catch {}
  console.log('[Guardian] Done');
  process.exit(0);
}

main().catch(err => {
  console.error('[Guardian] Fatal:', err.message);
  process.exit(1);
});
