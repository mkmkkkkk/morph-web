/**
 * Bridge module — re-exports useConnection from the active provider.
 * Consumers import from here instead of directly from ConnectionContext or DirectConnectionContext.
 */

import { getSetting } from './settings';

const mode = getSetting('connectionMode');

// Dynamic require based on connection mode
const provider = mode === 'direct'
  ? require('./DirectConnectionContext')
  : require('./ConnectionContext');

export const useConnection = provider.useConnection;
