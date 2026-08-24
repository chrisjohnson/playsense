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

import { api, PlaylistItem } from '../api';

interface Props { authed: boolean; }

export default function Generate({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('My Generated Playlist');
  const [desc, setDesc] = useState('');
  const [q, setQ] = useState('');
  const [pid, setPid] = useState(0);
  const [lang, setLang] = useState('es');
  const [regions, setRegions] = useState('Mexico');
  const [isMexican, setIsMexican] = useState(true);
  const [isLatin, setIsLatin] = useState(true);
  const [useSemantic, setUseSemantic] = useState(true);
  const [push, setPush] = useState(true);

  useEffect(() => {
    api.playlists().then((d) => setPlaylists(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const run = async () => {
    if (!authed) { alert('Connect to Spotify first.'); return; }
    if (!pid) { alert('Pick a source playlist.'); return; }
    setBusy(true); setResult(null);
    try {
      const searchBody: any = {
        q, languages: lang ? [lang] : [],
        regions: regions ? regions.split(',').map((s) => s.trim()).filter(Boolean) : [],
        is_mexican: isMexican, is_latin_american: isLatin,
        use_semantic: useSemantic, limit: 100,
      };
      if (pid) searchBody.playlist_id = pid;
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
        Search within a source playlist, then generate a new one from the matches.
        With push enabled, the result is sent back to your Spotify account.
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <TextField select size="small" label="Source playlist" value={pid}
            onChange={(e) => setPid(Number(e.target.value))} fullWidth>
            {playlists.map((p) => <MenuItem key={p.id} value={p.id}>{p.name} ({p.track_count})</MenuItem>)}
          </TextField>
        </Grid>
        <Grid item xs={12}>
          <TextField fullWidth size="small" label="Name" value={name}
            onChange={(e) => setName(e.target.value)} />
        </Grid>
        <Grid item xs={12}>
          <TextField fullWidth size="small" label="Description" value={desc}
            onChange={(e) => setDesc(e.target.value)} multiline minRows={2} />
        </Grid>
        <Grid item xs={12}>
          <TextField fullWidth size="small" label="Free-text semantic query" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder="e.g. summer party vibes" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField select size="small" label="Language" value={lang}
            onChange={(e) => setLang(e.target.value)} fullWidth>
            <MenuItem value="es">Spanish</MenuItem>
            <MenuItem value="en">English</MenuItem>
            <MenuItem value="">Any</MenuItem>
          </TextField>
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField size="small" label="Regions (comma-separated)" value={regions}
            onChange={(e) => setRegions(e.target.value)} fullWidth />
        </Grid>
        <Grid item xs={6} sm={3}>
          <FormControlLabel control={<Checkbox checked={isMexican} onChange={(e) => setIsMexican(e.target.checked)} />}
            label="Mexican only" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <FormControlLabel control={<Checkbox checked={isLatin} onChange={(e) => setIsLatin(e.target.checked)} />}
            label="Latin American only" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <FormControlLabel control={<Checkbox checked={useSemantic} onChange={(e) => setUseSemantic(e.target.checked)} />}
            label="Use semantic (LLM) classification" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <FormControlLabel control={<Checkbox checked={push} onChange={(e) => setPush(e.target.checked)} />}
            label="Push to Spotify" />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" color="primary" onClick={run} disabled={busy || !pid}>
            {busy ? 'Generating...' : push ? 'Generate & push to Spotify' : 'Search & preview'}
          </Button>
        </Grid>
      </Grid>
      {busy ? <LinearProgress sx={{ mt: 2 }} /> : null}
      {result ? (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6">Result</Typography>
          <Card variant="outlined" sx={{ mt: 1 }}>
            <CardContent>
              <Typography variant="body2">Matched: {result.matched_count}</Typography>
              {result.spotify_playlist_id ? (
                <Typography variant="body2">Pushed to Spotify: {result.spotify_external_url}</Typography>
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
