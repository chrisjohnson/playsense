const BASE = '/api';

async function req(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export const api = {
  health: () => req('/health'),
  authStatus: () => req('/auth/status'),
  authorize: () => req('/oauth/authorize', { method: 'GET' }),
  authorizeRaw: () => fetch('/api/oauth/authorize', { method: 'GET' }).then((r) => r.json()),
  playlists: () => req('/playlists'),
  download: (id: number) => req(`/playlists/${id}/download`, { method: 'POST' }),
  tracks: (id: number) => req(`/playlists/${id}/tracks`),
  classify: (id: number, name: string, useSemantic: boolean) =>
    req(`/playlists/${id}/classify`, { method: 'POST', body: JSON.stringify({ name, use_semantic: useSemantic }) }),
  search: (q: any) => req('/search', { method: 'POST', body: JSON.stringify(q) }),
  generate: (body: any) => req('/generate', { method: 'POST', body: JSON.stringify(body) }),
  runs: () => req('/runs'),
  saveCredentials: (client_id: string, client_secret: string) =>
    req('/spotify/credentials', { method: 'POST', body: JSON.stringify({ client_id, client_secret }) }),
  getCredentials: () => req('/spotify/credentials'),
  sync: () => req('/playlists/sync', { method: 'POST' }),
};

export type Track = {
  id: number;
  spotify_track_id: string;
  name: string;
  artists: { id?: string; name: string }[];
  album_name: string;
  release_date: string;
  duration_ms?: number;
  uri: string;
  external_url?: string;
  is_mexican?: boolean;
  is_latin_american?: boolean;
  region?: string;
  language?: string;
  genres?: any[];
  classification_strategy?: string;
  match_reason?: string;
};

export type SearchResponse = {
  total: number;
  count: number;
  semantic: 'off' | 'llm' | 'keyword';
  query: string;
  tracks: Track[];
};

export type PlaylistItem = {
  id: number;
  spotify_playlist_id: string;
  name: string;
  description: string;
  owner_id: string;
  is_public: boolean;
  external_url: string;
  fetched_at: string;
  track_count: number;
  download_state?: 'idle' | 'queued' | 'downloading' | 'waiting_quota' | 'done' | 'error';
  download_saved?: number;
  download_total?: number;
  download_error?: string;
  download_updated_at?: string;
};
