import { useState, useEffect } from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';

import { api, PlaylistItem } from '../api';

interface Props { authed: boolean; }

export default function Generate({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('My Generated Playlist');
  const [desc, setDesc] = useState('');
  const [q, setQ] = useState('');
  const [pid, setPid] = useState<number | ''>('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [title, setTitle] = useState('');
  const [minYear, setMinYear] = useState('');
  const [maxYear, setMaxYear] = useState('');
  const [language, setLanguage] = useState('');
  const [push, setPush] = useState(true);

  useEffect(() => {
    api.playlists()
      .then((d: PlaylistItem[]) => {
        const list = Array.isArray(d) ? d : [];
        setPlaylists(list);
        setPid((cur) => (cur === '' && list.length ? list[0].id : cur));
      })
      .catch(() => {});
  }, []);

  const run = async () => {
    if (!authed) { alert('Connect to Spotify first.'); return; }
    if (!pid) { alert('Pick a source playlist.'); return; }
    setBusy(true); setResult(null);
    try {
      const searchBody: any = {
        playlist_id: Number(pid),
        q: q.trim() || null,
        title: title.trim() || null,
        artist: artist.trim() || null,
        album: album.trim() || null,
        min_year: minYear ? Number(minYear) : null,
        max_year: maxYear ? Number(maxYear) : null,
        language: language || null,
        use_semantic: true,
        limit: 100,
      };
      const r = await api.generate({ name, description: desc, search: searchBody, push_to_spotify: push });
      setResult(r);
    } catch (e: any) {
      setResult({ push_error: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Generate & push playlist</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Search within a source playlist, then create a new playlist from the matches.
        With push enabled, the result is sent to your Spotify account.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <TextField
            select fullWidth size="small" label="Source playlist" value={pid}
            onChange={(e) => setPid(Number(e.target.value))}
            InputProps={{ 'aria-label': 'source playlist' }}
          >
            {playlists.map((p) => (
              <MenuItem key={p.id} value={p.id}>{p.name} ({p.track_count})</MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth size="small" label="New playlist name" value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Grid>
        <Grid item xs={12}>
          <TextField
            fullWidth size="small" label="Description (optional)" value={desc}
            onChange={(e) => setDesc(e.target.value)} multiline minRows={2}
          />
        </Grid>
        <Grid item xs={12}>
          <TextField
            fullWidth size="small" label="Free-text query (semantic, interpreted by the LLM — optional)" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder='e.g. “mariachi music” or “mexican and mexican-inspired”'
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField size="small" label="Artist" value={artist} fullWidth
            onChange={(e) => setArtist(e.target.value)} inputProps={{ 'aria-label': 'artist' }} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField size="small" label="Album" value={album} fullWidth
            onChange={(e) => setAlbum(e.target.value)} inputProps={{ 'aria-label': 'album' }} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField size="small" label="Title" value={title} fullWidth
            onChange={(e) => setTitle(e.target.value)} inputProps={{ 'aria-label': 'title' }} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
            <TextField size="small" label="Year" type="number" value={minYear} fullWidth
              onChange={(e) => setMinYear(e.target.value)} inputProps={{ 'aria-label': 'min year' }} />
            <Typography color="text.secondary">–</Typography>
            <TextField size="small" label="Year" type="number" value={maxYear} fullWidth
              onChange={(e) => setMaxYear(e.target.value)} inputProps={{ 'aria-label': 'max year' }} />
          </Box>
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField size="small" select label="Language" value={language} fullWidth
            onChange={(e) => setLanguage(e.target.value)}>
            <MenuItem value="">Any</MenuItem>
            <MenuItem value="es">Spanish</MenuItem>
          </TextField>
        </Grid>
        <Grid item xs={6} sm={3}>
          <FormControlLabel
            control={<Checkbox checked={push} onChange={(e) => setPush(e.target.checked)} />}
            label="Push to Spotify"
          />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" onClick={run} disabled={busy || !pid}>
            {busy ? 'Generating…' : push ? 'Generate & push to Spotify' : 'Generate (local only)'}
          </Button>
        </Grid>
      </Grid>
      {busy ? <LinearProgress sx={{ mt: 2 }} /> : null}
      {result ? (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6">Result</Typography>
          <Card variant="outlined" sx={{ mt: 1 }}>
            <CardContent>
              {result.matched_count != null ? (
                <Typography variant="body2">Matched: {result.matched_count} tracks</Typography>
              ) : null}
              {result.spotify_playlist_id ? (
                <Typography variant="body2">
                  Pushed to Spotify:{' '}
                  <Link href={result.spotify_external_url} target="_blank" rel="noreferrer">
                    {result.spotify_external_url}
                  </Link>
                </Typography>
              ) : null}
              {result.export_path ? (
                <Typography variant="body2">Exported to: {result.export_path}</Typography>
              ) : null}
              {result.push_error ? (
                <Typography variant="body2" color="error">{result.push_error}</Typography>
              ) : null}
            </CardContent>
          </Card>
        </Box>
      ) : null}
    </Box>
  );
}
