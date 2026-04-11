import { logger } from './logger.js';

export interface DraftStream {
  /** Send or edit the preview with accumulated text. Throttled. */
  update(text: string): void;
  /** Finalize the preview. Returns false if text exceeded maxLength (caller should fall back to sendMessage). */
  finish(text: string): Promise<boolean>;
  /** Delete the preview message (e.g., if agent produced no output). */
  cancel(): Promise<void>;
}

export interface DraftStreamOpts {
  /** Send initial message, return platform message ID. */
  sendMessage(text: string): Promise<number | undefined>;
  /** Edit an existing message by ID. */
  editMessage(messageId: number, text: string): Promise<void>;
  /** Delete a message by ID. */
  deleteMessage(messageId: number): Promise<void>;
  /** Minimum ms between edits. Default: 1000 */
  throttleMs?: number;
  /** Max message length before giving up on streaming. Default: 4096 */
  maxLength?: number;
  /** Min chars before sending first message (avoids noisy push notifs). Default: 30 */
  minInitialChars?: number;
}

export function createDraftStream(opts: DraftStreamOpts): DraftStream {
  const throttleMs = opts.throttleMs ?? 1000;
  const maxLength = opts.maxLength ?? 4096;
  const minInitialChars = opts.minInitialChars ?? 30;

  let messageId: number | undefined;
  let lastSentText = '';
  let pendingText = '';
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  async function doSendOrEdit(text: string): Promise<void> {
    if (text === lastSentText) return;
    try {
      if (!messageId) {
        messageId = await opts.sendMessage(text);
      } else {
        await opts.editMessage(messageId, text);
      }
      lastSentText = text;
    } catch (err) {
      logger.debug({ err }, 'Draft stream send/edit failed');
    }
  }

  function flush(): void {
    if (!pendingText || pendingText === lastSentText) return;
    const text = pendingText;
    inFlight = inFlight.then(() => doSendOrEdit(text));
  }

  return {
    update(text: string): void {
      if (stopped) return;
      pendingText = text;

      // Wait for minimum content before first message
      if (!messageId && text.length < minInitialChars) return;

      // Throttle edits
      if (throttleTimer) return;
      flush();
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (!stopped) flush();
      }, throttleMs);
    },

    async finish(text: string): Promise<boolean> {
      stopped = true;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }

      if (text.length > maxLength) {
        if (messageId) {
          try {
            await opts.deleteMessage(messageId);
          } catch {
            // ignore — best effort cleanup
          }
        }
        return false;
      }

      pendingText = text;
      flush();
      await inFlight;
      return true;
    },

    async cancel(): Promise<void> {
      stopped = true;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      await inFlight;
      if (messageId) {
        try {
          await opts.deleteMessage(messageId);
        } catch {
          // ignore
        }
      }
    },
  };
}
