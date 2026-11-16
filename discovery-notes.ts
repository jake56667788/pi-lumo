/**
 * Explanations collected while looking for a browser session, for the cases
 * where a browser clearly has a profile but its Lumo session can't be read
 * (for example Brave on Windows, whose cookies only Brave can decrypt).
 * Discovery never throws; these notes are how the reason reaches the user.
 */
const notes = new Set<string>();

export function addDiscoveryNote(note: string): void {
  notes.add(note);
}

/** Returns the notes collected so far and clears them. */
export function takeDiscoveryNotes(): string[] {
  const collected = [...notes];
  notes.clear();
  return collected;
}
