import { useState, useEffect } from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TablePagination from '@mui/material/TablePagination';
import TableContainer from '@mui/material/TableContainer';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import CircularProgress from '@mui/material/CircularProgress';

import { api, PlaylistItem, Track } from '../api';

interface Props { initialId?: number | null; onPick?: (id: number) => void; }

export default function Tracks({ initialId, onPick }: Props) {
  const [id, setId] = useState<number | null>(initialId ?? null);
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(25);
  const [runId, setRunId] = useState<number | null>(null);

  useEffect(() => {
    api.playlists()
      .then((d: PlaylistItem[]) => setPlaylists(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  useEffect(() => { setId(initialId ?? null); }, [initialId]);

  const load = async () => {
    if (!id) { setTracks([]); setLoading(false); return; }
    setLoading(true);
    try {
      const data = await api.tracks(Number(id));
      setTracks(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setTracks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const pick = (v: number | string) => {
    const n = Number(v);
    setId(n || null);
    if (n) onPick?.(n);
    setPage(0);
  };

  const runClassify = async () => {
    if (!id) return;
    try {
      const r = await api.classify(Number(id), 'Run ' + new Date().toISOString().slice(0, 10), true);
      setRunId(r.id);
      await load();
    } catch (e: any) {
      alert('Classification failed: ' + (e.message || e));
    }
  };

  const current = playlists.find((p) => p.id === id);
  const mexican = tracks.filter((t) => t.is_mexican).length;
  const latin = tracks.filter((t) => t.is_latin_american).length;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Tracks{current ? ` — ${current.name}` : ''}
        </Typography>
        <TextField
          select size="small" label="Playlist" value={id ?? ''}
          onChange={(e) => pick(e.target.value)} sx={{ minWidth: 280 }}
          InputProps={{ 'aria-label': 'tracks playlist' }}
        >
          <MenuItem value="" disabled>Select a playlist…</MenuItem>
          {playlists.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.name} ({p.track_count})</MenuItem>
          ))}
        </TextField>
        {id ? <Button onClick={runClassify}>Reclassify</Button> : null}
      </Box>
      {!id ? (
        <Typography color="text.secondary">Pick a playlist to view its tracks.</Typography>
      ) : loading ? (
        <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>
      ) : (
        <Card variant="outlined">
          <CardContent>
            <Box sx={{ mb: 1 }}>
              <Chip size="small" label={`${tracks.length} tracks`} sx={{ mr: 1 }} />
              <Chip size="small" label={`${mexican} Mexican`} color="success" sx={{ mr: 1 }} />
              <Chip size="small" label={`${latin} Lat-Am`} sx={{ mr: 1 }} />
              {runId ? <Chip size="small" label={`last run id ${runId}`} variant="outlined" /> : null}
            </Box>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Artists</TableCell>
                    <TableCell>Album</TableCell>
                    <TableCell>Year</TableCell>
                    <TableCell>Region</TableCell>
                    <TableCell>Lang</TableCell>
                    <TableCell>Strategy</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tracks.slice(page * rows, page * rows + rows).map((t) => (
                    <TableRow key={t.id} hover>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>{(t.artists || []).map((a: any) => a.name).join(', ')}</TableCell>
                      <TableCell>{t.album_name}</TableCell>
                      <TableCell>{(t.release_date || '').slice(0, 4)}</TableCell>
                      <TableCell>{t.region || '—'}</TableCell>
                      <TableCell>{t.language || '—'}</TableCell>
                      <TableCell><Chip size="small" label={t.classification_strategy || '—'} variant="outlined" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TablePagination
              component="div" count={tracks.length} page={page} onPageChange={(_, p) => setPage(p)}
              rowsPerPage={rows} onRowsPerPageChange={(e) => { setRows(Number(e.target.value)); setPage(0); }}
            />
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
