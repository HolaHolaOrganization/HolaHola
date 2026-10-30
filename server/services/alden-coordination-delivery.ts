/**
 * What Alden's coordination tools report about delivery.
 *
 * A recipient-addressed coordination event IS the recipient's inbox entry: the
 * recipient reads it from their coordination inbox. The ledger's deliveryState
 * describes something narrower, the optional agent_notes mirror, which is only
 * created for some events and actors (never for plain comments). Reporting it
 * raw as "deliveryState: not_applicable" read as a failed delivery after every
 * reply (2026-10-29), so the two are reported separately.
 */
export type NotesMirrorState = 'not_applicable' | 'pending' | 'delivered' | 'failed';

export interface AldenCoordinationDelivery {
  recipient: string;
  /** The event is recorded and addressed to the recipient's coordination inbox. */
  inbox: 'recorded';
  /** The separate agent_notes copy; 'none' when none is made for this event. */
  notesMirror: 'none' | 'pending' | 'delivered' | 'failed';
  message: string;
}

/**
 * Alden's own wording for each notes-copy state (coordination thread 48d10847,
 * seq 13 and seq 27), copied verbatim. `<recipient>` is replaced with the
 * recipient's actor id. Do not reword without his review.
 */
export const ALDEN_DELIVERY_WORDING = {
  none: "Recorded in <recipient>'s coordination inbox. Comments don't get a separate notes copy; that's expected.",
  pending: "Recorded in <recipient>'s coordination inbox. A notes copy is queued and hasn't been sent yet; the inbox record already counts as delivered.",
  delivered: "Recorded in <recipient>'s coordination inbox, and a copy was sent to their notes inbox.",
  failed: "Recorded in <recipient>'s coordination inbox. The notes copy failed. The ledger record is intact.",
} as const;

export function aldenCoordinationDelivery(recipient: string, mirror: NotesMirrorState): AldenCoordinationDelivery {
  const notesMirror = mirror === 'not_applicable' ? 'none' : mirror;
  const message = ALDEN_DELIVERY_WORDING[notesMirror].split('<recipient>').join(recipient);
  return { recipient, inbox: 'recorded', notesMirror, message };
}
