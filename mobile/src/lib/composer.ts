/**
 * Chat composer state (C-2). A send remounts the TextInput (new `key`) instead of clearing it in place:
 * clearing a UITextView programmatically while the keyboard still holds composed/marked text let iOS
 * re-insert that word after the clear. A fresh native view starts a fresh input session.
 * Changes are tagged with the key of the input that produced them, so a late event from the old input
 * cannot refill the new, empty one.
 */
export type ComposerState = { draft: string; key: number };

export type ComposerAction = { type: 'change'; key: number; text: string } | { type: 'sent' };

export const initialComposer: ComposerState = { draft: '', key: 0 };

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  if (action.type === 'sent') return { draft: '', key: state.key + 1 };
  if (action.key !== state.key || action.text === state.draft) return state;
  return { ...state, draft: action.text };
}

export function canSendDraft(draft: string): boolean {
  return draft.trim().length > 0;
}

/** Only an input that replaces a sent one takes focus on mount; the first one waits for a tap. */
export function composerAutoFocus(state: ComposerState): boolean {
  return state.key > 0;
}
