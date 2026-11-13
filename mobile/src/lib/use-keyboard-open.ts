import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/** True while the software keyboard is shown (iOS will-show/will-hide, so layout changes with the animation). */
// Android does not send keyboardWillShow/WillHide; add keyboardDidShow/DidHide when the Android build starts.
export function useKeyboardOpen() {
  const [open, setOpen] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setOpen(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setOpen(false));
    // A screen mounted while the keyboard is being dismissed (router.replace after a save) misses WillHide, which
    // fired before this effect subscribed. DidHide corrects `open` then; the re-read on the next frame covers a DidHide
    // that also fired before the subscription (Keyboard.isVisible() follows DidShow/DidHide).
    const didHide = Keyboard.addListener('keyboardDidHide', () => setOpen(false));
    const frame = requestAnimationFrame(() => setOpen(Keyboard.isVisible()));
    return () => {
      show.remove();
      hide.remove();
      didHide.remove();
      cancelAnimationFrame(frame);
    };
  }, []);
  return open;
}
