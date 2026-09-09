import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
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
  const [exportFormat, setExportFormat] = useState('csv');

  const load = useCallback(() => {
    api.generated()
      .then((d: GeneratedItem[]) => setItems(Array.isArray(d) ? d : []))
      .catch((e: any) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const doExport = async (g: GeneratedItem, format: string) => {
    setBusyId(g.id);
    try {
      const res = await fetch(`/api/generated/${g.id}/export?format=${encodeURIComponent(format)}`);
      if (!res.ok) {
        setError(res.status + ': ' + (await res.text()));
        return;
      }
      const disp = res.headers.get('content-disposition') || '';
      const m = disp.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : (g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.' + format);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const n = g.track_count ?? '?';
      setNotice('Exported "' + g.name + '" — ' + n + ' tracks as ' + format + '.');
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
            of your playlists — turned back into a list of tracks you can download and import into Spotify
            through a third-party transfer such as <b>TuneMyMusic</b> or <b>Soundiiz</b>. Dial in the subset
            on the Search tab, then <b>Save as generated playlist</b>. Use <b>Export</b> to download it
            below (CSV, M3U8 or TXT).</>
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
            then click <b>Save as generated playlist</b> to save it for later export.</>}
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
                  {g.track_count != null ? <Chip size="small" variant="outlined" label={g.track_count.toLocaleString() + ' tracks match'} /> : null}
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
                <Box sx={{ mt: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <TextField size="small" select value={exportFormat} disabled={busyId !== null}
                    onChange={(e) => setExportFormat(e.target.value)} sx={{ width: 110 }}>
                    <MenuItem value="csv">CSV</MenuItem>
                    <MenuItem value="m3u8">M3U8</MenuItem>
                    <MenuItem value="txt">TXT</MenuItem>
                  </TextField>
                  <Button size="small" variant="contained" startIcon={<DownloadIcon />}
                    disabled={busyId !== null} onClick={() => doExport(g, exportFormat)}>
                    Export
                  </Button>
                  <Box sx={{ flexGrow: 1 }} />
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
    </Box>
  );
}
