/**
 * Every DOM hook in one place. ChatGPT's UI changes often — if something breaks,
 * this is the file to update. Each entry is a list of fallbacks (joined into one CSS selector).
 *
 * Only *sending* goes through the DOM. Status and image downloads use ChatGPT's own
 * JSON endpoints (see chatgpt.ts), which change far less often.
 */
export const SEL = {
  // 2026 "octane" composer uses textarea[name=prompt]; the classic React app uses #prompt-textarea (ProseMirror).
  composer: [
    "#prompt-textarea",
    'textarea[name="prompt"]',
    "[data-composer-editor-host] textarea",
    '[data-composer-editor-host] [contenteditable="true"]',
    'textarea[aria-label="Chat with ChatGPT"]',
    'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    "#composer-submit-button:not([data-stop-generating])",
    "button[data-composer-submit]:not([data-stop-generating])",
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
  ],
  // In the octane UI the submit button turns into the stop button (gains data-stop-generating).
  stopButton: [
    'button[data-testid="stop-button"]',
    "button[data-stop-generating]",
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
  ],
  fileInput: [
    "#octane-mobile-composer-files-input",
    'input[type="file"][accept*="image"]:not([capture])',
    'input[type="file"]:not([capture])',
    'input[type="file"]',
  ],
  userMessage: ['[data-message-author-role="user"]', '[data-turn="user"]', '[data-role="user"]'],
  generatedImage: [
    'img[alt*="Generated image" i]',
    'img[src*="/backend-api/estuary/content"]',
    'img[src*="/backend-api/files/"]',
    'img[src*="oaiusercontent.com"]',
  ],
};

export const css = (list: string[]): string => list.join(", ");

/** Text ChatGPT shows while an image is still rendering. */
export const IMAGE_PENDING_TEXT = /creating image|generating image|getting started|refining details|adding details|lots of details|almost done|image creation in progress/i;
