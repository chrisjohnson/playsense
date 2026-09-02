import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VisibilityIcon from '@mui/icons-material/Visibility';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import { api } from '../api';
import { PageHeader, EmptyState } from '../components';

interface Props { authed: boolean; }

type GeneratedItem = {
  id: number;
  name: string;
  description: string;
  source_playlist_id: number;
  source_playlist_name: string;
  search_spec: any;
  preview_mode: boolean;
  sync_mode: 'once' | 'ongoing';
  spotify_playlist_id: string | null;
  spotify_external_url: string;
  last_synced_at: string | null;
  last_sync_status: string;
  created_at: string;
  track_count: number | null;
};

type Diff = {
  dry_run: boolean;
  applied?: boolean;
  will_create: boolean;
  total_desired: number;
  added: number;
  removed: number;
  added_tracks: { uri: string; name: string }[];
  removed_tracks: { uri: string }[];
  preview_mode: boolean;
  spotify_playlist_id: string | null;
  spotify_external_url: string;
};

const shortUri = (u: string) => (u.length > 44 ? '…' + u.slice(-30) : u);

// deterministic pastel hue per generated playlist
function playlistHue(id: number): string {
  const h = (Math.abs(id) * 47 + 120) % 360;
  return 'hsl(' + h + ' 52% 46%)';
}

export default function Generate({ authed }: Props) {
  const [items, setItems] = useState<GeneratedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [diffFor, setDiffFor] = useState<{ name: string; diff: Diff } | null>(null);

  const load = useCallback(() => {
    api.generated()
      .then((d: GeneratedItem[]) => setItems(Array.isArray(d) ? d : []))
      .catch((e: any) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const togglePreview = async (g: GeneratedItem, v: boolean) => {
    setBusyId(g.id);
    try { await api.generatedUpdate(g.id, { preview_mode: v }); load(); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  };

  const setSyncMode = async (g: GeneratedItem, mode: string) => {
    setBusyId(g.id);
    try { await api.generatedUpdate(g.id, { sync_mode: mode }); load(); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  };

  const doSync = async (g: GeneratedItem, dry: boolean) => {
    if (!authed) { setError('Connect to Spotify first.'); return; }
    setBusyId(g.id); setError('');
    try {
      const d: Diff = await api.generatedSync(g.id, dry);
      setDiffFor({ name: g.name, diff: d });
      setNotice(d.applied
        ? 'Synced "' + g.name + '": +' + d.added + ' / -' + d.removed + '.'
        : 'Previewed "' + g.name + '": +' + d.added + ' / -' + d.removed + ' (nothing written' + (d.preview_mode ? ' — preview mode is on' : '') + ').');
      load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  };

  const doReread = async (g: GeneratedItem) => {
    setBusyId(g.id); setError('');
    try {
      const r: any = await api.generatedReread(g.id);
      setNotice('Re-read "' + g.name + '" from Spotify: ' + r.tracks_in_spotify + ' tracks now form the sync baseline.');
      load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  };

  const doDelete = async (g: GeneratedItem) => {
    if (!window.confirm('Delete generated playlist "' + g.name + '"? The Spotify playlist itself is kept.')) return;
    setBusyId(g.id);
    try { await api.generatedDelete(g.id); load(); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  };

  const specSummary = (spec: any) => {
    const parts: string[] = [];
    if (spec?.q) parts.push('text: "' + spec.q + '"');
    if (spec?.artist) parts.push('artist ~ ' + spec.artist);
    if (spec?.album) parts.push('album ~ ' + spec.album);
    if (spec?.title) parts.push('title ~ ' + spec.title);
    if (spec?.min_year || spec?.max_year) parts.push('year ' + (spec.min_year || '…') + '–' + (spec.max_year || '…'));
    if (spec?.min_dur_s || spec?.max_dur_s) parts.push('dur ' + (spec.min_dur_s || 0) + '–' + (spec.max_dur_s || '…') + 's');
    const cf = spec?.classifier_filters || {};
    for (const [cid, v] of Object.entries<any>(cf)) {
      parts.push('AI#' + cid + '=' + (typeof v === 'object' ? (v?.min ?? '…') + '–' + (v?.max ?? '…') : JSON.stringify(v)));
    }
    return parts.length ? parts.join(', ') : 'all tracks (no filters)';
  };

  return (
    <Box>
      <PageHeader
        icon={<AutoAwesomeIcon />}
        title="Generated playlists"
        intro={(
          <>
            A generated playlist is a saved search — fuzzy text, metadata and AI-classifier filters on one
            of your playlists — kept in sync with a Spotify playlist. Dial in the subset on the Search tab,
            then <b>Save as generated playlist</b>. With preview mode on (the default), syncing only shows
            a diff of what would change; turn it off to actually write to Spotify.
          </>
        )}
        actions={<Button startIcon={<RefreshIcon />} onClick={load} size="small">Refresh</Button>}
      />

      {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert> : null}

      {loading && items.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<AutoAwesomeIcon sx={{ fontSize: 44 }} />}
          title="No generated playlists yet"
          hint={<>Dial in a subset on the Search tab (text, year, duration, AI classifications…),
            then click <b>Save as generated playlist</b> to turn it into a synced Spotify playlist.</>}
        />
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {items.map((g) => (
            <Card key={g.id} sx={{
              transition: 'transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
              '&:hover': { transform: 'translateY(-2px)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)', borderColor: 'rgba(255,255,255,0.18)' },
            }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
                  <Box sx={{
                    width: 38, height: 38, borderRadius: 2, flexShrink: 0,
                    background: 'linear-gradient(135deg, ' + playlistHue(g.id) + ' 0%, rgba(0,0,0,0.55) 130%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
                  }}>
                    <AutoAwesomeIcon sx={{ color: 'rgba(255,255,255,0.92)', fontSize: 19 }} />
                  </Box>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>{g.name}</Typography>
                  {g.preview_mode ? <Chip size="small" variant="outlined" color="warning" label="preview mode" /> : <Chip size="small" color="success" label="live" />}
                  <Chip size="small" variant="outlined" label={g.sync_mode === 'ongoing' ? 'auto-sync ~30min' : 'manual sync'} />
                  {g.spotify_playlist_id ? null : <Chip size="small" variant="outlined" label="not synced yet" sx={{ opacity: 0.7 }} />}
                  {g.track_count != null ? <Chip size="small" variant="outlined" label={g.track_count.toLocaleString() + ' tracks match now'} /> : null}
                  <Box sx={{ flexGrow: 1 }} />
                  {g.spotify_external_url ? (
                    <Link href={g.spotify_external_url} target="_blank" rel="noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      <OpenInNewIcon fontSize="small" /> Spotify
                    </Link>
                  ) : null}
                </Box>
                {g.description ? <Typography variant="body2" color="text.secondary">{g.description}</Typography> : null}
                <Typography variant="caption" color="text.secondary">
                  on {g.source_playlist_name} — {specSummary(g.search_spec)}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  {g.last_synced_at ? 'Last action: ' + new Date(g.last_synced_at).toLocaleString() : 'Never synced'}
                  {g.last_sync_status ? ' — ' + g.last_sync_status : ''}
                </Typography>

                <Box sx={{ mt: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <FormControlLabel
                    control={<Switch size="small" checked={g.preview_mode} disabled={busyId === g.id}
                      onChange={(e) => togglePreview(g, e.target.checked)} />}
                    label={<Typography variant="body2">Preview mode</Typography>}
                  />
                  <TextField size="small" select value={g.sync_mode} disabled={busyId === g.id}
                    onChange={(e) => setSyncMode(g, e.target.value)} sx={{ width: 200 }}>
                    <MenuItem value="once">Manual sync</MenuItem>
                    <MenuItem value="ongoing">Ongoing (~30 min)</MenuItem>
                  </TextField>
                  <Box sx={{ flexGrow: 1 }} />
                  <Button size="small" startIcon={<VisibilityIcon />} disabled={busyId === g.id} onClick={() => doSync(g, true)}>
                    Preview changes
                  </Button>
                  <Button size="small" variant="contained" startIcon={<PlayArrowIcon />}
                    disabled={busyId === g.id || g.preview_mode} onClick={() => doSync(g, false)}>
                    Sync now
                  </Button>
                  {g.spotify_playlist_id ? (
                    <Button size="small" startIcon={<RefreshIcon />} disabled={busyId === g.id} onClick={() => doReread(g)}>
                      Re-read from Spotify
                    </Button>
                  ) : null}
                  <Button size="small" color="error" startIcon={<DeleteIcon />} disabled={busyId === g.id} onClick={() => doDelete(g)}>
                    Delete
                  </Button>
                </Box>
                {busyId === g.id ? (
                  <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={14} />
                    <Typography variant="caption" color="text.secondary">working…</Typography>
                  </Box>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      {diffFor ? (
        <Dialog open onClose={() => setDiffFor(null)} fullWidth maxWidth="md">
          <DialogTitle>
            {diffFor.diff.applied ? 'Synced' : 'Preview'} — {diffFor.name}
            {diffFor.diff.will_create ? ' (creates a new Spotify playlist)' : ''}
          </DialogTitle>
          <DialogContent>
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {diffFor.diff.applied ? 'Applied' : 'Would apply'}: +{diffFor.diff.added} added / -{diffFor.diff.removed} removed
                {' · '}the search matches {diffFor.diff.total_desired} tracks.
                {!diffFor.diff.applied && diffFor.diff.preview_mode ? ' Preview mode is on — nothing was written to Spotify.' : ''}
              </Typography>
              {diffFor.diff.added > 0 ? (
                <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 2, border: '1px solid rgba(30,215,96,0.28)', bgcolor: 'rgba(30,215,96,0.06)' }}>
                  <Typography variant="subtitle2" color="success.main" sx={{ mb: 0.75 }}>+ Adding ({diffFor.diff.added})</Typography>
                  {diffFor.diff.added_tracks.map((t) => (
                    <Typography key={t.uri} variant="body2" noWrap>{t.name || shortUri(t.uri)}</Typography>
                  ))}
                  {diffFor.diff.added > diffFor.diff.added_tracks.length ? (
                    <Typography variant="caption" color="text.secondary">…and {diffFor.diff.added - diffFor.diff.added_tracks.length} more</Typography>
                  ) : null}
                </Box>
              ) : null}
              {diffFor.diff.removed > 0 ? (
                <Box sx={{ p: 1.25, borderRadius: 2, border: '1px solid rgba(241,94,108,0.28)', bgcolor: 'rgba(241,94,108,0.06)' }}>
                  <Typography variant="subtitle2" color="error.main" sx={{ mb: 0.75 }}>- Removing ({diffFor.diff.removed})</Typography>
                  {diffFor.diff.removed_tracks.map((t) => (
                    <Typography key={t.uri} variant="body2" noWrap>{shortUri(t.uri)}</Typography>
                  ))}
                  {diffFor.diff.removed > diffFor.diff.removed_tracks.length ? (
                    <Typography variant="caption" color="text.secondary">…and {diffFor.diff.removed - diffFor.diff.removed_tracks.length} more</Typography>
                  ) : null}
                </Box>
              ) : null}
              {diffFor.diff.added === 0 && diffFor.diff.removed === 0 ? (
                <Typography variant="body2" color="text.secondary">Already in sync — nothing to change.</Typography>
              ) : null}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDiffFor(null)}>Close</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </Box>
  );
}
