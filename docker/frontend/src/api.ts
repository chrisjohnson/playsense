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
  classifiers: () => req('/classifiers'),
  createClassifier: (body: { name: string; query: string; field_type?: string }) =>
    req('/classifiers', { method: 'POST', body: JSON.stringify(body) }),
  updateClassifier: (id: number, body: { name?: string; query?: string; field_type?: string }) =>
    req(`/classifiers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteClassifier: (id: number) => req(`/classifiers/${id}`, { method: 'DELETE' }),
  classifierJobs: () => req('/classifier-jobs'),
  enqueueClassifierJob: (body: { classifier_id: number; playlist_id?: number }) =>
    req('/classifier-jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelClassifierJob: (id: number) => req(`/classifier-jobs/${id}/cancel`, { method: 'POST' }),
  deleteClassifierJob: (id: number) => req(`/classifier-jobs/${id}`, { method: 'DELETE' }),
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
  // AI-classifier values: { "<classifier_id>": { value, stale, reason } }
  classifications?: Record<string, { value: any; stale: boolean; reason: string }>;
};

export type Classifier = {
  id: number;
  name: string;
  query: string;
  field_type: 'boolean' | 'string' | 'number' | 'datetime' | null;
  revision: number;
  created_at: string;
  updated_at: string;
  stats?: { total: number; current: number; stale: number; unclassified: number; true_count?: number | null };
};

export type SearchResponse = {
  total: number;
  count: number;
  semantic: 'off' | 'llm' | 'keyword';
  query: string;
  tracks: Track[];
};

export type ClassifierJob = {
  id: number;
  classifier_id: number;
  classifier_name: string | null;
  playlist_id: number;
  playlist_name: string | null;
  status: 'queued' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  attempts: number;
  error: string;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  retry_after: string | null;
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
