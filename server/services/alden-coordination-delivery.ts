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

export function aldenCoordinationDelivery(recipient: string, mirror: NotesMirrorState): AldenCoordinationDelivery {
  const base = `Recorded for ${recipient}'s coordination inbox; ${recipient} reads it there.`;
  switch (mirror) {
    case 'pending':
      return { recipient, inbox: 'recorded', notesMirror: 'pending', message: `${base} A notes-inbox copy for ${recipient} is also queued.` };
    case 'delivered':
      return { recipient, inbox: 'recorded', notesMirror: 'delivered', message: `${base} A notes-inbox copy for ${recipient} was also delivered.` };
    case 'failed':
      return { recipient, inbox: 'recorded', notesMirror: 'failed', message: `${base} The separate notes-inbox copy for ${recipient} failed; the coordination inbox entry still stands.` };
    default:
      return { recipient, inbox: 'recorded', notesMirror: 'none', message: `${base} No separate notes-inbox copy is made for this event, which is expected.` };
  }
}
