// A successful chat send, told to the recap triggers so the open-room message count is saved (no React Native).
type Listener = (roomId: string) => void;
const listeners = new Set<Listener>();

export function noteMessageSent(roomId: string): void {
  for (const l of listeners) l(roomId);
}

export function onMessageSent(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
