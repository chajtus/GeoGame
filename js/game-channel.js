/**
 * Creates a Supabase Realtime broadcast channel for the game session.
 * Both host and player use this same channel.
 * @param {object} sb - Supabase client
 * @param {string} sessionId
 */
export function createChannel(sb, sessionId) {
  return sb.channel(`game:${sessionId}`, {
    config: { broadcast: { self: false } },
  });
}

/**
 * Sends a broadcast event on the channel.
 * @param {object} channel - Supabase channel (must be subscribed)
 * @param {string} event - event name e.g. 'round_start'
 * @param {object} payload - data to send
 */
export async function broadcast(channel, event, payload = {}) {
  await channel.send({ type: 'broadcast', event, payload });
}
