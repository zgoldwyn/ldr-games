/** Metro-only replacement for the Node `ws` package used as the SDK fallback. */
const NativeWebSocket = globalThis.WebSocket;

export { NativeWebSocket as WebSocket };
export default NativeWebSocket;
