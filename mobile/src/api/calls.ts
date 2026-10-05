import {http} from './client';
import type {CallHistoryItem, IceServer} from './types';

export const callsApi = {
  iceServers: async (): Promise<IceServer[]> => {
    const {data} = await http.get<{iceServers: IceServer[]}>('/calls/ice-servers');
    return data.iceServers;
  },

  history: async (limit = 50): Promise<CallHistoryItem[]> => {
    const {data} = await http.get<CallHistoryItem[]>('/calls/history', {
      params: {limit},
    });
    return data;
  },
};
