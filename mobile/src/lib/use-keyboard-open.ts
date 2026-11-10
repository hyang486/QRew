import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/** True while the software keyboard is shown (iOS will-show/will-hide, so layout changes with the animation). */
// Android does not send keyboardWillShow/WillHide; add keyboardDidShow/DidHide when the Android build starts.
export function useKeyboardOpen() {
  const [open, setOpen] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setOpen(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}
