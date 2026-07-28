/**
 * Handing a generated image from the Gallery to the Console as a reference
 * input: the Gallery stashes its media URL, the Console picks it up on mount
 * and switches to reference mode. sessionStorage because it survives the
 * navigation but not the session.
 */

export const PENDING_REF_KEY = "imageCreate:pendingRef";

export function stashPendingRef(mediaUrl: string): void {
  sessionStorage.setItem(PENDING_REF_KEY, mediaUrl);
}

/** Read and clear the pending reference, if any. */
export function takePendingRef(): string | null {
  const url = sessionStorage.getItem(PENDING_REF_KEY);
  if (url) sessionStorage.removeItem(PENDING_REF_KEY);
  return url;
}
