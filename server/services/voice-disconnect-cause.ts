/**
 * Why a voice connection ended (F3, live-test-1 debrief; design note 135fe51b rev 2).
 * Recorded as a client_socket_disconnected pipeline event so a mid-session drop has a
 * cause. Reasons are bounded and control characters stripped; they are never payloads.
 */
export interface DisconnectCause {
  initiator: 'server' | 'client_or_network' | 'unknown';
  serverCode: number | null;
  serverReason: string | null;
  socketReason: string | null;
}

const bounded = (value: string | null) => (value == null ? null : value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200));

/** F3: name the side that closed a voice connection. Unknown stays explicit. */
export function describeDisconnect(
  serverClose: { code: number | null; reason: string | null } | null,
  socketReason: string | null,
): DisconnectCause {
  return {
    initiator: serverClose ? 'server' : socketReason ? 'client_or_network' : 'unknown',
    serverCode: serverClose?.code ?? null,
    serverReason: bounded(serverClose?.reason ?? null),
    socketReason: bounded(socketReason),
  };
}
