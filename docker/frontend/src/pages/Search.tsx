import { useState, useEffect } from 'react';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import Chip from '@mui/material/Chip';

import { api, PlaylistItem, Track } from '../api';

interface Props { authed: boolean; }

export default function Search({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [pid, setPid] = useState(0);
  const [lang, setLang] = useState('es');
  const [regions, setRegions] = useState('Mexico');
  const [isMexican, setIsMexican] = useState(true);
  const [isLatin, setIsLatin] = useState(true);
  const [useSemantic, setUseSemantic] = useState(true);
  const [energy, setEnergy] = useState(0.5);

  useEffect(() => {
    api.playlists().then((d) => setPlaylists(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const run = async () => {
    if (!authed) { alert('Connect to Spotify first.'); return; }
    setSearching(true);
    try {
      const body: any = {
        q, languages: lang ? [lang] : [],
        regions: regions ? regions.split(',').map((s) => s.trim()).filter(Boolean) : [],
        is_mexican: isMexican, is_latin_american: isLatin,
        min_energy: energy * 0.5, use_semantic: useSemantic, limit: 100,
      };
      if (pid) body.playlist_id = pid;
      const r = await api.search(body);
      setTracks(Array.isArray(r.tracks) ? r.tracks : []);
    } catch (e: any) {
      alert('Search failed: ' + (e.message || e));
    } finally {
      setSearching(false);
    }
  };

  const filterTracks = (t: Track) => {
    if (isMexican && !t.is_mexican) return false;
    if (isLatin && !t.is_latin_american) return false;
    if (t.energy && t.energy < energy * 0.5) return false;
    return true;
  };

  const shown = tracks.filter(filterTracks);

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Filter tracks</Typography>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <TextField select fullWidth size="small" label="Playlist" value={pid}
            onChange={(e) => setPid(Number(e.target.value))}
            InputProps={{ 'aria-label': 'playlist' }}>
            {playlists.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
          </TextField>
        </Grid>
        <Grid item xs={12}>
          <TextField fullWidth size="small" label="Free-text query (semantic)" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder="e.g. road-trip anthems" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField select size="small" label="Language" value={lang}
            onChange={(e) => setLang(e.target.value)} fullWidth>
            <MenuItem value="es">Spanish</MenuItem>
            <MenuItem value="en">English</MenuItem>
            <MenuItem value="pt">Portuguese</MenuItem>
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
        <Grid item xs={12}>
          <Box sx={{ px: 1 }}>
            <Typography gutterBottom>Min energy: {Math.round(energy * 100)}%</Typography>
            <Slider value={energy} onChange={(_, v) => setEnergy(v as number)} min={0} max={1} />
          </Box>
        </Grid>
        <Grid item xs={12}>
          <FormControlLabel control={<Checkbox checked={useSemantic} onChange={(e) => setUseSemantic(e.target.checked)} />}
            label="Use semantic (LLM) classification" />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" onClick={run} disabled={searching || !pid}>
            {searching ? 'Searching...' : 'Search & filter'}
          </Button>
        </Grid>
      </Grid>
      <Typography variant="h6" sx={{ mt: 3 }}>Results: {shown.length}</Typography>
      <Grid container spacing={2} sx={{ mt: 1 }}>
        {shown.map((t) => (
          <Grid item xs={12} sm={6} md={4} key={t.id}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" noWrap>{t.name}</Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {t.artists.map((a) => a.name).join(', ')}
                </Typography>
                <Typography variant="body2">{t.album_name}</Typography>
                <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  <Chip size="small" label={t.region} color="primary" />
                  {t.is_mexican ? <Chip size="small" label="Mexican" color="success" /> : null}
                  {t.is_latin_american ? <Chip size="small" label="Latin American" /> : null}
                  <Chip size="small" label={t.classification_strategy} variant="outlined" />
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
